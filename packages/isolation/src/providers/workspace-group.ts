/**
 * Workspace-group worktree provider.
 *
 * Materializes a group worktree on disk:
 *
 *   ~/.archon/workspace-groups/<group>/worktrees/<branch>/
 *   ├── <non-git parent files: CLAUDE.md, READMEs, etc>   ← copied
 *   └── <member-relative-path>/                            ← `git worktree add`
 *
 * Each member subdirectory is a real git worktree of its source repo on the
 * shared branch name. Parent-level non-git files are file-copied (not
 * symlinked) so AI edits don't touch the user's source parent dir.
 */
import { existsSync } from 'fs';
import { mkdir, readdir, copyFile, lstat, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { execFileAsync } from '@archon/git';
import {
  getWorkspaceGroupsPath,
  getWorkspaceGroupWorktreesPath,
  getWorkspaceGroupWorktreePath,
  createLogger,
} from '@archon/paths';
import { ensureBranchAcrossMembers, type BranchCoherenceMember } from '../workspace-group-branch';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.workspace-group-provider');
  return cachedLog;
}

export interface GroupWorktreeMember {
  codebaseId: string;
  /** Source repo path on disk (where the user's working clone lives). */
  sourceRepoPath: string;
  /** Subdirectory name under the group dir (typically the original basename). */
  relativePath: string;
}

export interface GroupWorktreeRequest {
  groupName: string;
  /** Absolute path to the source parent directory (the non-git folder). */
  parentPath: string;
  members: readonly GroupWorktreeMember[];
  branch: string;
  baseBranch: string;
}

export interface GroupWorktreeResult {
  groupDir: string;
  /** codebaseId → absolute member worktree path */
  memberDirs: Record<string, string>;
}

export interface ListedGroupWorktree {
  groupName: string;
  /** Branch name as recorded in the dirname (slashes restored). */
  branch: string;
  path: string;
}

export class GroupWorktreeError extends Error {
  constructor(
    message: string,
    readonly cause?: Error
  ) {
    super(message);
    this.name = 'GroupWorktreeError';
  }
}

/**
 * Decode a branch name that was flattened for use as a directory segment.
 * Inverse of `getWorkspaceGroupWorktreePath`'s slash-replacement.
 */
function decodeBranchDirname(dirname: string): string {
  return dirname.replace(/__/g, '/');
}

/**
 * Recursively copy `src` directory contents into `dst`, skipping any entry
 * whose basename is in `skipNames`. Treats symlinks at the top level as
 * regular file copies of their *target* via copyFile (which follows symlinks);
 * deeper symlinks are walked-as-they-are and may be copied as files.
 *
 * Personal-use scope: not exhaustively portable. We don't try to preserve
 * permissions or special files; we just want CLAUDE.md and similar text
 * files copied into the group worktree.
 */
async function copyDirectoryShallow(
  src: string,
  dst: string,
  skipNames: ReadonlySet<string>
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);

    if (entry.isDirectory()) {
      await mkdir(dstPath, { recursive: true });
      await copyDirectoryShallow(srcPath, dstPath, skipNames);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // copyFile follows symlinks, copying the contents the link points at.
      // For our use case (user-authored docs, configs) this is the safer default.
      await copyFile(srcPath, dstPath);
    }
    // Other types (sockets, devices, FIFOs) are skipped silently.
  }
}

/**
 * `git worktree remove` for one path. Best-effort; never throws.
 */
async function removeWorktreeBestEffort(
  sourceRepoPath: string,
  worktreePath: string,
  context: { reason: string }
): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', sourceRepoPath, 'worktree', 'remove', '--force', worktreePath],
      { timeout: 30000 }
    );
  } catch (err) {
    getLog().warn(
      { sourceRepoPath, worktreePath, err, ...context },
      'workspace_group.worktree_remove_failed'
    );
  }
}

/**
 * Create the group worktree on disk.
 *
 * Order:
 *  1. Compute groupDir and ensure it does not already exist (refuse to clobber).
 *  2. Branch coherence: create the branch in every source repo where missing.
 *  3. For each member: `git worktree add <groupDir>/<relativePath> <branch>`.
 *  4. Copy the parent's non-git files into groupDir.
 *  5. On any step failure: tear down anything we created, re-throw.
 */
export async function createGroupWorktree(req: GroupWorktreeRequest): Promise<GroupWorktreeResult> {
  const groupDir = getWorkspaceGroupWorktreePath(req.groupName, req.branch);

  if (existsSync(groupDir)) {
    throw new GroupWorktreeError(
      `Group worktree already exists at ${groupDir}. Run \`archon group cleanup ${req.groupName} --branch ${req.branch}\` first.`
    );
  }

  // Step 1: branch coherence across members.
  const branchInput: BranchCoherenceMember[] = req.members.map(m => ({
    codebaseId: m.codebaseId,
    sourceRepoPath: m.sourceRepoPath,
  }));
  const branchResult = await ensureBranchAcrossMembers(branchInput, req.branch, req.baseBranch);

  // Track what we create so we can roll back.
  const createdMemberWorktrees: { sourceRepoPath: string; worktreePath: string }[] = [];
  let createdGroupDir = false;

  try {
    await mkdir(groupDir, { recursive: true });
    createdGroupDir = true;

    // Step 2: per-member `git worktree add`.
    for (const member of req.members) {
      const memberDir = join(groupDir, member.relativePath);
      await mkdir(dirname(memberDir), { recursive: true });
      await execFileAsync(
        'git',
        ['-C', member.sourceRepoPath, 'worktree', 'add', memberDir, req.branch],
        { timeout: 60000 }
      );
      createdMemberWorktrees.push({
        sourceRepoPath: member.sourceRepoPath,
        worktreePath: memberDir,
      });
    }

    // Step 3: copy parent's non-git files. Skip member subdirs and `.git`.
    const skipNames = new Set<string>(['.git', ...req.members.map(m => m.relativePath)]);
    await copyDirectoryShallow(req.parentPath, groupDir, skipNames);

    const memberDirs: Record<string, string> = {};
    for (const member of req.members) {
      memberDirs[member.codebaseId] = join(groupDir, member.relativePath);
    }
    return { groupDir, memberDirs };
  } catch (err) {
    const error = err as Error;
    getLog().error(
      { groupName: req.groupName, branch: req.branch, err: error },
      'workspace_group.create_failed'
    );

    // Roll back member worktrees we already created.
    for (const wt of createdMemberWorktrees) {
      await removeWorktreeBestEffort(wt.sourceRepoPath, wt.worktreePath, {
        reason: 'group-create-rollback',
      });
    }
    // Roll back any branches we created in step 1.
    for (const m of branchResult.created) {
      try {
        await execFileAsync('git', ['-C', m.sourceRepoPath, 'branch', '-D', req.branch], {
          timeout: 10000,
        });
      } catch (e) {
        getLog().warn(
          { sourceRepoPath: m.sourceRepoPath, branch: req.branch, err: e },
          'workspace_group.branch_rollback_failed'
        );
      }
    }
    // Remove the partial group dir from disk.
    if (createdGroupDir) {
      try {
        await rm(groupDir, { recursive: true, force: true });
      } catch (e) {
        getLog().warn({ groupDir, err: e }, 'workspace_group.partial_dir_cleanup_failed');
      }
    }

    throw new GroupWorktreeError(
      `Failed to create group worktree for "${req.groupName}" on branch "${req.branch}": ${error.message}`,
      error
    );
  }
}

/**
 * Remove the group worktree for (group, branch).
 *
 * Walks the on-disk group dir, calls `git worktree remove --force` on each
 * member subdir against its source repo (resolved via the member's
 * `.git` link), then `rm -rf` on the group dir. Tolerates missing entries.
 *
 * Note: this signature requires the caller to provide the member source-repo
 * paths, since the on-disk group dir alone doesn't tell us which source repo
 * each worktree belongs to without parsing each member's `.git` file. The
 * CLI/cleanup layer has the DB and can supply them. If you call this without
 * member info we fall back to `rm -rf` only — which leaves dangling worktree
 * pointers in the source repo's `.git/worktrees/`.
 */
export async function removeGroupWorktree(
  groupName: string,
  branch: string,
  members?: readonly { sourceRepoPath: string; relativePath: string }[]
): Promise<void> {
  const groupDir = getWorkspaceGroupWorktreePath(groupName, branch);

  if (!existsSync(groupDir)) {
    getLog().debug({ groupDir }, 'workspace_group.remove_no_dir');
    return;
  }

  if (members) {
    for (const m of members) {
      const memberDir = join(groupDir, m.relativePath);
      if (existsSync(memberDir)) {
        await removeWorktreeBestEffort(m.sourceRepoPath, memberDir, {
          reason: 'group-cleanup',
        });
      }
    }
  }

  try {
    await rm(groupDir, { recursive: true, force: true });
  } catch (err) {
    getLog().warn({ groupDir, err }, 'workspace_group.dir_remove_failed');
  }
}

/**
 * List on-disk group worktrees by walking ~/.archon/workspace-groups/.
 *
 * Returns an entry per (group, branch) directory. Does NOT cross-reference
 * the DB — purely filesystem-driven. Useful for cleanup tooling that wants
 * to find ghost dirs (group worktree on disk but no DB row).
 */
export async function listGroupWorktrees(): Promise<ListedGroupWorktree[]> {
  const root = getWorkspaceGroupsPath();
  if (!existsSync(root)) return [];

  const result: ListedGroupWorktree[] = [];
  const groupEntries = await readdir(root, { withFileTypes: true });
  for (const groupEntry of groupEntries) {
    if (!groupEntry.isDirectory()) continue;

    const worktreesDir = getWorkspaceGroupWorktreesPath(groupEntry.name);
    if (!existsSync(worktreesDir)) continue;

    const branchEntries = await readdir(worktreesDir, { withFileTypes: true });
    for (const branchEntry of branchEntries) {
      if (!branchEntry.isDirectory()) continue;
      const path = join(worktreesDir, branchEntry.name);
      // Skip if not a real directory (broken symlink etc).
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      result.push({
        groupName: groupEntry.name,
        branch: decodeBranchDirname(branchEntry.name),
        path,
      });
    }
  }
  return result;
}

// Re-export for tests that want to assert on the helper directly.
export { copyDirectoryShallow };
