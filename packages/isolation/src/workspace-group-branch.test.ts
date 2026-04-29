/**
 * Tests for the branch-coherence helper used by workspace groups.
 *
 * The helper drives `git` via execFileAsync; we mock that and assert on the
 * calls made — including the rollback path that deletes any branches we
 * created when a later member fails.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

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
}));

interface ExecCall {
  cmd: string;
  args: string[];
}

const execCalls: ExecCall[] = [];

/**
 * Configurable mock for execFileAsync.
 *
 * The default behavior simulates:
 *   - `git show-ref --verify --quiet refs/heads/<branch>` → throws (branch missing)
 *   - everything else → resolves with empty stdout
 *
 * Tests override per call by pushing to `nextResults`. Each entry is consumed
 * in FIFO order; once empty we fall back to the default behavior.
 */
type MockResult = { ok: true } | { ok: false; err: Error };
const nextResults: MockResult[] = [];

const mockExecFileAsync = mock(async (cmd: string, args: string[]) => {
  execCalls.push({ cmd, args });

  const next = nextResults.shift();
  if (next) {
    if (next.ok) return { stdout: '', stderr: '' };
    throw next.err;
  }

  // Default: show-ref always fails (branch missing); other commands succeed.
  if (args.includes('show-ref')) {
    throw new Error('fatal: bad ref refs/heads/<branch>');
  }
  return { stdout: '', stderr: '' };
});

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

import {
  ensureBranchAcrossMembers,
  BranchCoherenceError,
  type BranchCoherenceMember,
} from './workspace-group-branch';

function showRefCallsForBranch(branch: string): ExecCall[] {
  return execCalls.filter(
    c => c.args.includes('show-ref') && c.args.includes(`refs/heads/${branch}`)
  );
}

function branchCreateCalls(): ExecCall[] {
  return execCalls.filter(c => c.args.includes('branch') && !c.args.includes('-D'));
}

function branchDeleteCalls(): ExecCall[] {
  return execCalls.filter(c => c.args.includes('branch') && c.args.includes('-D'));
}

describe('ensureBranchAcrossMembers', () => {
  const members: BranchCoherenceMember[] = [
    { codebaseId: 'cb-1', sourceRepoPath: '/src/a' },
    { codebaseId: 'cb-2', sourceRepoPath: '/src/b' },
    { codebaseId: 'cb-3', sourceRepoPath: '/src/c' },
  ];

  beforeEach(() => {
    execCalls.length = 0;
    nextResults.length = 0;
    mockExecFileAsync.mockClear();
  });

  it('creates the branch in every repo where it is missing', async () => {
    // Default mock: show-ref throws → branch missing → branch is created.
    const result = await ensureBranchAcrossMembers(members, 'feat/x', 'main');

    expect(result.created.map(m => m.codebaseId)).toEqual(['cb-1', 'cb-2', 'cb-3']);
    expect(result.alreadyExisted).toEqual([]);
    expect(branchCreateCalls()).toHaveLength(3);
    expect(branchDeleteCalls()).toHaveLength(0);
  });

  it('skips creation when the branch already exists in a repo', async () => {
    // For cb-1: show-ref succeeds (branch exists). For cb-2 and cb-3: default (missing).
    nextResults.push({ ok: true }); // show-ref for cb-1
    // No more pre-set results — cb-2/cb-3 fall through to default (show-ref throws).

    const result = await ensureBranchAcrossMembers(members, 'feat/x', 'main');

    expect(result.created.map(m => m.codebaseId)).toEqual(['cb-2', 'cb-3']);
    expect(result.alreadyExisted.map(m => m.codebaseId)).toEqual(['cb-1']);
    expect(branchCreateCalls()).toHaveLength(2);
    expect(branchDeleteCalls()).toHaveLength(0);
  });

  it('rolls back created branches when a later repo fails', async () => {
    // cb-1: show-ref miss → create branch (success)
    // cb-2: show-ref miss → create branch (success)
    // cb-3: show-ref miss → create branch (FAIL)
    // After cb-3 fails: rollback should delete branch in cb-1 and cb-2.
    nextResults.push({ ok: false, err: new Error('show-ref miss cb-1') }); // show-ref cb-1 → miss
    nextResults.push({ ok: true }); // create branch cb-1 → success
    nextResults.push({ ok: false, err: new Error('show-ref miss cb-2') }); // show-ref cb-2 → miss
    nextResults.push({ ok: true }); // create branch cb-2 → success
    nextResults.push({ ok: false, err: new Error('show-ref miss cb-3') }); // show-ref cb-3 → miss
    nextResults.push({ ok: false, err: new Error('disk full') }); // create branch cb-3 → FAIL
    // Rollback delete-branch calls fall through to default (success).

    let thrown: unknown;
    try {
      await ensureBranchAcrossMembers(members, 'feat/x', 'main');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BranchCoherenceError);
    if (thrown instanceof BranchCoherenceError) {
      expect(thrown.failedAt.codebaseId).toBe('cb-3');
      expect(thrown.cause.message).toContain('disk full');
      expect(thrown.message).toContain('feat/x');
      expect(thrown.message).toContain('/src/c');
    }

    // Two branches created (cb-1, cb-2), both must be deleted.
    const deletes = branchDeleteCalls();
    expect(deletes).toHaveLength(2);
    const deletedFromRepos = deletes.map(c => c.args[c.args.indexOf('-C') + 1]);
    expect(deletedFromRepos.sort()).toEqual(['/src/a', '/src/b']);
  });

  it('does not delete already-existing branches during rollback', async () => {
    // cb-1: show-ref hit (branch already existed)
    // cb-2: show-ref miss → create branch (success)
    // cb-3: show-ref miss → create branch (FAIL)
    // Rollback should delete cb-2 only — NOT cb-1.
    nextResults.push({ ok: true }); // show-ref cb-1 → hit (exists)
    nextResults.push({ ok: false, err: new Error('miss') }); // show-ref cb-2 → miss
    nextResults.push({ ok: true }); // create branch cb-2 → success
    nextResults.push({ ok: false, err: new Error('miss') }); // show-ref cb-3 → miss
    nextResults.push({ ok: false, err: new Error('boom') }); // create branch cb-3 → FAIL

    await expect(ensureBranchAcrossMembers(members, 'feat/x', 'main')).rejects.toBeInstanceOf(
      BranchCoherenceError
    );

    const deletes = branchDeleteCalls();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.args).toContain('/src/b');
    expect(deletes[0]?.args).not.toContain('/src/a');
  });

  it('tolerates rollback failures and still throws the original error', async () => {
    // cb-1: create succeeds; cb-2 create fails. Rollback delete-branch on cb-1 also fails.
    nextResults.push({ ok: false, err: new Error('miss') }); // show-ref cb-1
    nextResults.push({ ok: true }); // create cb-1
    nextResults.push({ ok: false, err: new Error('miss') }); // show-ref cb-2
    nextResults.push({ ok: false, err: new Error('original') }); // create cb-2 fails
    nextResults.push({ ok: false, err: new Error('rollback failure') }); // delete cb-1 fails

    let thrown: unknown;
    try {
      await ensureBranchAcrossMembers([members[0]!, members[1]!], 'feat/x', 'main');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BranchCoherenceError);
    if (thrown instanceof BranchCoherenceError) {
      // The user-facing error must reference the original failure, not the rollback.
      expect(thrown.cause.message).toContain('original');
    }
  });

  it('handles an empty member list as a no-op', async () => {
    const result = await ensureBranchAcrossMembers([], 'feat/x', 'main');
    expect(result.created).toEqual([]);
    expect(result.alreadyExisted).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  it('uses baseBranch as the start point for new branches', async () => {
    await ensureBranchAcrossMembers([members[0]!], 'feat/x', 'develop');

    const create = branchCreateCalls()[0];
    expect(create?.args).toEqual(['-C', '/src/a', 'branch', 'feat/x', 'develop']);
  });
});

describe('showRefCallsForBranch (test helper sanity)', () => {
  it('only counts the relevant branch ref', () => {
    execCalls.length = 0;
    execCalls.push({
      cmd: 'git',
      args: ['-C', '/x', 'show-ref', '--verify', '--quiet', 'refs/heads/foo'],
    });
    execCalls.push({
      cmd: 'git',
      args: ['-C', '/x', 'show-ref', '--verify', '--quiet', 'refs/heads/bar'],
    });
    expect(showRefCallsForBranch('foo')).toHaveLength(1);
  });
});
