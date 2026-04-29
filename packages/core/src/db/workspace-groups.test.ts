import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { WorkspaceGroup, WorkspaceGroupMember } from '../types';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  createGroup,
  getGroupById,
  getGroupByName,
  listGroups,
  removeGroup,
  addMember,
  removeMember,
  getMembersForGroup,
} from './workspace-groups';

describe('workspace-groups', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const mockGroup: WorkspaceGroup = {
    id: 'group-123',
    name: 'my-platform',
    parent_path: '/home/user/dev/my-platform',
    created_at: new Date(),
  };

  const mockMember: WorkspaceGroupMember = {
    group_id: 'group-123',
    codebase_id: 'codebase-456',
    relative_path: 'service-api',
  };

  describe('createGroup', () => {
    test('inserts and returns the new group', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockGroup]));

      const result = await createGroup({
        name: 'my-platform',
        parent_path: '/home/user/dev/my-platform',
      });

      expect(result).toEqual(mockGroup);
      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO remote_agent_workspace_groups (name, parent_path) VALUES ($1, $2) RETURNING *',
        ['my-platform', '/home/user/dev/my-platform']
      );
    });

    test('throws if INSERT returns no row', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(createGroup({ name: 'my-platform', parent_path: '/p' })).rejects.toThrow(
        /no row returned/
      );
    });
  });

  describe('getGroupById', () => {
    test('returns the group when found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockGroup]));

      const result = await getGroupById('group-123');

      expect(result).toEqual(mockGroup);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_workspace_groups WHERE id = $1',
        ['group-123']
      );
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getGroupById('group-missing');

      expect(result).toBeNull();
    });
  });

  describe('getGroupByName', () => {
    test('returns the group when found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockGroup]));

      const result = await getGroupByName('my-platform');

      expect(result).toEqual(mockGroup);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_workspace_groups WHERE name = $1',
        ['my-platform']
      );
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getGroupByName('missing');

      expect(result).toBeNull();
    });
  });

  describe('listGroups', () => {
    test('returns all groups ordered by name', async () => {
      const second: WorkspaceGroup = { ...mockGroup, id: 'group-456', name: 'other-platform' };
      mockQuery.mockResolvedValueOnce(createQueryResult([mockGroup, second]));

      const result = await listGroups();

      expect(result).toEqual([mockGroup, second]);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_workspace_groups ORDER BY name ASC'
      );
    });

    test('returns empty array when no groups', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await listGroups();

      expect(result).toEqual([]);
    });
  });

  describe('removeGroup', () => {
    test('deletes by id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await removeGroup('group-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM remote_agent_workspace_groups WHERE id = $1',
        ['group-123']
      );
    });
  });

  describe('addMember', () => {
    test('inserts and returns the new membership', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMember]));

      const result = await addMember({
        group_id: 'group-123',
        codebase_id: 'codebase-456',
        relative_path: 'service-api',
      });

      expect(result).toEqual(mockMember);
      expect(mockQuery).toHaveBeenCalledWith(
        `INSERT INTO remote_agent_workspace_group_members (group_id, codebase_id, relative_path)
     VALUES ($1, $2, $3) RETURNING *`,
        ['group-123', 'codebase-456', 'service-api']
      );
    });

    test('throws if INSERT returns no row', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(
        addMember({ group_id: 'g', codebase_id: 'c', relative_path: 'r' })
      ).rejects.toThrow(/no row returned/);
    });
  });

  describe('removeMember', () => {
    test('deletes by composite key', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await removeMember('group-123', 'codebase-456');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM remote_agent_workspace_group_members WHERE group_id = $1 AND codebase_id = $2',
        ['group-123', 'codebase-456']
      );
    });
  });

  describe('getMembersForGroup', () => {
    test('returns members ordered by relative_path', async () => {
      const second: WorkspaceGroupMember = {
        ...mockMember,
        codebase_id: 'cb-2',
        relative_path: 'service-web',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMember, second]));

      const result = await getMembersForGroup('group-123');

      expect(result).toEqual([mockMember, second]);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_workspace_group_members
     WHERE group_id = $1
     ORDER BY relative_path ASC`,
        ['group-123']
      );
    });

    test('returns empty array when group has no members', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getMembersForGroup('group-empty');

      expect(result).toEqual([]);
    });
  });
});
