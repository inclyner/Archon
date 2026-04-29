/**
 * `archon group push` — push each member worktree's branch to its own remote
 * and (optionally) open a PR per child against that child's repo.
 *
 * Important: every PR is created **from the child's git worktree** (we pass
 * `cwd: <worktree>` to `gh pr create`) — never from the group's parent dir.
 * `gh` resolves the target repo via that worktree's `origin` remote, so each
 * PR lands in its own repo. There is no "group PR." Cross-linking happens
 * via PR body text: each PR's body lists the sibling PR URLs so a reviewer
 * can navigate the set.
 *
 * Two-phase PR creation:
 *   1. Push each member, then `gh pr create` per member; collect URLs.
 *   2. `gh pr edit --body` each PR to inject the list of sibling URLs.
 *
 * Push is the gate: if any member push fails, we skip the PR phase entirely
 * and surface what was pushed so the user can finish manually.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import { getWorkspaceGroupWorktreePath, createLogger } from '@archon/paths';
import { workspaceGroupDb, codebaseDb } from '@archon/core';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.group-push');
  return cachedLog;
}

export interface PushGroupOptions {
  /** Open a PR per child after pushing. Default: false. */
  openPrs?: boolean;
  /** Print the planned actions without executing them. */
  dryRun?: boolean;
}

interface MemberPath {
  relativePath: string;
  sourceRepoPath: string;
  /** Absolute path to the member's worktree under the group dir. */
  worktreePath: string;
}

export interface PushedMember {
  relativePath: string;
  worktreePath: string;
}

export interface OpenedPr {
  relativePath: string;
  url: string;
  number: number;
}

export interface PushGroupError {
  relativePath: string;
  phase: 'push' | 'pr-create' | 'pr-edit';
  message: string;
}

export interface PushGroupResult {
  groupName: string;
  branch: string;
  pushed: PushedMember[];
  prs: OpenedPr[];
  errors: PushGroupError[];
}

/**
 * Resolve member info needed for push: relative_path (for display + dir lookup)
 * and source repo path (for sanity, even though pushes happen from the worktree).
 */
async function resolveMembers(groupId: string, groupDir: string): Promise<MemberPath[]> {
  const memberRows = await workspaceGroupDb.getMembersForGroup(groupId);
  const out: MemberPath[] = [];
  for (const m of memberRows) {
    const cb = await codebaseDb.getCodebase(m.codebase_id);
    if (!cb) {
      throw new Error(
        `Group member references missing codebase ${m.codebase_id} (relative_path="${m.relative_path}").`
      );
    }
    out.push({
      relativePath: m.relative_path,
      sourceRepoPath: cb.default_cwd,
      worktreePath: join(groupDir, m.relative_path),
    });
  }
  return out;
}

/**
 * Parse `gh pr create --json url,number` stdout. Returns `null` if the JSON
 * shape is wrong (the caller should treat that as a hard error since the gh
 * version may be too old to support `--json` on `pr create`).
 *
 * Why this over regex-on-stdout: gh sometimes prints leading messages
 * ("A pull request for branch X already exists at https://.../pull/5; created
 * https://.../pull/6") and the first URL match was the wrong PR. JSON output
 * is unambiguous.
 */
function parsePrJson(stdout: string): { url: string; number: number } | null {
  try {
    const data = JSON.parse(stdout) as { url?: unknown; number?: unknown };
    if (typeof data.url === 'string' && typeof data.number === 'number') {
      return { url: data.url, number: data.number };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a default PR body referencing the workspace group and branch.
 * Sibling URLs are appended in pass 2 once all PRs exist.
 */
function buildBaseBody(groupName: string, branch: string, relativePath: string): string {
  return [
    `This PR was opened **from the \`${relativePath}\` repo** as part of a coordinated cross-repo change.`,
    '',
    `Workspace group: **${groupName}** · Branch: \`${branch}\`.`,
    '',
    'Each repo in the group has its own PR. There is no shared "group PR" — review and merge this PR like any other PR in this repo. Sibling PRs (if any) are listed below for context.',
    '',
    '_Created by `archon group push --pr`._',
  ].join('\n');
}

function appendSiblingsToBody(baseBody: string, selfRelativePath: string, prs: OpenedPr[]): string {
  const siblings = prs.filter(p => p.relativePath !== selfRelativePath);
  if (siblings.length === 0) return baseBody;

  const lines = [
    baseBody,
    '',
    '---',
    '',
    'Sibling PRs in this group:',
    ...siblings.map(p => `- **${p.relativePath}**: ${p.url}`),
  ];
  return lines.join('\n');
}

export async function pushGroupWorktree(
  groupName: string,
  branch: string,
  options: PushGroupOptions = {}
): Promise<PushGroupResult> {
  const result: PushGroupResult = {
    groupName,
    branch,
    pushed: [],
    prs: [],
    errors: [],
  };

  const group = await workspaceGroupDb.getGroupByName(groupName);
  if (!group) {
    throw new Error(`No workspace group named "${groupName}".`);
  }

  const groupDir = getWorkspaceGroupWorktreePath(groupName, branch);
  if (!existsSync(groupDir)) {
    throw new Error(
      `No group worktree on disk for "${groupName}" on branch "${branch}". Expected at ${groupDir}. Did the workflow run produce one?`
    );
  }

  const members = await resolveMembers(group.id, groupDir);
  if (members.length === 0) {
    throw new Error(`Group "${groupName}" has no members.`);
  }

  if (options.dryRun) {
    console.log(
      `Would push ${members.length} branch(es), one per repo${options.openPrs ? ', and open one PR per repo:' : ':'}`
    );
    for (const m of members) {
      console.log(`  [${m.relativePath}] git push -u origin ${branch}`);
      console.log(`           (cwd: ${m.worktreePath})`);
      if (options.openPrs) {
        console.log(
          `           then: gh pr create --head ${branch} (against ${m.relativePath}'s remote)`
        );
      }
    }
    return result;
  }

  // Phase 1: push each member's branch.
  for (const m of members) {
    if (!existsSync(m.worktreePath)) {
      result.errors.push({
        relativePath: m.relativePath,
        phase: 'push',
        message: `Member worktree missing at ${m.worktreePath}`,
      });
      continue;
    }

    try {
      await execFileAsync('git', ['-C', m.worktreePath, 'push', '-u', 'origin', branch], {
        timeout: 60000,
      });
      result.pushed.push({ relativePath: m.relativePath, worktreePath: m.worktreePath });
      console.log(`  ✓ pushed ${m.relativePath} (from ${m.worktreePath})`);
    } catch (err) {
      const e = err as Error & { stderr?: string };
      const message = (e.stderr || e.message).split('\n')[0] ?? 'push failed';
      result.errors.push({ relativePath: m.relativePath, phase: 'push', message });
      console.error(`  ✗ push failed for ${m.relativePath}: ${message}`);
      getLog().warn({ err, member: m.relativePath, branch }, 'group_push.push_failed');
    }
  }

  // Push is the gate. If any push failed, surface and stop.
  if (result.errors.length > 0) {
    console.error(
      `\nPush failed for ${result.errors.length} member(s); skipping PR creation. Resolve and re-run.`
    );
    return result;
  }

  if (!options.openPrs) {
    return result;
  }

  // Pre-flight: confirm `gh` is installed and authenticated. Failing here is
  // friendlier than failing inside the per-member pr-create loop, where each
  // failure clutters output and leaves PRs partially opened.
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10000 });
  } catch (err) {
    const e = err as Error & { code?: string; stderr?: string };
    const isMissing = e.code === 'ENOENT' || e.message.includes('command not found');
    const detail = isMissing
      ? 'gh CLI is not installed or not on PATH.'
      : (e.stderr ?? e.message).split('\n').slice(0, 2).join(' ');
    console.error(
      `\nSkipping PR creation: ${detail}\n` +
        '  Install gh from https://cli.github.com and run `gh auth login`, then try again.'
    );
    result.errors.push({
      relativePath: '*',
      phase: 'pr-create',
      message: `gh pre-flight failed: ${detail}`,
    });
    return result;
  }

  // Phase 2: open a PR per pushed member.
  for (const pushed of result.pushed) {
    // Pick a title from the most recent commit subject on the worktree's HEAD.
    let title = `[${groupName}] ${pushed.relativePath}: ${branch}`;
    try {
      const subject = await execFileAsync(
        'git',
        ['-C', pushed.worktreePath, 'log', '-1', '--format=%s'],
        { timeout: 10000 }
      );
      const trimmed = subject.stdout.trim();
      if (trimmed) {
        title = `[${groupName}/${pushed.relativePath}] ${trimmed}`;
      }
    } catch (err) {
      getLog().debug({ err, member: pushed.relativePath }, 'group_push.title_fallback_to_default');
    }

    const baseBody = buildBaseBody(groupName, branch, pushed.relativePath);
    try {
      const out = await execFileAsync(
        'gh',
        [
          'pr',
          'create',
          '--head',
          branch,
          '--title',
          title,
          '--body',
          baseBody,
          // Note: gh's `pr create` doesn't support --json directly. We open the
          // PR plainly, then fetch its number/url with `gh pr view --json`.
        ],
        { timeout: 30000, cwd: pushed.worktreePath }
      );
      // gh pr create stdout: free-form text that ends with the URL. We re-query
      // the PR by branch to get a canonical { url, number } pair, immune to gh
      // printing extra messages above the URL.
      void out;
      const view = await execFileAsync('gh', ['pr', 'view', branch, '--json', 'url,number'], {
        timeout: 15000,
        cwd: pushed.worktreePath,
      });
      const parsed = parsePrJson(view.stdout);
      if (!parsed) {
        result.errors.push({
          relativePath: pushed.relativePath,
          phase: 'pr-create',
          message: `gh pr view returned unexpected JSON shape: ${view.stdout.slice(0, 120)}`,
        });
        console.error(`  ✗ pr lookup failed for ${pushed.relativePath}`);
        continue;
      }
      result.prs.push({
        relativePath: pushed.relativePath,
        url: parsed.url,
        number: parsed.number,
      });
      console.log(`  ✓ opened PR in ${pushed.relativePath} repo: ${parsed.url}`);
    } catch (err) {
      const e = err as Error & { stderr?: string };
      const message =
        (e.stderr || e.message).split('\n').slice(0, 2).join(' | ') || 'pr-create failed';
      result.errors.push({ relativePath: pushed.relativePath, phase: 'pr-create', message });
      console.error(`  ✗ pr-create failed for ${pushed.relativePath}: ${message}`);
      getLog().warn({ err, member: pushed.relativePath }, 'group_push.pr_create_failed');
    }
  }

  // Phase 3: cross-link sibling PRs.
  if (result.prs.length > 1) {
    console.log('\nCross-linking sibling PRs...');
    for (const pr of result.prs) {
      const member = members.find(m => m.relativePath === pr.relativePath);
      if (!member) continue;
      const newBody = appendSiblingsToBody(
        buildBaseBody(groupName, branch, pr.relativePath),
        pr.relativePath,
        result.prs
      );
      try {
        await execFileAsync('gh', ['pr', 'edit', String(pr.number), '--body', newBody], {
          timeout: 30000,
          cwd: member.worktreePath,
        });
        console.log(`  ✓ updated PR body for ${pr.relativePath}`);
      } catch (err) {
        const e = err as Error & { stderr?: string };
        const message = (e.stderr || e.message).split('\n')[0] ?? 'pr-edit failed';
        result.errors.push({ relativePath: pr.relativePath, phase: 'pr-edit', message });
        console.warn(`  ✗ pr-edit failed for ${pr.relativePath}: ${message}`);
        getLog().warn({ err, member: pr.relativePath }, 'group_push.pr_edit_failed');
      }
    }
  }

  return result;
}

/**
 * `archon group push <name> --branch <branch> [--pr] [--dry-run]`
 */
export async function groupPushCommand(
  groupName: string,
  options: { branch?: string; pr?: boolean; dryRun?: boolean }
): Promise<number> {
  if (!options.branch) {
    console.error('Usage: archon group push <name> --branch <branch> [--pr] [--dry-run]');
    return 1;
  }

  console.log(`Pushing group "${groupName}" on branch "${options.branch}"...`);
  let result: PushGroupResult;
  try {
    result = await pushGroupWorktree(groupName, options.branch, {
      openPrs: options.pr,
      dryRun: options.dryRun,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  if (options.dryRun) {
    return 0;
  }

  console.log('');
  console.log(`Pushed: ${result.pushed.length}`);
  if (result.prs.length > 0) {
    console.log(`PRs opened: ${result.prs.length}`);
    for (const pr of result.prs) {
      console.log(`  ${pr.relativePath} → ${pr.url}`);
    }
  }
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.length}`);
    for (const e of result.errors) {
      console.log(`  ${e.relativePath} (${e.phase}): ${e.message}`);
    }
    return 1;
  }
  return 0;
}
