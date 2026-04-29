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

mock.module('@archon/core', () => ({
  workspaceGroupDb: {
    getGroupByName: mockGetGroupByName,
    createGroup: mockCreateGroup,
    addMember: mockAddMember,
    listGroups: mockListGroups,
    getMembersForGroup: mockGetMembersForGroup,
    removeGroup: mockRemoveGroup,
  },
  registerRepository: mockRegisterRepository,
}));

import {
  groupRegisterCommand,
  groupListCommand,
  groupShowCommand,
  groupRemoveCommand,
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
    const code = await groupRemoveCommand('platform');
    expect(code).toBe(0);
    expect(mockRemoveGroup).toHaveBeenCalledWith('g1');
  });
});
