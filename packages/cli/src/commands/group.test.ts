/**
 * Tests for archon group register/list/show/remove commands.
 */
import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

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

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockGetGroupByName = mock<(name: string) => Promise<unknown>>(() => Promise.resolve(null));
const mockCreateGroup = mock((data: { name: string; parent_path: string }) =>
  Promise.resolve({
    id: 'group-id',
    name: data.name,
    parent_path: data.parent_path,
    created_at: new Date(),
  })
);
const mockAddMember = mock(
  (data: { group_id: string; codebase_id: string; relative_path: string }) =>
    Promise.resolve({ ...data })
);
const mockListGroups = mock<() => Promise<unknown[]>>(() => Promise.resolve([]));
const mockGetMembersForGroup = mock<(id: string) => Promise<unknown[]>>(() => Promise.resolve([]));
const mockRemoveGroup = mock<(id: string) => Promise<void>>(() => Promise.resolve());

const mockRegisterRepository = mock<(localPath: string) => Promise<unknown>>(localPath =>
  Promise.resolve({
    codebaseId: 'cb-' + basename(localPath),
    name: 'owner/' + basename(localPath),
    repositoryUrl: null,
    defaultCwd: localPath,
    commandCount: 0,
    alreadyExisted: false,
  })
);

const mockGetCodebase = mock<(id: string) => Promise<unknown>>(id =>
  Promise.resolve({ id, default_cwd: '/src/' + id, name: 'owner/' + id })
);

mock.module('@archon/core', () => ({
  workspaceGroupDb: {
    getGroupByName: mockGetGroupByName,
    createGroup: mockCreateGroup,
    addMember: mockAddMember,
    listGroups: mockListGroups,
    getMembersForGroup: mockGetMembersForGroup,
    removeGroup: mockRemoveGroup,
  },
  codebaseDb: {
    getCodebase: mockGetCodebase,
  },
  registerRepository: mockRegisterRepository,
}));

const mockListGroupWorktrees = mock<() => Promise<unknown[]>>(() => Promise.resolve([]));
const mockRemoveGroupWorktree = mock<
  (groupName: string, branch: string, members?: unknown) => Promise<void>
>(() => Promise.resolve());

mock.module('@archon/isolation', () => ({
  listGroupWorktrees: mockListGroupWorktrees,
  removeGroupWorktree: mockRemoveGroupWorktree,
}));

import {
  groupRegisterCommand,
  groupListCommand,
  groupShowCommand,
  groupRemoveCommand,
  groupCleanupCommand,
} from './group';

// --- helpers --------------------------------------------------------------

function makeTempParent(children: { name: string; isGitRepo: boolean }[]): string {
  const parent = mkdtempSync(join(tmpdir(), 'archon-group-test-'));
  for (const child of children) {
    const dir = join(parent, child.name);
    mkdirSync(dir, { recursive: true });
    if (child.isGitRepo) {
      writeFileSync(join(dir, '.git'), 'gitdir: /fake', 'utf8');
    }
  }
  return parent;
}

function cleanup(parent: string): void {
  try {
    rmSync(parent, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// --- tests ----------------------------------------------------------------

describe('groupRegisterCommand', () => {
  let consoleLog: ReturnType<typeof spyOn>;
  let consoleError: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockCreateGroup.mockClear();
    mockAddMember.mockClear();
    mockRegisterRepository.mockClear();
    mockGetGroupByName.mockImplementation(() => Promise.resolve(null));
    mockRegisterRepository.mockImplementation(localPath =>
      Promise.resolve({
        codebaseId: 'cb-' + basename(localPath),
        name: 'owner/' + basename(localPath),
        repositoryUrl: null,
        defaultCwd: localPath,
        commandCount: 0,
        alreadyExisted: false,
      })
    );
    consoleLog = spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('registers each git child and creates group + members', async () => {
    const parent = makeTempParent([
      { name: 'svc-api', isGitRepo: true },
      { name: 'svc-web', isGitRepo: true },
      { name: 'docs', isGitRepo: false },
    ]);
    try {
      const code = await groupRegisterCommand(parent);
      expect(code).toBe(0);
      expect(mockRegisterRepository).toHaveBeenCalledTimes(2);
      expect(mockCreateGroup).toHaveBeenCalledTimes(1);
      expect(mockAddMember).toHaveBeenCalledTimes(2);
      const createArg = mockCreateGroup.mock.calls[0]?.[0];
      expect(createArg).toEqual({ name: basename(parent), parent_path: parent });
      const memberPaths = mockAddMember.mock.calls.map(c => c[0]?.relative_path);
      expect(memberPaths.sort()).toEqual(['svc-api', 'svc-web']);
    } finally {
      cleanup(parent);
    }
  });

  it('honors --name override', async () => {
    const parent = makeTempParent([{ name: 'a', isGitRepo: true }]);
    try {
      await groupRegisterCommand(parent, { name: 'my-platform' });
      const createArg = mockCreateGroup.mock.calls[0]?.[0];
      expect(createArg?.name).toBe('my-platform');
    } finally {
      cleanup(parent);
    }
  });

  it('errors when parent path does not exist', async () => {
    const code = await groupRegisterCommand('/tmp/archon-definitely-not-here-' + Date.now());
    expect(code).toBe(1);
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it('errors when parent has no git children', async () => {
    const parent = makeTempParent([
      { name: 'docs', isGitRepo: false },
      { name: 'notes', isGitRepo: false },
    ]);
    try {
      const code = await groupRegisterCommand(parent);
      expect(code).toBe(1);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      cleanup(parent);
    }
  });

  it('rejects an invalid group name (path traversal via --name)', async () => {
    const parent = makeTempParent([{ name: 'svc-a', isGitRepo: true }]);
    try {
      const code = await groupRegisterCommand(parent, { name: '../etc' });
      expect(code).toBe(1);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      cleanup(parent);
    }
  });

  it('errors when group name already exists', async () => {
    mockGetGroupByName.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'g',
        name: 'my-platform',
        parent_path: '/old',
        created_at: new Date(),
      })
    );
    const parent = makeTempParent([{ name: 'a', isGitRepo: true }]);
    try {
      const code = await groupRegisterCommand(parent, { name: 'my-platform' });
      expect(code).toBe(1);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      cleanup(parent);
    }
  });

  it('continues past a single member that fails to register', async () => {
    mockRegisterRepository.mockImplementationOnce(() => Promise.reject(new Error('fake fail')));
    const parent = makeTempParent([
      { name: 'fails', isGitRepo: true },
      { name: 'works', isGitRepo: true },
    ]);
    try {
      const code = await groupRegisterCommand(parent);
      expect(code).toBe(0);
      expect(mockCreateGroup).toHaveBeenCalledTimes(1);
      expect(mockAddMember).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(parent);
    }
  });

  it('errors and skips group create when ALL members fail to register', async () => {
    mockRegisterRepository.mockImplementation(() => Promise.reject(new Error('fail')));
    const parent = makeTempParent([
      { name: 'a', isGitRepo: true },
      { name: 'b', isGitRepo: true },
    ]);
    try {
      const code = await groupRegisterCommand(parent);
      expect(code).toBe(1);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      cleanup(parent);
    }
  });

  // restore
  it('cleans up console spies', () => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });
});

describe('groupListCommand', () => {
  beforeEach(() => {
    mockListGroups.mockClear();
    spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('prints empty hint when no groups', async () => {
    mockListGroups.mockImplementationOnce(() => Promise.resolve([]));
    const code = await groupListCommand();
    expect(code).toBe(0);
  });

  it('prints group summary when groups exist', async () => {
    mockListGroups.mockImplementationOnce(() =>
      Promise.resolve([
        { id: 'g1', name: 'platform', parent_path: '/dev/p', created_at: new Date() },
      ])
    );
    const code = await groupListCommand();
    expect(code).toBe(0);
  });

  it('returns JSON when --json', async () => {
    mockListGroups.mockImplementationOnce(() =>
      Promise.resolve([
        { id: 'g1', name: 'platform', parent_path: '/dev/p', created_at: new Date() },
      ])
    );
    const code = await groupListCommand(true);
    expect(code).toBe(0);
  });
});

describe('groupShowCommand', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockGetMembersForGroup.mockClear();
    spyOn(console, 'log').mockImplementation(() => undefined);
    spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('errors when group not found', async () => {
    mockGetGroupByName.mockImplementationOnce(() => Promise.resolve(null));
    const code = await groupShowCommand('missing');
    expect(code).toBe(1);
  });

  it('prints parent + members when group exists', async () => {
    mockGetGroupByName.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'g1',
        name: 'platform',
        parent_path: '/dev/p',
        created_at: new Date(),
      })
    );
    mockGetMembersForGroup.mockImplementationOnce(() =>
      Promise.resolve([
        { group_id: 'g1', codebase_id: 'cb-1', relative_path: 'svc-a' },
        { group_id: 'g1', codebase_id: 'cb-2', relative_path: 'svc-b' },
      ])
    );
    const code = await groupShowCommand('platform');
    expect(code).toBe(0);
  });
});

describe('groupRemoveCommand', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockRemoveGroup.mockClear();
    spyOn(console, 'log').mockImplementation(() => undefined);
    spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('errors when group not found', async () => {
    mockGetGroupByName.mockImplementationOnce(() => Promise.resolve(null));
    const code = await groupRemoveCommand('missing');
    expect(code).toBe(1);
    expect(mockRemoveGroup).not.toHaveBeenCalled();
  });

  it('removes group when found', async () => {
    mockGetGroupByName.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'g1',
        name: 'platform',
        parent_path: '/dev/p',
        created_at: new Date(),
      })
    );
    mockListGroupWorktrees.mockImplementationOnce(() => Promise.resolve([]));
    const code = await groupRemoveCommand('platform');
    expect(code).toBe(0);
    expect(mockRemoveGroup).toHaveBeenCalledWith('g1');
  });

  it('refuses to remove when worktrees still exist on disk', async () => {
    mockGetGroupByName.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'g1',
        name: 'platform',
        parent_path: '/dev/p',
        created_at: new Date(),
      })
    );
    mockListGroupWorktrees.mockImplementationOnce(() =>
      Promise.resolve([{ groupName: 'platform', branch: 'feat/x', path: '/p/x' }])
    );
    const code = await groupRemoveCommand('platform');
    expect(code).toBe(1);
    expect(mockRemoveGroup).not.toHaveBeenCalled();
  });

  it('cascades cleanup with --with-worktrees', async () => {
    mockGetGroupByName.mockImplementationOnce(() =>
      Promise.resolve({
        id: 'g1',
        name: 'platform',
        parent_path: '/dev/p',
        created_at: new Date(),
      })
    );
    mockGetMembersForGroup.mockImplementationOnce(() =>
      Promise.resolve([{ group_id: 'g1', codebase_id: 'cb-a', relative_path: 'svc-a' }])
    );
    mockListGroupWorktrees.mockImplementationOnce(() =>
      Promise.resolve([{ groupName: 'platform', branch: 'feat/x', path: '/p/x' }])
    );
    const code = await groupRemoveCommand('platform', { withWorktrees: true });
    expect(code).toBe(0);
    expect(mockRemoveGroupWorktree).toHaveBeenCalledTimes(1);
    expect(mockRemoveGroup).toHaveBeenCalledWith('g1');
  });
});

describe('groupCleanupCommand', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockGetMembersForGroup.mockClear();
    mockGetCodebase.mockClear();
    mockListGroupWorktrees.mockClear();
    mockRemoveGroupWorktree.mockClear();
    // Reset implementations so a leftover `mockImplementationOnce` from a
    // previous test (where the function never reached it because of an early
    // return) doesn't fire on the next test's call. We set defaults explicitly
    // and use `mockImplementation` (not `Once`) below.
    mockGetCodebase.mockImplementation(id =>
      Promise.resolve({ id, default_cwd: '/src/' + id, name: 'owner/' + id })
    );
    mockListGroupWorktrees.mockImplementation(() => Promise.resolve([]));
    mockRemoveGroupWorktree.mockImplementation(() => Promise.resolve());
    spyOn(console, 'log').mockImplementation(() => undefined);
    spyOn(console, 'error').mockImplementation(() => undefined);
    spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  function setupGroup(): void {
    mockGetGroupByName.mockImplementation(() =>
      Promise.resolve({
        id: 'g1',
        name: 'platform',
        parent_path: '/dev/p',
        created_at: new Date(),
      })
    );
    mockGetMembersForGroup.mockImplementation(() =>
      Promise.resolve([{ group_id: 'g1', codebase_id: 'cb-a', relative_path: 'svc-a' }])
    );
  }

  it('errors when group does not exist', async () => {
    mockGetGroupByName.mockImplementationOnce(() => Promise.resolve(null));
    const code = await groupCleanupCommand('missing');
    expect(code).toBe(1);
    expect(mockRemoveGroupWorktree).not.toHaveBeenCalled();
  });

  it('errors when --branch and --all are both passed', async () => {
    setupGroup();
    mockListGroupWorktrees.mockImplementation(() =>
      Promise.resolve([{ groupName: 'platform', branch: 'feat/x', path: '/p' }])
    );
    const code = await groupCleanupCommand('platform', { branch: 'feat/x', all: true });
    expect(code).toBe(1);
    expect(mockRemoveGroupWorktree).not.toHaveBeenCalled();
  });

  it('reports no worktrees when none on disk', async () => {
    setupGroup();
    mockListGroupWorktrees.mockImplementation(() => Promise.resolve([]));
    const code = await groupCleanupCommand('platform', { all: true, force: true });
    expect(code).toBe(0);
    expect(mockRemoveGroupWorktree).not.toHaveBeenCalled();
  });

  it('without --force, lists candidates but does not remove', async () => {
    setupGroup();
    mockListGroupWorktrees.mockImplementation(() =>
      Promise.resolve([{ groupName: 'platform', branch: 'feat/x', path: '/p' }])
    );
    const code = await groupCleanupCommand('platform', { all: true });
    expect(code).toBe(0);
    expect(mockRemoveGroupWorktree).not.toHaveBeenCalled();
  });

  it('with --branch + --force removes only the matching worktree', async () => {
    setupGroup();
    mockListGroupWorktrees.mockImplementation(() =>
      Promise.resolve([
        { groupName: 'platform', branch: 'feat/x', path: '/p/x' },
        { groupName: 'platform', branch: 'feat/y', path: '/p/y' },
      ])
    );
    const code = await groupCleanupCommand('platform', { branch: 'feat/y', force: true });
    expect(code).toBe(0);
    expect(mockRemoveGroupWorktree).toHaveBeenCalledTimes(1);
    expect(mockRemoveGroupWorktree.mock.calls[0]?.[1]).toBe('feat/y');
  });

  it('errors when --branch matches no worktree', async () => {
    setupGroup();
    mockListGroupWorktrees.mockImplementation(() =>
      Promise.resolve([{ groupName: 'platform', branch: 'feat/x', path: '/p/x' }])
    );
    const code = await groupCleanupCommand('platform', { branch: 'no-such', force: true });
    expect(code).toBe(1);
    expect(mockRemoveGroupWorktree).not.toHaveBeenCalled();
  });

  it('with --all + --force removes all worktrees of the group', async () => {
    setupGroup();
    mockListGroupWorktrees.mockImplementation(() =>
      Promise.resolve([
        { groupName: 'platform', branch: 'feat/x', path: '/p/x' },
        { groupName: 'platform', branch: 'feat/y', path: '/p/y' },
        { groupName: 'other', branch: 'feat/z', path: '/o/z' }, // different group, ignored
      ])
    );
    const code = await groupCleanupCommand('platform', { all: true, force: true });
    expect(code).toBe(0);
    expect(mockRemoveGroupWorktree).toHaveBeenCalledTimes(2);
    const branches = mockRemoveGroupWorktree.mock.calls.map(c => c[1]);
    expect(branches.sort()).toEqual(['feat/x', 'feat/y']);
  });

  it('warns and falls back to plain rm when a member codebase is missing', async () => {
    setupGroup();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListGroupWorktrees.mockImplementation(() =>
      Promise.resolve([{ groupName: 'platform', branch: 'feat/x', path: '/p/x' }])
    );
    const code = await groupCleanupCommand('platform', { all: true, force: true });
    expect(code).toBe(0);
    // Called with members=undefined fallback
    expect(mockRemoveGroupWorktree.mock.calls[0]?.[2]).toBeUndefined();
  });
});
