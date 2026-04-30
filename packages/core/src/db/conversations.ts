/**
 * Database operations for conversations
 */
import { pool, getDialect } from './connection';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';
import { createLogger } from '@archon/paths';

/**
 * Guard that codebase_id and workspace_group_id are not BOTH set on the same
 * conversation. We don't add a DB CHECK constraint for this — Postgres can't
 * easily enforce "at most one of these FKs is set" without a trigger, and a
 * trigger is heavyweight for a single-developer tool. The two writes that can
 * set these columns (insert + update) both call this helper.
 */
export function validateConversationScope(input: {
  codebaseId?: string | null;
  workspaceGroupId?: string | null;
}): void {
  if (input.codebaseId && input.workspaceGroupId) {
    throw new Error(
      'Conversation cannot be scoped to both a codebase and a workspace group. Pick one.'
    );
  }
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.conversations');
  return cachedLog;
}

/**
 * Get a conversation by its database ID
 */
export async function getConversationById(id: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find a conversation by platform_conversation_id only (no platform_type filter).
 * Safe because all platform IDs are globally unique (they include platform prefix + timestamp + random).
 * Used by the Web UI API to load conversations from any platform.
 */
export async function findConversationByPlatformId(
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
    [platformId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get a conversation by platform type and platform ID
 * Returns null if not found (unlike getOrCreate which creates)
 */
export async function getConversationByPlatformId(
  platformType: string,
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );
  return result.rows[0] ?? null;
}

export async function getOrCreateConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string,
  parentConversationId?: string,
  workspaceGroupId?: string
): Promise<Conversation> {
  validateConversationScope({ codebaseId, workspaceGroupId });

  const existing = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  // Check if we should inherit from a parent conversation (e.g., Discord thread inheriting from parent channel)
  let inheritedCodebaseId: string | null = null;
  let inheritedWorkspaceGroupId: string | null = null;
  let inheritedCwd: string | null = null;
  let assistantType = process.env.DEFAULT_AI_ASSISTANT ?? 'claude';

  if (parentConversationId) {
    const parent = await pool.query<Conversation>(
      'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
      [platformType, parentConversationId]
    );
    if (parent.rows[0]) {
      inheritedCodebaseId = parent.rows[0].codebase_id ?? null;
      inheritedWorkspaceGroupId = parent.rows[0].workspace_group_id ?? null;
      inheritedCwd = parent.rows[0].cwd ?? null;
      assistantType = parent.rows[0].ai_assistant_type;
      getLog().debug(
        { inheritedCodebaseId, inheritedWorkspaceGroupId, inheritedCwd },
        'db.conversation_parent_context_inherited'
      );
    }
  }

  // Caller-provided scope wins over inherited. The two are mutually exclusive
  // (validated above) so we don't need to clear the other when one is set.
  const finalCodebaseId = codebaseId ?? (workspaceGroupId ? null : inheritedCodebaseId);
  const finalWorkspaceGroupId = workspaceGroupId ?? (codebaseId ? null : inheritedWorkspaceGroupId);

  // Determine assistant type from codebase if provided (overrides inherited).
  // Group-scoped conversations fall back to the env default — no per-group
  // assistant override yet (deferred to a later phase).
  if (codebaseId) {
    const codebase = await pool.query<{ ai_assistant_type: string }>(
      'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
      [codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = codebase.rows[0].ai_assistant_type;
    }
  }

  const created = await pool.query<Conversation>(
    'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, workspace_group_id, cwd) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [platformType, platformId, assistantType, finalCodebaseId, finalWorkspaceGroupId, inheritedCwd]
  );

  return created.rows[0];
}

export async function updateConversation(
  id: string,
  updates: Partial<
    Pick<Conversation, 'codebase_id' | 'workspace_group_id' | 'cwd' | 'isolation_env_id'>
  > & {
    hidden?: boolean;
  }
): Promise<void> {
  validateConversationScope({
    codebaseId: updates.codebase_id,
    workspaceGroupId: updates.workspace_group_id,
  });

  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.workspace_group_id !== undefined) {
    fields.push(`workspace_group_id = $${String(i++)}`);
    values.push(updates.workspace_group_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }
  if (updates.hidden !== undefined) {
    fields.push(`hidden = $${String(i++)}`);
    values.push(updates.hidden ? 1 : 0);
  }

  if (fields.length === 0) {
    return; // No updates
  }

  const dialect = getDialect();
  fields.push(`updated_at = ${dialect.now()}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );

  if (result.rowCount === 0) {
    getLog().error({ conversationId: id, fields, updates }, 'db.conversation_update_not_found');
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Find a conversation by isolation environment ID (legacy - single result)
 * Used for provider-based lookup and shared environment detection
 */
export async function getConversationByIsolationEnvId(envId: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1 LIMIT 1',
    [envId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all conversations using a specific isolation environment (new UUID model)
 */
export async function getConversationsByIsolationEnvId(
  envId: string
): Promise<readonly Conversation[]> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows;
}

/**
 * List all conversations ordered by recent activity. Optional scope filters
 * (codebaseId, workspaceGroupId) are mutually exclusive at the data level —
 * passing both will return zero rows because conversations only ever have one
 * of the two set, so we don't validate it here.
 */
export async function listConversations(
  limit = 50,
  platformType?: string,
  codebaseId?: string,
  excludeEmpty = false,
  workspaceGroupId?: string
): Promise<readonly Conversation[]> {
  const params: unknown[] = [];
  let sql =
    'SELECT * FROM remote_agent_conversations WHERE deleted_at IS NULL AND (hidden IS NULL OR hidden = false)';

  if (excludeEmpty) {
    sql +=
      ' AND (title IS NOT NULL OR EXISTS (SELECT 1 FROM remote_agent_messages WHERE conversation_id = remote_agent_conversations.id LIMIT 1))';
  }

  if (platformType) {
    params.push(platformType);
    sql += ` AND platform_type = $${String(params.length)}`;
  }

  if (codebaseId) {
    params.push(codebaseId);
    sql += ` AND codebase_id = $${String(params.length)}`;
  }

  if (workspaceGroupId) {
    params.push(workspaceGroupId);
    sql += ` AND workspace_group_id = $${String(params.length)}`;
  }

  sql += ' ORDER BY last_activity_at DESC NULLS LAST';
  params.push(limit);
  sql += ` LIMIT $${String(params.length)}`;

  const result = await pool.query<Conversation>(sql, params);
  return result.rows;
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_conversations SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/**
 * Update conversation title
 */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET title = $1, updated_at = ${dialect.now()} WHERE id = $2`,
    [title, id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Soft delete a conversation (sets deleted_at timestamp)
 */
export async function softDeleteConversation(id: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET deleted_at = ${dialect.now()}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}
