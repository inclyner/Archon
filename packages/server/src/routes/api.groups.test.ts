/**
 * Tests for /api/groups endpoints.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockListGroups = mock(
  async () => [] as { id: string; name: string; parent_path: string; created_at: Date }[]
);
const mockGetGroupByName = mock(
  async (_name: string) =>
    null as null | { id: string; name: string; parent_path: string; created_at: Date }
);
const mockGetMembersForGroup = mock(
  async (_id: string) => [] as { group_id: string; codebase_id: string; relative_path: string }[]
);
const mockCreateGroup = mock(async (data: { name: string; parent_path: string }) => ({
  id: 'g-' + data.name,
  name: data.name,
  parent_path: data.parent_path,
  created_at: new Date(),
}));
const mockAddMember = mock(
  async (data: { group_id: string; codebase_id: string; relative_path: string }) => ({ ...data })
);
const mockRemoveGroup = mock(async (_id: string) => {});

const mockListGroupWorktrees = mock(
  async () => [] as { groupName: string; branch: string; path: string }[]
);
const mockRemoveGroupWorktree = mock(async (_n: string, _b: string, _m?: unknown) => {});

const mockGetCodebase = mock(
  async (id: string) =>
    ({
      id,
      name: 'owner/' + id,
      repository_url: null,
      default_cwd: '/src/' + id,
      ai_assistant_type: 'claude',
      commands: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }) as {
      id: string;
      name: string;
      repository_url: string | null;
      default_cwd: string;
      ai_assistant_type: string;
      commands: Record<string, unknown> | string;
      created_at: string;
      updated_at: string;
    }
);
const mockRegisterRepository = mock(async (path: string) => ({
  codebaseId: 'cb-' + path.replace(/[^a-z0-9]/gi, '_'),
  name: 'owner/' + path,
  repositoryUrl: null,
  defaultCwd: path,
  commandCount: 0,
  alreadyExisted: false,
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mockRegisterRepository,
  validateWorkspaceGroupName: (name: string) => {
    // Mirror the production rule for the path-traversal test case. Anything
    // not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` is rejected; tests rely on
    // the rejection path for invalid names like '../etc'.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
      return `Group name "${name}" is invalid.`;
    }
    return null;
  },
  // Stand-in for pool.withTransaction: just calls the inner fn with a fake
  // query function that delegates to whatever the workspaceGroupDb mocks return.
  // The shape of the inner query doesn't matter to the test — workspaceGroupDb
  // is mocked separately and ignores the second arg.
  pool: {
    withTransaction: <T>(
      fn: (q: <U>(sql: string, params?: unknown[]) => Promise<{ rows: U[] }>) => Promise<T>
    ): Promise<T> => fn(async () => ({ rows: [] })),
  },
  ConversationNotFoundError: class extends Error {},
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/isolation', () => ({
  listGroupWorktrees: mockListGroupWorktrees,
  removeGroupWorktree: mockRemoveGroupWorktree,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({ id: 'c1' })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mockGetCodebase,
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({})),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/db/workspace-groups', () => ({
  listGroups: mockListGroups,
  getGroupByName: mockGetGroupByName,
  getMembersForGroup: mockGetMembersForGroup,
  createGroup: mockCreateGroup,
  addMember: mockAddMember,
  removeGroup: mockRemoveGroup,
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

function makeParentWith(memberRels: string[]): string {
  const parent = mkdtempSync(join(tmpdir(), 'archon-api-groups-'));
  for (const m of memberRels) {
    mkdirSync(join(parent, m), { recursive: true });
    writeFileSync(join(parent, m, '.git'), 'gitdir: /fake', 'utf8');
  }
  return parent;
}

function safeRm(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/groups', () => {
  beforeEach(() => {
    mockListGroups.mockClear();
  });

  test('returns empty list', async () => {
    mockListGroups.mockImplementation(async () => []);
    const app = makeApp();
    const res = await app.request('/api/groups');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ groups: [] });
  });

  test('returns registered groups', async () => {
    const fakeDate = new Date('2026-01-01T00:00:00Z');
    mockListGroups.mockImplementation(async () => [
      { id: 'g1', name: 'platform', parent_path: '/dev/p', created_at: fakeDate },
    ]);
    const app = makeApp();
    const res = await app.request('/api/groups');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: { name: string }[] };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.name).toBe('platform');
  });
});

describe('GET /api/groups/:name', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockGetMembersForGroup.mockClear();
  });

  test('404 when group not found', async () => {
    mockGetGroupByName.mockImplementation(async () => null);
    const app = makeApp();
    const res = await app.request('/api/groups/missing');
    expect(res.status).toBe(404);
  });

  test('returns group + members', async () => {
    mockGetGroupByName.mockImplementation(async () => ({
      id: 'g1',
      name: 'platform',
      parent_path: '/dev/p',
      created_at: new Date(),
    }));
    mockGetMembersForGroup.mockImplementation(async () => [
      { group_id: 'g1', codebase_id: 'cb-a', relative_path: 'svc-a' },
      { group_id: 'g1', codebase_id: 'cb-b', relative_path: 'svc-b' },
    ]);
    const app = makeApp();
    const res = await app.request('/api/groups/platform');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      group: { name: string };
      members: { relative_path: string }[];
    };
    expect(body.group.name).toBe('platform');
    expect(body.members.map(m => m.relative_path).sort()).toEqual(['svc-a', 'svc-b']);
  });
});

describe('POST /api/groups', () => {
  let parent = '';

  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockCreateGroup.mockClear();
    mockAddMember.mockClear();
    mockRegisterRepository.mockClear();
    mockGetGroupByName.mockImplementation(async () => null);
    mockRegisterRepository.mockImplementation(async (path: string) => ({
      codebaseId: 'cb-' + path.replace(/[^a-z0-9]/gi, '_'),
      name: 'owner/x',
      repositoryUrl: null,
      defaultCwd: path,
      commandCount: 0,
      alreadyExisted: false,
    }));
  });

  test('400 when parent path does not exist', async () => {
    const app = makeApp();
    const res = await app.request('/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentPath: '/tmp/definitely-not-here-' + Date.now() }),
    });
    expect(res.status).toBe(400);
  });

  test('400 when --name is path-traversal-shaped', async () => {
    parent = makeParentWith(['svc-a']);
    try {
      const app = makeApp();
      const res = await app.request('/api/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentPath: parent, name: '../etc' }),
      });
      expect(res.status).toBe(400);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      safeRm(parent);
    }
  });

  test('400 when no git children', async () => {
    parent = mkdtempSync(join(tmpdir(), 'archon-api-groups-empty-'));
    mkdirSync(join(parent, 'docs'), { recursive: true }); // no .git
    try {
      const app = makeApp();
      const res = await app.request('/api/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentPath: parent }),
      });
      expect(res.status).toBe(400);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      safeRm(parent);
    }
  });

  test('400 when group name already exists', async () => {
    parent = makeParentWith(['svc-a']);
    try {
      mockGetGroupByName.mockImplementation(async () => ({
        id: 'g',
        name: 'platform',
        parent_path: '/old',
        created_at: new Date(),
      }));
      const app = makeApp();
      const res = await app.request('/api/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentPath: parent, name: 'platform' }),
      });
      expect(res.status).toBe(400);
      expect(mockCreateGroup).not.toHaveBeenCalled();
    } finally {
      safeRm(parent);
    }
  });

  test('201 on happy path with members', async () => {
    parent = makeParentWith(['svc-a', 'svc-b']);
    try {
      const app = makeApp();
      const res = await app.request('/api/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentPath: parent, name: 'platform' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        group: { name: string };
        summary: { relativePath: string; alreadyExisted: boolean }[];
      };
      expect(body.group.name).toBe('platform');
      expect(body.summary.map(s => s.relativePath).sort()).toEqual(['svc-a', 'svc-b']);
      expect(mockCreateGroup).toHaveBeenCalledTimes(1);
      expect(mockAddMember).toHaveBeenCalledTimes(2);
    } finally {
      safeRm(parent);
    }
  });
});

describe('DELETE /api/groups/:name', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockRemoveGroup.mockClear();
    mockListGroupWorktrees.mockClear();
    mockRemoveGroupWorktree.mockClear();
    mockListGroupWorktrees.mockImplementation(async () => []);
  });

  test('404 when group not found', async () => {
    mockGetGroupByName.mockImplementation(async () => null);
    const app = makeApp();
    const res = await app.request('/api/groups/missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mockRemoveGroup).not.toHaveBeenCalled();
  });

  test('200 when no worktrees exist', async () => {
    mockGetGroupByName.mockImplementation(async () => ({
      id: 'g1',
      name: 'platform',
      parent_path: '/dev/p',
      created_at: new Date(),
    }));
    const app = makeApp();
    const res = await app.request('/api/groups/platform', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockRemoveGroup).toHaveBeenCalledWith('g1');
  });

  test('422 when worktrees exist and ?withWorktrees is not set', async () => {
    mockGetGroupByName.mockImplementation(async () => ({
      id: 'g1',
      name: 'platform',
      parent_path: '/dev/p',
      created_at: new Date(),
    }));
    mockListGroupWorktrees.mockImplementation(async () => [
      { groupName: 'platform', branch: 'feat/x', path: '/p/x' },
    ]);
    const app = makeApp();
    const res = await app.request('/api/groups/platform', { method: 'DELETE' });
    expect(res.status).toBe(422);
    expect(mockRemoveGroup).not.toHaveBeenCalled();
  });

  test('200 with ?withWorktrees=true cascades cleanup', async () => {
    mockGetGroupByName.mockImplementation(async () => ({
      id: 'g1',
      name: 'platform',
      parent_path: '/dev/p',
      created_at: new Date(),
    }));
    mockListGroupWorktrees.mockImplementation(async () => [
      { groupName: 'platform', branch: 'feat/x', path: '/p/x' },
    ]);
    mockGetMembersForGroup.mockImplementation(async () => [
      { group_id: 'g1', codebase_id: 'cb-a', relative_path: 'svc-a' },
    ]);
    const app = makeApp();
    const res = await app.request('/api/groups/platform?withWorktrees=true', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(mockRemoveGroupWorktree).toHaveBeenCalledTimes(1);
    expect(mockRemoveGroup).toHaveBeenCalledWith('g1');
  });
});

describe('GET /api/groups/:name/worktrees', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockListGroupWorktrees.mockClear();
  });

  test('404 when group not found', async () => {
    mockGetGroupByName.mockImplementation(async () => null);
    const app = makeApp();
    const res = await app.request('/api/groups/missing/worktrees');
    expect(res.status).toBe(404);
  });

  test("returns only this group's worktrees", async () => {
    mockGetGroupByName.mockImplementation(async () => ({
      id: 'g1',
      name: 'platform',
      parent_path: '/dev/p',
      created_at: new Date(),
    }));
    mockListGroupWorktrees.mockImplementation(async () => [
      { groupName: 'platform', branch: 'feat/x', path: '/p/x' },
      { groupName: 'other', branch: 'feat/z', path: '/o/z' },
    ]);
    const app = makeApp();
    const res = await app.request('/api/groups/platform/worktrees');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worktrees: { branch: string }[] };
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]?.branch).toBe('feat/x');
  });
});

describe('DELETE /api/groups/:name/worktrees/:branch', () => {
  beforeEach(() => {
    mockGetGroupByName.mockClear();
    mockGetMembersForGroup.mockClear();
    mockGetCodebase.mockClear();
    mockRemoveGroupWorktree.mockClear();
  });

  test('404 when group not found', async () => {
    mockGetGroupByName.mockImplementation(async () => null);
    const app = makeApp();
    const res = await app.request('/api/groups/missing/worktrees/feat__x', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('200 when removed; passes resolved members', async () => {
    mockGetGroupByName.mockImplementation(async () => ({
      id: 'g1',
      name: 'platform',
      parent_path: '/dev/p',
      created_at: new Date(),
    }));
    mockGetMembersForGroup.mockImplementation(async () => [
      { group_id: 'g1', codebase_id: 'cb-a', relative_path: 'svc-a' },
    ]);
    const app = makeApp();
    const res = await app.request('/api/groups/platform/worktrees/feat__x', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockRemoveGroupWorktree).toHaveBeenCalledTimes(1);
    const args = mockRemoveGroupWorktree.mock.calls[0]!;
    expect(args[0]).toBe('platform');
    expect(args[1]).toBe('feat__x');
    expect(Array.isArray(args[2])).toBe(true);
  });
});
