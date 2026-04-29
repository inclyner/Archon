/**
 * Real-fs + real-git integration test for workspace-group worktree creation.
 *
 * Unlike workspace-group.test.ts (which mocks @archon/git's execFileAsync to
 * simulate git), this file spawns the actual git binary against real on-disk
 * temp repos. Catches OS-level quirks the unit tests can't see: path
 * separators on Windows, `.git` file vs directory worktree pointers, branch
 * naming with slashes, and so on.
 *
 * MUST run in its own `bun test` invocation (see packages/isolation/package.json
 * test script). The unit test in this same dir uses `mock.module('@archon/git')`
 * which is process-global; sharing a `bun test` invocation would block real
 * git calls here.
 *
 * Skips silently if `git` is not available on PATH (unusual but possible in
 * minimal containers).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// IMPORTANT: import directly, NOT through the package barrel — avoids any
// transitive @archon/paths mock pollution. We override the workspace-groups
// home via the env var-respected getArchonHome chain (ARCHON_HOME).
import {
  createGroupWorktree,
  removeGroupWorktree,
  GroupWorktreeError,
  type GroupWorktreeMember,
} from './workspace-group';
import { BranchCoherenceError } from '../workspace-group-branch';

// ─── Test fixture builders (real git) ────────────────────────────────────────

let TEST_HOME = '';
let cleanupPaths: string[] = [];

function safeRm(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignore
  }
}

function git(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    // Hard-pin user identity so commits don't pick up the host's git config
    // (CI sometimes runs without a configured user.email).
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Archon Test',
      GIT_AUTHOR_EMAIL: 'archon-test@example.invalid',
      GIT_COMMITTER_NAME: 'Archon Test',
      GIT_COMMITTER_EMAIL: 'archon-test@example.invalid',
    },
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isGitAvailable(): boolean {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Create a real git repo with one commit; return its absolute path. */
function makeRealRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `archon-real-git-src-${label}-`));
  cleanupPaths.push(dir);
  expect(git(dir, 'init', '--initial-branch=main').code).toBe(0);
  writeFileSync(join(dir, 'README.md'), `# ${label}\n`, 'utf8');
  expect(git(dir, 'add', 'README.md').code).toBe(0);
  expect(git(dir, 'commit', '-m', 'initial').code).toBe(0);
  return dir;
}

/** Build a non-git parent dir with `parent CLAUDE.md` for the file-copy test. */
function makeParentDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'archon-real-git-parent-'));
  cleanupPaths.push(parent);
  writeFileSync(join(parent, 'CLAUDE.md'), '# parent docs\n', 'utf8');
  writeFileSync(join(parent, '.editorconfig'), 'root=true\n', 'utf8');
  // A noisy directory we expect to be SKIPPED by the copy:
  mkdirSync(join(parent, 'node_modules'), { recursive: true });
  writeFileSync(join(parent, 'node_modules', 'huge.bin'), 'x'.repeat(1024), 'utf8');
  return parent;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const skipIfNoGit = isGitAvailable() ? describe : describe.skip;

skipIfNoGit('createGroupWorktree (real git)', () => {
  beforeAll(() => {
    // The provider uses getWorkspaceGroupWorktreePath(name, branch) which
    // composes from getArchonHome(). Setting ARCHON_HOME redirects all
    // workspace-group paths to a temp dir for this whole describe block.
    TEST_HOME = mkdtempSync(join(tmpdir(), 'archon-real-git-home-'));
    process.env.ARCHON_HOME = TEST_HOME;
  });

  beforeEach(() => {
    cleanupPaths = [];
  });

  afterEach(() => {
    for (const p of cleanupPaths) safeRm(p);
    if (TEST_HOME) safeRm(join(TEST_HOME, 'workspace-groups'));
  });

  it('materializes 2 real git worktrees and copies parent files (skipping node_modules)', async () => {
    const sourceA = makeRealRepo('a');
    const sourceB = makeRealRepo('b');
    const parent = makeParentDir();

    const members: GroupWorktreeMember[] = [
      { codebaseId: 'cb-a', sourceRepoPath: sourceA, relativePath: 'a' },
      { codebaseId: 'cb-b', sourceRepoPath: sourceB, relativePath: 'b' },
    ];

    const result = await createGroupWorktree({
      groupName: 'realgrouptest',
      parentPath: parent,
      members,
      branch: 'feat-real-git',
      baseBranch: 'main',
    });

    // 1. Group dir exists at the predicted location.
    expect(result.groupDir.includes('realgrouptest')).toBe(true);
    expect(result.groupDir.endsWith('feat-real-git')).toBe(true);
    expect(existsSync(result.groupDir)).toBe(true);

    // 2. Each member is a real git worktree on the new branch.
    for (const m of members) {
      const path = result.memberDirs[m.codebaseId]!;
      expect(existsSync(path)).toBe(true);
      // .git in a worktree is a FILE pointing at the source's .git/worktrees/<name>
      expect(existsSync(join(path, '.git'))).toBe(true);
      const branchOut = git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(branchOut.code).toBe(0);
      expect(branchOut.stdout.trim()).toBe('feat-real-git');
      // Sanity: the README from the initial commit is present.
      expect(existsSync(join(path, 'README.md'))).toBe(true);
    }

    // 3. Parent CLAUDE.md was copied; node_modules was skipped.
    expect(existsSync(join(result.groupDir, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(result.groupDir, 'CLAUDE.md'), 'utf8')).toContain('parent docs');
    expect(existsSync(join(result.groupDir, '.editorconfig'))).toBe(true);
    expect(existsSync(join(result.groupDir, 'node_modules'))).toBe(false);

    // 4. removeGroupWorktree cleans up — both the on-disk dir AND each source
    //    repo's .git/worktrees pointer.
    await removeGroupWorktree(
      'realgrouptest',
      'feat-real-git',
      members.map(m => ({ sourceRepoPath: m.sourceRepoPath, relativePath: m.relativePath })),
      { force: false }
    );
    expect(existsSync(result.groupDir)).toBe(false);
    // Source repos must NOT report a lingering worktree for this branch.
    for (const m of members) {
      const list = git(m.sourceRepoPath, 'worktree', 'list', '--porcelain');
      expect(list.code).toBe(0);
      expect(list.stdout).not.toContain('feat-real-git');
    }
  });

  it('rolls back partial state when one member fails to worktree-add', async () => {
    const sourceA = makeRealRepo('rollback-a');
    const parent = makeParentDir();

    // Member B's sourceRepoPath points at a NON-EXISTENT path so git worktree
    // add will fail. Member A's add should succeed first; then rollback
    // should remove A's worktree before re-throwing.
    const fakeBPath = join(tmpdir(), `archon-fake-${Date.now()}`);
    const members: GroupWorktreeMember[] = [
      { codebaseId: 'cb-a', sourceRepoPath: sourceA, relativePath: 'a' },
      { codebaseId: 'cb-b', sourceRepoPath: fakeBPath, relativePath: 'b' },
    ];

    let thrown: unknown;
    try {
      await createGroupWorktree({
        groupName: 'rollbacktest',
        parentPath: parent,
        members,
        branch: 'feat-rollback',
        baseBranch: 'main',
      });
    } catch (e) {
      thrown = e;
    }
    // Branch coherence (step 1) fails first when member B's source repo
    // doesn't exist → BranchCoherenceError. Worktree-level failures (steps
    // 2-3) come back as GroupWorktreeError. Either confirms rollback works.
    const isExpectedError =
      thrown instanceof GroupWorktreeError || thrown instanceof BranchCoherenceError;
    expect(isExpectedError).toBe(true);

    // The rolled-back group dir is gone.
    const groupDir = join(
      TEST_HOME,
      'workspace-groups',
      'rollbacktest',
      'worktrees',
      'feat-rollback'
    );
    expect(existsSync(groupDir)).toBe(false);

    // Source repo A has NO lingering worktree pointer for this branch.
    const list = git(sourceA, 'worktree', 'list', '--porcelain');
    expect(list.stdout).not.toContain('feat-rollback');

    // Source repo A also has NO leftover branch (rollback deleted it).
    const branches = git(sourceA, 'branch', '--list', 'feat-rollback');
    expect(branches.stdout.trim()).toBe('');
  });
});
