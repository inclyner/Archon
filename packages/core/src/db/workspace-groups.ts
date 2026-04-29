/**
 * Database operations for workspace groups.
 *
 * A workspace group is a non-git parent directory containing N sibling git
 * repositories (codebases). Workflow runs invoked with `--group <name>` use a
 * single AI session rooted at the group's parent dir, with each member repo
 * mounted as a git worktree underneath.
 */
import { pool } from './connection';
import type { QueryResult } from './adapters/types';
import type { WorkspaceGroup, WorkspaceGroupMember } from '../types';

/**
 * Query callable signature shared by `pool.query` and the per-call function
 * passed to `withTransaction`. Each helper below accepts one of these via the
 * trailing `query` arg so it can run either standalone (default = pool.query)
 * or inside a withTransaction block (caller passes the transactional query).
 *
 * Why optional rather than required: the standalone callers vastly outnumber
 * the transactional ones, and the existing test suite mocks `pool.query` —
 * keeping it as the default keeps those tests untouched.
 */
type QueryFn = <T>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

/**
 * Workspace group names must be safe to use as a directory segment under
 * `~/.archon/workspace-groups/<name>/`. We restrict to the same character
 * class as standard "name slug" patterns, anchored to start/end, with no
 * leading dot/dash/underscore (avoids hidden dirs and looks-like-flag CLI
 * confusion). Max 64 chars for sanity.
 *
 * Allowed: alphanumerics, dots, hyphens, underscores. Must start with an
 * alphanumeric. Must not contain `..` (path traversal).
 *
 * Returns `null` if valid, otherwise a human-readable rejection reason.
 */
const WORKSPACE_GROUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function validateWorkspaceGroupName(name: string): string | null {
  if (name?.trim() !== name) {
    return 'Group name cannot be empty or have leading/trailing whitespace.';
  }
  if (name.length > 64) {
    return `Group name "${name}" is longer than 64 characters.`;
  }
  if (name.includes('..')) {
    return `Group name "${name}" cannot contain ".." (path traversal).`;
  }
  if (!WORKSPACE_GROUP_NAME_RE.test(name)) {
    return (
      `Group name "${name}" must start with a letter or digit and contain only ` +
      'letters, digits, dots, hyphens, and underscores.'
    );
  }
  return null;
}

export async function createGroup(
  data: { name: string; parent_path: string },
  query: QueryFn = pool.query
): Promise<WorkspaceGroup> {
  const result = await query<WorkspaceGroup>(
    'INSERT INTO remote_agent_workspace_groups (name, parent_path) VALUES ($1, $2) RETURNING *',
    [data.name, data.parent_path]
  );
  if (!result.rows[0]) {
    throw new Error('Failed to create workspace group: INSERT succeeded but no row returned');
  }
  return result.rows[0];
}

export async function getGroupById(id: string): Promise<WorkspaceGroup | null> {
  const result = await pool.query<WorkspaceGroup>(
    'SELECT * FROM remote_agent_workspace_groups WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getGroupByName(name: string): Promise<WorkspaceGroup | null> {
  const result = await pool.query<WorkspaceGroup>(
    'SELECT * FROM remote_agent_workspace_groups WHERE name = $1',
    [name]
  );
  return result.rows[0] || null;
}

export async function listGroups(): Promise<readonly WorkspaceGroup[]> {
  const result = await pool.query<WorkspaceGroup>(
    'SELECT * FROM remote_agent_workspace_groups ORDER BY name ASC'
  );
  return result.rows;
}

export async function removeGroup(id: string): Promise<void> {
  // ON DELETE CASCADE on workspace_group_members removes the junction rows.
  await pool.query('DELETE FROM remote_agent_workspace_groups WHERE id = $1', [id]);
}

export async function addMember(
  data: { group_id: string; codebase_id: string; relative_path: string },
  query: QueryFn = pool.query
): Promise<WorkspaceGroupMember> {
  const result = await query<WorkspaceGroupMember>(
    `INSERT INTO remote_agent_workspace_group_members (group_id, codebase_id, relative_path)
     VALUES ($1, $2, $3) RETURNING *`,
    [data.group_id, data.codebase_id, data.relative_path]
  );
  if (!result.rows[0]) {
    throw new Error('Failed to add workspace group member: INSERT succeeded but no row returned');
  }
  return result.rows[0];
}

export async function removeMember(group_id: string, codebase_id: string): Promise<void> {
  await pool.query(
    'DELETE FROM remote_agent_workspace_group_members WHERE group_id = $1 AND codebase_id = $2',
    [group_id, codebase_id]
  );
}

export async function getMembersForGroup(
  group_id: string
): Promise<readonly WorkspaceGroupMember[]> {
  const result = await pool.query<WorkspaceGroupMember>(
    `SELECT * FROM remote_agent_workspace_group_members
     WHERE group_id = $1
     ORDER BY relative_path ASC`,
    [group_id]
  );
  return result.rows;
}
