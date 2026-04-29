/**
 * Tests for archon group push (push + optional PR creation with cross-linking).
 */
import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- mocks ---------------------------------------------------------------

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

let TEST_HOME = '';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getWorkspaceGroupWorktreePath: (groupName: string, branch: string) =>
    join(TEST_HOME, 'workspace-groups', groupName, 'worktrees', branch.replace(/\//g, '__')),
}));

const mockGetGroupByName = mock<(name: string) => Promise<unknown>>(() => Promise.resolve(null));
const mockGetMembersForGroup = mock<(id: string) => Promise<unknown[]>>(() => Promise.resolve([]));
const mockGetCodebase = mock<(id: string) => Promise<unknown>>(id =>
  Promise.resolve({ id, default_cwd: '/src/' + id, name: 'owner/' + id })
);

mock.module('@archon/core', () => ({
  workspaceGroupDb: {
    getGroupByName: mockGetGroupByName,
    getMembersForGroup: mockGetMembersForGroup,
  },
  codebaseDb: {
    getCodebase: mockGetCodebase,
  },
}));

interface ExecCall {
  cmd: string;
  args: string[];
  cwd?: string;
}
const execCalls: ExecCall[] = [];

type MockResult = { ok: true; stdout?: string } | { ok: false; err: Error };
const nextResults: MockResult[] = [];

const mockExecFileAsync = mock(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
  execCalls.push({ cmd, args, cwd: opts?.cwd });
  const next = nextResults.shift();
  if (next) {
    if (next.ok) return { stdout: next.stdout ?? '', stderr: '' };
    throw next.err;
  }
  return { stdout: '', stderr: '' };
});

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

import { pushGroupWorktree, groupPushCommand } from './group-push';

// --- helpers --------------------------------------------------------------

function setupGroup(branch: string, members: string[]): void {
  TEST_HOME = mkdtempSync(join(tmpdir(), 'archon-push-test-'));
  // Materialize the group worktree dir + each member subdir so existsSync works.
  const groupDir = join(
    TEST_HOME,
    'workspace-groups',
    'platform',
    'worktrees',
    branch.replace(/\//g, '__')
  );
  mkdirSync(groupDir, { recursive: true });
  for (const m of members) {
    mkdirSync(join(groupDir, m), { recursive: true });
  }
  mockGetGroupByName.mockImplementation(() =>
    Promise.resolve({ id: 'g1', name: 'platform', parent_path: '/dev/p', created_at: new Date() })
  );
  mockGetMembersForGroup.mockImplementation(() =>
    Promise.resolve(
      members.map(m => ({ group_id: 'g1', codebase_id: 'cb-' + m, relative_path: m }))
    )
  );
  mockGetCodebase.mockImplementation(id =>
    Promise.resolve({ id, default_cwd: '/src/' + id, name: 'owner/' + id })
  );
}

function teardown(): void {
  if (TEST_HOME) {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function pushCalls(): ExecCall[] {
  return execCalls.filter(c => c.cmd === 'git' && c.args.includes('push'));
}

function prCreateCalls(): ExecCall[] {
  return execCalls.filter(
    c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('create')
  );
}

function prEditCalls(): ExecCall[] {
  return execCalls.filter(c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('edit'));
}

// --- tests ----------------------------------------------------------------

describe('pushGroupWorktree', () => {
  beforeEach(() => {
    execCalls.length = 0;
    nextResults.length = 0;
    mockExecFileAsync.mockClear();
    mockGetGroupByName.mockClear();
    mockGetMembersForGroup.mockClear();
    mockGetCodebase.mockClear();
    spyOn(console, 'log').mockImplementation(() => undefined);
    spyOn(console, 'error').mockImplementation(() => undefined);
    spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('pushes each member when --pr is not set', async () => {
    setupGroup('feat/x', ['svc-a', 'svc-b']);
    try {
      const result = await pushGroupWorktree('platform', 'feat/x');
      expect(result.pushed.map(p => p.relativePath).sort()).toEqual(['svc-a', 'svc-b']);
      expect(result.prs).toEqual([]);
      expect(pushCalls()).toHaveLength(2);
      expect(prCreateCalls()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('skips PR phase if any push fails', async () => {
    setupGroup('feat/x', ['svc-a', 'svc-b']);
    try {
      // svc-a push succeeds (default), svc-b push fails.
      // Calls: push svc-a, push svc-b — order may depend on iteration.
      // Use queued results: 1st push ok, 2nd fail.
      nextResults.push({ ok: true });
      nextResults.push({
        ok: false,
        err: Object.assign(new Error('rejected'), { stderr: 'remote rejected' }),
      });

      const result = await pushGroupWorktree('platform', 'feat/x', { openPrs: true });
      expect(result.pushed.length).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.phase).toBe('push');
      // PR phase must not have run.
      expect(prCreateCalls()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('opens a PR per member with --pr and cross-links them', async () => {
    setupGroup('feat/x', ['svc-a', 'svc-b']);
    try {
      // Order: phase 1 (push×N), gh auth status pre-flight, phase 2 (per member:
      // git log + gh pr create + gh pr view --json), phase 3 (cross-link edits).
      nextResults.push({ ok: true }); // push svc-a
      nextResults.push({ ok: true }); // push svc-b
      nextResults.push({ ok: true }); // gh auth status (pre-flight)
      nextResults.push({ ok: true, stdout: 'feat: add svc-a thing' }); // git log svc-a
      nextResults.push({ ok: true, stdout: 'created PR' }); // gh pr create svc-a
      nextResults.push({
        ok: true,
        stdout: JSON.stringify({ url: 'https://github.com/owner/svc-a/pull/42', number: 42 }),
      }); // gh pr view svc-a
      nextResults.push({ ok: true, stdout: 'feat: add svc-b thing' }); // git log svc-b
      nextResults.push({ ok: true, stdout: 'created PR' }); // gh pr create svc-b
      nextResults.push({
        ok: true,
        stdout: JSON.stringify({ url: 'https://github.com/owner/svc-b/pull/7', number: 7 }),
      }); // gh pr view svc-b
      // Pass-3: 2 pr-edit calls — fall through to defaults (success).

      const result = await pushGroupWorktree('platform', 'feat/x', { openPrs: true });

      expect(result.pushed).toHaveLength(2);
      expect(result.prs).toHaveLength(2);
      expect(result.prs.map(p => p.url).sort()).toEqual([
        'https://github.com/owner/svc-a/pull/42',
        'https://github.com/owner/svc-b/pull/7',
      ]);
      expect(result.prs.find(p => p.relativePath === 'svc-a')?.number).toBe(42);
      expect(result.prs.find(p => p.relativePath === 'svc-b')?.number).toBe(7);

      // Cross-link pass: 2 pr-edit calls, each body containing the OTHER PR URL.
      const edits = prEditCalls();
      expect(edits).toHaveLength(2);
      // Each edit body should mention the sibling repo's URL.
      const editForA = edits.find(e => e.cwd?.endsWith('svc-a'));
      const editForB = edits.find(e => e.cwd?.endsWith('svc-b'));
      const aBodyIdx = editForA ? editForA.args.indexOf('--body') : -1;
      const bBodyIdx = editForB ? editForB.args.indexOf('--body') : -1;
      expect(editForA?.args[aBodyIdx + 1] ?? '').toContain('svc-b');
      expect(editForB?.args[bBodyIdx + 1] ?? '').toContain('svc-a');
    } finally {
      teardown();
    }
  });

  it('does not cross-link when only one PR was opened', async () => {
    setupGroup('feat/x', ['svc-only']);
    try {
      nextResults.push({ ok: true }); // push
      nextResults.push({ ok: true }); // gh auth status
      nextResults.push({ ok: true, stdout: 'msg' }); // git log
      nextResults.push({ ok: true, stdout: 'created PR' }); // gh pr create
      nextResults.push({
        ok: true,
        stdout: JSON.stringify({ url: 'https://github.com/o/svc-only/pull/1', number: 1 }),
      }); // gh pr view

      const result = await pushGroupWorktree('platform', 'feat/x', { openPrs: true });
      expect(result.prs).toHaveLength(1);
      // Single PR → no cross-link pass.
      expect(prEditCalls()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('aborts the PR phase when gh auth status fails', async () => {
    setupGroup('feat/x', ['svc-a']);
    try {
      nextResults.push({ ok: true }); // push svc-a
      nextResults.push({
        ok: false,
        err: Object.assign(new Error('not logged in'), {
          stderr: 'You are not logged into any GitHub hosts.',
        }),
      }); // gh auth status

      const result = await pushGroupWorktree('platform', 'feat/x', { openPrs: true });
      expect(result.pushed).toHaveLength(1); // push still succeeded
      expect(result.prs).toHaveLength(0);
      expect(
        result.errors.some(e => e.phase === 'pr-create' && e.message.includes('gh pre-flight'))
      ).toBe(true);
      // No `gh pr create` calls were attempted.
      expect(prCreateCalls()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('handles pr-create failure on one member and continues for others', async () => {
    setupGroup('feat/x', ['svc-a', 'svc-b']);
    try {
      nextResults.push({ ok: true }); // push svc-a
      nextResults.push({ ok: true }); // push svc-b
      nextResults.push({ ok: true }); // gh auth status
      nextResults.push({ ok: true, stdout: 'msg' }); // git log svc-a
      nextResults.push({
        ok: false,
        err: Object.assign(new Error('boom'), { stderr: 'rate limited' }),
      }); // pr create svc-a fails
      nextResults.push({ ok: true, stdout: 'msg' }); // git log svc-b
      nextResults.push({ ok: true, stdout: 'created' }); // pr create svc-b
      nextResults.push({
        ok: true,
        stdout: JSON.stringify({ url: 'https://github.com/o/svc-b/pull/9', number: 9 }),
      }); // gh pr view svc-b

      const result = await pushGroupWorktree('platform', 'feat/x', { openPrs: true });
      expect(result.prs).toHaveLength(1);
      expect(result.errors.some(e => e.phase === 'pr-create' && e.relativePath === 'svc-a')).toBe(
        true
      );
      // Single successful PR → no cross-link pass needed.
      expect(prEditCalls()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('throws when group does not exist', async () => {
    setupGroup('feat/x', ['svc-a']);
    try {
      mockGetGroupByName.mockImplementation(() => Promise.resolve(null));
      await expect(pushGroupWorktree('missing', 'feat/x')).rejects.toThrow(/no workspace group/i);
    } finally {
      teardown();
    }
  });

  it('throws when group worktree dir is missing', async () => {
    setupGroup('feat/x', ['svc-a']);
    try {
      // Remove the group worktree dir to simulate missing on disk.
      rmSync(TEST_HOME, { recursive: true, force: true });
      // Re-setup mocks since they were cleared.
      mockGetGroupByName.mockImplementation(() =>
        Promise.resolve({
          id: 'g1',
          name: 'platform',
          parent_path: '/dev/p',
          created_at: new Date(),
        })
      );
      mockGetMembersForGroup.mockImplementation(() =>
        Promise.resolve([{ group_id: 'g1', codebase_id: 'cb-svc-a', relative_path: 'svc-a' }])
      );
      await expect(pushGroupWorktree('platform', 'feat/x')).rejects.toThrow(/no group worktree/i);
    } finally {
      // Already removed; just clear TEST_HOME.
      TEST_HOME = '';
    }
  });

  it('dry-run prints plan and makes no calls', async () => {
    setupGroup('feat/x', ['svc-a', 'svc-b']);
    try {
      const result = await pushGroupWorktree('platform', 'feat/x', {
        openPrs: true,
        dryRun: true,
      });
      expect(result.pushed).toEqual([]);
      expect(result.prs).toEqual([]);
      expect(execCalls).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe('groupPushCommand', () => {
  beforeEach(() => {
    execCalls.length = 0;
    nextResults.length = 0;
    mockExecFileAsync.mockClear();
    spyOn(console, 'log').mockImplementation(() => undefined);
    spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('errors when --branch is omitted', async () => {
    const code = await groupPushCommand('platform', {});
    expect(code).toBe(1);
  });

  it('returns 0 on full success', async () => {
    setupGroup('feat/x', ['svc-a']);
    try {
      const code = await groupPushCommand('platform', { branch: 'feat/x' });
      expect(code).toBe(0);
    } finally {
      teardown();
    }
  });

  it('returns 1 when there are errors', async () => {
    setupGroup('feat/x', ['svc-a']);
    try {
      nextResults.push({ ok: false, err: new Error('rejected') });
      const code = await groupPushCommand('platform', { branch: 'feat/x' });
      expect(code).toBe(1);
    } finally {
      teardown();
    }
  });
});
