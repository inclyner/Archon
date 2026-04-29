/**
 * Tests for the workspace-group worktree provider.
 *
 * Strategy:
 *   - Real filesystem (temp dirs) — exercises the actual copy + dir tree code.
 *   - Mocked @archon/git execFileAsync — git commands are simulated, including
 *     failure injection for rollback tests.
 *   - Mocked @archon/paths — redirects getWorkspaceGroupsPath() to a temp dir
 *     so we don't touch the real ~/.archon.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let TEST_HOME = '';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getWorkspaceGroupsPath: () => join(TEST_HOME, 'workspace-groups'),
  getWorkspaceGroupWorktreesPath: (groupName: string) =>
    join(TEST_HOME, 'workspace-groups', groupName, 'worktrees'),
  getWorkspaceGroupWorktreePath: (groupName: string, branch: string) =>
    join(TEST_HOME, 'workspace-groups', groupName, 'worktrees', branch.replace(/\//g, '__')),
}));

interface ExecCall {
  cmd: string;
  args: string[];
}

const execCalls: ExecCall[] = [];

/**
 * Configurable mock for execFileAsync.
 *
 * Default behavior:
 *  - `git ... show-ref ... refs/heads/<branch>` → throws (branch missing)
 *  - `git ... worktree add <path> <branch>` → creates the directory and a
 *    fake `.git` file inside (so existsSync checks pass), returns success.
 *  - `git ... worktree remove --force <path>` → rms the directory, returns
 *    success.
 *  - `git ... branch ...` (create or delete) → success.
 *
 * Tests can override per-call via `nextResults`.
 */
type MockResult = { ok: true; stdout?: string } | { ok: false; err: Error };
const nextResults: MockResult[] = [];

const mockExecFileAsync = mock(async (cmd: string, args: string[]) => {
  execCalls.push({ cmd, args });

  const next = nextResults.shift();
  if (next) {
    if (next.ok) return { stdout: next.stdout ?? '', stderr: '' };
    throw next.err;
  }

  // Default behaviors for git plumbing:
  if (args.includes('show-ref')) {
    throw new Error('fatal: bad ref refs/heads/<branch>');
  }
  if (args.includes('worktree') && args.includes('add')) {
    // git worktree add <path> <branch> — args end with [..., 'add', <path>, <branch>]
    const addIdx = args.indexOf('add');
    const path = args[addIdx + 1];
    if (path) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, '.git'), 'gitdir: /fake', 'utf8');
    }
    return { stdout: '', stderr: '' };
  }
  if (args.includes('worktree') && args.includes('remove')) {
    const removeIdx = args.indexOf('remove');
    // Skip flags like --force; find the first non-flag positional after 'remove'
    let path: string | undefined;
    for (let i = removeIdx + 1; i < args.length; i++) {
      const a = args[i];
      if (!a) continue;
      if (a.startsWith('-')) continue;
      path = a;
      break;
    }
    if (path && existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
    return { stdout: '', stderr: '' };
  }
  return { stdout: '', stderr: '' };
});

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

import {
  createGroupWorktree,
  removeGroupWorktree,
  listGroupWorktrees,
  GroupWorktreeError,
  copyDirectoryShallow,
  type GroupWorktreeMember,
} from './workspace-group';

// --- helpers -----------------------------------------------------------------

function makeParentWithMembers(memberRelPaths: string[]): {
  parentPath: string;
  members: GroupWorktreeMember[];
} {
  const parent = mkdtempSync(join(tmpdir(), 'archon-group-parent-'));
  // Parent CLAUDE.md and a non-member subdir.
  writeFileSync(join(parent, 'CLAUDE.md'), '# Parent docs\n', 'utf8');
  writeFileSync(join(parent, '.gitignore'), 'node_modules\n', 'utf8');
  mkdirSync(join(parent, 'shared-notes'), { recursive: true });
  writeFileSync(join(parent, 'shared-notes', 'roadmap.md'), '# Roadmap\n', 'utf8');

  const members: GroupWorktreeMember[] = memberRelPaths.map((rel, i) => {
    // Each "source repo" lives outside the parent in our test harness.
    const sourceRepoPath = mkdtempSync(join(tmpdir(), `archon-group-src-${i}-`));
    // Stub a `.git` so the source path looks like a repo to anything that checks.
    writeFileSync(join(sourceRepoPath, '.git'), 'gitdir: /fake', 'utf8');
    // Also make a directory at parent/rel so the "source parent" resembles the
    // real-world layout where the user has the 4 repos right inside the parent.
    mkdirSync(join(parent, rel), { recursive: true });
    writeFileSync(join(parent, rel, '.git'), 'gitdir: /fake', 'utf8');
    writeFileSync(join(parent, rel, 'README.md'), `# ${rel}\n`, 'utf8');
    return {
      codebaseId: `cb-${rel}`,
      sourceRepoPath,
      relativePath: rel,
    };
  });

  return { parentPath: parent, members };
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// --- tests -------------------------------------------------------------------

describe('createGroupWorktree', () => {
  let parentPath = '';
  let members: GroupWorktreeMember[] = [];

  beforeEach(() => {
    TEST_HOME = mkdtempSync(join(tmpdir(), 'archon-group-home-'));
    execCalls.length = 0;
    nextResults.length = 0;
    mockExecFileAsync.mockClear();
    const setup = makeParentWithMembers(['svc-api', 'svc-web']);
    parentPath = setup.parentPath;
    members = setup.members;
  });

  afterEach(() => {
    safeRm(parentPath);
    for (const m of members) safeRm(m.sourceRepoPath);
    safeRm(TEST_HOME);
  });

  it('creates the group dir, member worktrees, and copies parent files', async () => {
    const result = await createGroupWorktree({
      groupName: 'platform',
      parentPath,
      members,
      branch: 'feat/x',
      baseBranch: 'main',
    });

    expect(existsSync(result.groupDir)).toBe(true);
    expect(result.groupDir).toContain('platform');
    expect(result.groupDir).toContain('feat__x');

    // Both member dirs created
    for (const m of members) {
      const path = result.memberDirs[m.codebaseId];
      expect(path).toBeDefined();
      expect(existsSync(path!)).toBe(true);
    }

    // Parent CLAUDE.md was copied
    expect(existsSync(join(result.groupDir, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(result.groupDir, 'CLAUDE.md'), 'utf8')).toContain('Parent docs');

    // .gitignore was copied
    expect(existsSync(join(result.groupDir, '.gitignore'))).toBe(true);

    // Non-member subdir got copied recursively
    expect(existsSync(join(result.groupDir, 'shared-notes', 'roadmap.md'))).toBe(true);

    // Member subdirs NOT overwritten by file-copy — they stay as the worktree.
    // Stub `.git` from worktree add is what's there (not the file-copied .git from source parent).
    expect(existsSync(join(result.groupDir, 'svc-api', '.git'))).toBe(true);
  });

  it('refuses to clobber an existing group dir', async () => {
    await createGroupWorktree({
      groupName: 'platform',
      parentPath,
      members,
      branch: 'feat/x',
      baseBranch: 'main',
    });

    await expect(
      createGroupWorktree({
        groupName: 'platform',
        parentPath,
        members,
        branch: 'feat/x',
        baseBranch: 'main',
      })
    ).rejects.toBeInstanceOf(GroupWorktreeError);
  });

  it('rolls back when worktree add fails on a later member', async () => {
    // For 2 members: branch coherence runs first (2 show-ref + 2 branch creates).
    // Then worktree add for member 0 succeeds (default), member 1 fails.
    // Roll back: worktree remove on member 0; branch -D on both members.
    nextResults.push({ ok: false, err: new Error('show-ref miss 0') }); // show-ref #0
    nextResults.push({ ok: true }); // branch create #0
    nextResults.push({ ok: false, err: new Error('show-ref miss 1') }); // show-ref #1
    nextResults.push({ ok: true }); // branch create #1
    // Now createGroupWorktree itself: mkdir(groupDir) is fs (not mocked).
    // Then for each member: git worktree add. Member 0 succeeds (default behavior),
    // member 1 fails:
    // (We rely on default behavior for member 0 = create dir + .git stub.)
    // Push a result for member 1's worktree add only.
    // But the queue is FIFO: there's no per-call selectivity.
    // So we need to push results until the failure point.
    // For member 0's worktree add, we want default — push a default-mimicking result.
    // Easiest: push success for #0 (string only — but the default behavior creates
    // the dir, which we want!). Better: clear nextResults so default kicks in for #0,
    // then injecting failure for #1 needs a different mechanism.
    // Re-design: instead, use a counter-based mock for this specific test.

    // Re-establishing mock state for selective failure:
    let worktreeAddCount = 0;
    mockExecFileAsync.mockImplementationOnce(async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      // show-ref calls for branch coherence — return missing
      if (args.includes('show-ref')) {
        throw new Error('fatal: bad ref');
      }
      return { stdout: '', stderr: '' };
    });
    // Restore default mock after this test by resetting in afterEach (which we do).

    // Simpler approach: clear queue and reinstall a smarter implementation just for this test.
    nextResults.length = 0;
    mockExecFileAsync.mockImplementation(async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      if (args.includes('show-ref')) {
        throw new Error('fatal: bad ref');
      }
      if (args.includes('worktree') && args.includes('add')) {
        worktreeAddCount++;
        if (worktreeAddCount === 2) {
          throw new Error('worktree add failed on member 2');
        }
        const addIdx = args.indexOf('add');
        const path = args[addIdx + 1];
        if (path) {
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, '.git'), 'gitdir: /fake', 'utf8');
        }
        return { stdout: '', stderr: '' };
      }
      if (args.includes('worktree') && args.includes('remove')) {
        const removeIdx = args.indexOf('remove');
        for (let i = removeIdx + 1; i < args.length; i++) {
          const a = args[i];
          if (!a || a.startsWith('-')) continue;
          if (existsSync(a)) rmSync(a, { recursive: true, force: true });
          break;
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    let thrown: unknown;
    try {
      await createGroupWorktree({
        groupName: 'platform',
        parentPath,
        members,
        branch: 'feat/x',
        baseBranch: 'main',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GroupWorktreeError);

    // Group dir should be cleaned up after rollback.
    const groupDir = join(TEST_HOME, 'workspace-groups', 'platform', 'worktrees', 'feat__x');
    expect(existsSync(groupDir)).toBe(false);

    // We should have called branch -D for both members (rollback for branches we created).
    const branchDeleteCalls = execCalls.filter(
      c => c.args.includes('branch') && c.args.includes('-D')
    );
    expect(branchDeleteCalls.length).toBe(2);

    // We should have called worktree remove for member 0 (rollback).
    const worktreeRemoveCalls = execCalls.filter(
      c => c.args.includes('worktree') && c.args.includes('remove')
    );
    expect(worktreeRemoveCalls.length).toBe(1);
  });
});

describe('removeGroupWorktree', () => {
  let parentPath = '';
  let members: GroupWorktreeMember[] = [];

  beforeEach(() => {
    TEST_HOME = mkdtempSync(join(tmpdir(), 'archon-group-home-'));
    execCalls.length = 0;
    nextResults.length = 0;
    mockExecFileAsync.mockClear();
    const setup = makeParentWithMembers(['a', 'b']);
    parentPath = setup.parentPath;
    members = setup.members;
  });

  afterEach(() => {
    safeRm(parentPath);
    for (const m of members) safeRm(m.sourceRepoPath);
    safeRm(TEST_HOME);
  });

  it('removes member worktrees and the group dir', async () => {
    const created = await createGroupWorktree({
      groupName: 'platform',
      parentPath,
      members,
      branch: 'feat/x',
      baseBranch: 'main',
    });
    expect(existsSync(created.groupDir)).toBe(true);

    execCalls.length = 0;

    await removeGroupWorktree(
      'platform',
      'feat/x',
      members.map(m => ({ sourceRepoPath: m.sourceRepoPath, relativePath: m.relativePath }))
    );

    expect(existsSync(created.groupDir)).toBe(false);
    const removeCalls = execCalls.filter(
      c => c.args.includes('worktree') && c.args.includes('remove')
    );
    expect(removeCalls.length).toBe(2);
  });

  it('is a no-op when the group dir does not exist', async () => {
    await removeGroupWorktree('missing', 'feat/x');
    expect(execCalls.length).toBe(0);
  });

  it('falls back to rm-only when no members supplied', async () => {
    const groupDir = join(TEST_HOME, 'workspace-groups', 'platform', 'worktrees', 'feat__x');
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, 'marker.txt'), 'x', 'utf8');

    await removeGroupWorktree('platform', 'feat/x');

    expect(existsSync(groupDir)).toBe(false);
    expect(execCalls.length).toBe(0);
  });
});

describe('listGroupWorktrees', () => {
  beforeEach(() => {
    TEST_HOME = mkdtempSync(join(tmpdir(), 'archon-group-home-'));
  });

  afterEach(() => {
    safeRm(TEST_HOME);
  });

  it('returns empty when the workspace-groups dir does not exist', async () => {
    const result = await listGroupWorktrees();
    expect(result).toEqual([]);
  });

  it('walks groups and decodes branch names with slashes', async () => {
    const root = join(TEST_HOME, 'workspace-groups');
    mkdirSync(join(root, 'platform', 'worktrees', 'feat__x'), { recursive: true });
    mkdirSync(join(root, 'platform', 'worktrees', 'main'), { recursive: true });
    mkdirSync(join(root, 'other', 'worktrees', 'fix__bug'), { recursive: true });

    const result = await listGroupWorktrees();
    expect(result).toHaveLength(3);
    const branches = result.map(r => r.branch).sort();
    expect(branches).toEqual(['feat/x', 'fix/bug', 'main']);
  });
});

describe('copyDirectoryShallow', () => {
  let src = '';
  let dst = '';

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'archon-copy-src-'));
    dst = mkdtempSync(join(tmpdir(), 'archon-copy-dst-'));
  });

  afterEach(() => {
    safeRm(src);
    safeRm(dst);
  });

  it('copies files recursively and skips named entries', async () => {
    writeFileSync(join(src, 'keep.txt'), 'keep', 'utf8');
    writeFileSync(join(src, 'skip.txt'), 'skip', 'utf8');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'nested', 'a.txt'), 'a', 'utf8');
    mkdirSync(join(src, 'skipdir'), { recursive: true });
    writeFileSync(join(src, 'skipdir', 'inside.txt'), 'inside', 'utf8');

    await copyDirectoryShallow(src, dst, new Set(['skip.txt', 'skipdir']));

    expect(existsSync(join(dst, 'keep.txt'))).toBe(true);
    expect(existsSync(join(dst, 'skip.txt'))).toBe(false);
    expect(existsSync(join(dst, 'nested', 'a.txt'))).toBe(true);
    expect(existsSync(join(dst, 'skipdir'))).toBe(false);
    expect(readFileSync(join(dst, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
