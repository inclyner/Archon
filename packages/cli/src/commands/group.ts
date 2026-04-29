/**
 * Workspace group commands — register/list/show/remove.
 *
 * A workspace group is a non-git parent directory containing N sibling git
 * repositories (codebases). `archon group register` walks the parent one
 * level deep, registers each git child via the existing registerRepository
 * helper, and stores the group + member junction.
 */
import { existsSync, statSync, readdirSync } from 'fs';
import { stat as fsStat } from 'fs/promises';
import { resolve, basename, join } from 'path';
import {
  workspaceGroupDb,
  registerRepository,
  codebaseDb,
  pool,
  type RegisterResult,
} from '@archon/core';
import type { WorkspaceGroupMember } from '@archon/core';
import { listGroupWorktrees, removeGroupWorktree } from '@archon/isolation';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.group');
  return cachedLog;
}

interface RegisterOutcome {
  relativePath: string;
  result?: RegisterResult;
  error?: string;
}

/**
 * Walk `parentPath` one level deep and return basenames of subdirs that look
 * like git repos (have a `.git` entry — file or directory; covers worktrees).
 */
function discoverGitChildren(parentPath: string): string[] {
  const entries = readdirSync(parentPath, { withFileTypes: true });
  const children: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const gitEntry = join(parentPath, entry.name, '.git');
    if (existsSync(gitEntry)) {
      children.push(entry.name);
    }
  }
  children.sort();
  return children;
}

/**
 * `archon group register <parent-path> [--name <name>]`
 */
export async function groupRegisterCommand(
  parentPathArg: string,
  options: { name?: string } = {}
): Promise<number> {
  const parentPath = resolve(parentPathArg);

  if (!existsSync(parentPath)) {
    console.error(`Error: parent path does not exist: ${parentPath}`);
    return 1;
  }
  if (!statSync(parentPath).isDirectory()) {
    console.error(`Error: parent path is not a directory: ${parentPath}`);
    return 1;
  }

  const groupName = options.name ?? basename(parentPath);

  const existing = await workspaceGroupDb.getGroupByName(groupName);
  if (existing) {
    console.error(
      `Error: group "${groupName}" already exists at ${existing.parent_path}.\n` +
        '  Use --name to disambiguate, or `archon group remove` first.'
    );
    return 1;
  }

  const children = discoverGitChildren(parentPath);
  if (children.length === 0) {
    console.error(`Error: no git repositories found one level under ${parentPath}.`);
    return 1;
  }

  const outcomes: RegisterOutcome[] = [];
  for (const child of children) {
    const childPath = join(parentPath, child);
    try {
      const result = await registerRepository(childPath);
      outcomes.push({ relativePath: child, result });
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, childPath }, 'group.register.member_register_failed');
      outcomes.push({ relativePath: child, error: err.message });
    }
  }

  const successes = outcomes.filter(o => o.result);
  if (successes.length === 0) {
    console.error(`Error: failed to register any child repos under ${parentPath}.`);
    for (const o of outcomes) {
      console.error(`  ✗ ${o.relativePath} — ${o.error ?? 'unknown error'}`);
    }
    return 1;
  }

  // Atomically create the group + member rows. If anything inside the loop
  // throws (e.g. the user kills the process, or a constraint trips), the
  // transaction rolls back so we never leave a half-registered group.
  // Note: registerRepository earlier in this function is intentionally NOT
  // inside the transaction — those codebase rows are independent values that
  // we want to keep even if group creation fails.
  await pool.withTransaction(async query => {
    const created = await workspaceGroupDb.createGroup(
      { name: groupName, parent_path: parentPath },
      query
    );
    for (const outcome of successes) {
      if (!outcome.result) continue;
      await workspaceGroupDb.addMember(
        {
          group_id: created.id,
          codebase_id: outcome.result.codebaseId,
          relative_path: outcome.relativePath,
        },
        query
      );
    }
    return created;
  });

  console.log(`Group "${groupName}" registered at ${parentPath}`);
  for (const outcome of outcomes) {
    if (outcome.result) {
      const tag = outcome.result.alreadyExisted ? ' (already registered, linked)' : '';
      console.log(`  ✓ ${outcome.relativePath}${tag}`);
      console.log(`      → codebase ${outcome.result.codebaseId} (${outcome.result.name})`);
    } else {
      console.log(`  ✗ ${outcome.relativePath} — ${outcome.error ?? 'unknown error'}`);
    }
  }
  return 0;
}

/**
 * `archon group list [--json]`
 */
export async function groupListCommand(jsonOutput?: boolean): Promise<number> {
  const groups = await workspaceGroupDb.listGroups();

  if (jsonOutput) {
    console.log(JSON.stringify(groups, null, 2));
    return 0;
  }

  if (groups.length === 0) {
    console.log('No workspace groups registered.');
    console.log('Use `archon group register <parent-path>` to create one.');
    return 0;
  }

  console.log(`${groups.length} workspace group(s):\n`);
  for (const group of groups) {
    console.log(`  ${group.name}`);
    console.log(`    parent: ${group.parent_path}`);
  }
  return 0;
}

/**
 * `archon group show <name> [--json]`
 */
export async function groupShowCommand(name: string, jsonOutput?: boolean): Promise<number> {
  const group = await workspaceGroupDb.getGroupByName(name);
  if (!group) {
    console.error(`Error: no group named "${name}".`);
    return 1;
  }

  const members = await workspaceGroupDb.getMembersForGroup(group.id);

  if (jsonOutput) {
    console.log(JSON.stringify({ group, members }, null, 2));
    return 0;
  }

  console.log(`Group: ${group.name}`);
  console.log(`Parent: ${group.parent_path}`);
  console.log(`Members (${members.length}):`);
  for (const m of members as WorkspaceGroupMember[]) {
    console.log(`  ${m.relative_path}  → codebase ${m.codebase_id}`);
  }
  return 0;
}

/**
 * `archon group remove <name>` — drops group + member junction; codebases preserved.
 */
export async function groupRemoveCommand(name: string): Promise<number> {
  const group = await workspaceGroupDb.getGroupByName(name);
  if (!group) {
    console.error(`Error: no group named "${name}".`);
    return 1;
  }

  await workspaceGroupDb.removeGroup(group.id);
  console.log(`Group "${name}" removed (member codebases preserved).`);
  return 0;
}

/**
 * Resolve the source-repo paths and relative paths for a group's members,
 * suitable for handing to removeGroupWorktree (which calls
 * `git worktree remove` per member). Returns null if any member's codebase
 * row is missing — the caller should fall back to plain rm.
 */
async function resolveGroupMembersForRemoval(
  groupId: string
): Promise<{ sourceRepoPath: string; relativePath: string }[] | null> {
  const memberRows = await workspaceGroupDb.getMembersForGroup(groupId);
  const out: { sourceRepoPath: string; relativePath: string }[] = [];
  for (const m of memberRows) {
    const cb = await codebaseDb.getCodebase(m.codebase_id);
    if (!cb) {
      return null;
    }
    out.push({ sourceRepoPath: cb.default_cwd, relativePath: m.relative_path });
  }
  return out;
}

interface CleanupSelection {
  branch: string;
  path: string;
  ageDays: number;
}

/**
 * `archon group cleanup <name> [--branch X | --all] [--days N] [--force]`
 *
 * Selection (mutually exclusive):
 *   --branch <name> : that one branch's worktree
 *   --all           : every worktree for this group
 *   (default)       : worktrees with mtime older than --days (default 7)
 */
export async function groupCleanupCommand(
  name: string,
  options: {
    branch?: string;
    all?: boolean;
    days?: number;
    force?: boolean;
    discardUncommitted?: boolean;
  } = {}
): Promise<number> {
  const group = await workspaceGroupDb.getGroupByName(name);
  if (!group) {
    console.error(`Error: no group named "${name}".`);
    return 1;
  }

  if (options.branch && options.all) {
    console.error('Error: --branch and --all are mutually exclusive.');
    return 1;
  }

  const allWorktrees = await listGroupWorktrees();
  const groupWorktrees = allWorktrees.filter(w => w.groupName === name);

  if (groupWorktrees.length === 0) {
    console.log(`No worktrees on disk for group "${name}".`);
    return 0;
  }

  // Compute age from mtime — best-effort; on stat failure treat as 0d.
  const now = Date.now();
  const enriched: CleanupSelection[] = [];
  for (const wt of groupWorktrees) {
    let ageDays = 0;
    try {
      const stats = await fsStat(wt.path);
      ageDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    } catch (err) {
      getLog().warn({ err: err as Error, path: wt.path }, 'group.cleanup.stat_failed');
    }
    enriched.push({ branch: wt.branch, path: wt.path, ageDays });
  }

  let selected: CleanupSelection[];
  if (options.branch) {
    selected = enriched.filter(w => w.branch === options.branch);
    if (selected.length === 0) {
      console.error(
        `Error: no worktree for group "${name}" on branch "${options.branch}".\n` +
          `Available branches: ${enriched.map(w => w.branch).join(', ') || '(none)'}`
      );
      return 1;
    }
  } else if (options.all) {
    selected = enriched;
  } else {
    const threshold = options.days ?? 7;
    selected = enriched.filter(w => w.ageDays >= threshold);
    if (selected.length === 0) {
      console.log(
        `No worktrees older than ${threshold} day(s) for group "${name}".\n` +
          'Use --branch <name> or --all to override.'
      );
      return 0;
    }
  }

  console.log(`Will remove ${selected.length} worktree(s) for group "${name}":`);
  for (const w of selected) {
    console.log(`  ${w.branch}  (age ${w.ageDays.toFixed(1)}d)  ${w.path}`);
  }

  if (!options.force) {
    console.log('\nPass --force to actually remove. Aborting (no changes made).');
    return 0;
  }

  // Resolve members once; if any codebase is missing, fall back to plain rm.
  const memberPaths = await resolveGroupMembersForRemoval(group.id);
  if (!memberPaths) {
    console.warn(
      'Warning: one or more member codebases are missing — git worktree pointers in the source repos may be left dangling.'
    );
  }

  let removed = 0;
  let failed = 0;
  for (const w of selected) {
    try {
      await removeGroupWorktree(name, w.branch, memberPaths ?? undefined, {
        force: options.discardUncommitted ?? false,
      });
      console.log(`  ✓ removed ${w.branch}`);
      removed++;
    } catch (err) {
      const e = err as Error;
      getLog().warn({ err: e, branch: w.branch }, 'group.cleanup.remove_failed');
      console.error(`  ✗ ${w.branch} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\nCleanup complete: ${removed} removed, ${failed} failed.`);
  return failed === 0 ? 0 : 1;
}
