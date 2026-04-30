-- Allow conversations to be scoped to a workspace group instead of a single
-- codebase. A conversation has at most one of codebase_id / workspace_group_id
-- set; mutual exclusion is enforced in application code (Postgres CHECK
-- constraints can't reference a fact-style FK target without a trigger, and a
-- trigger is overkill for a single-developer tool).
--
-- See: packages/core/src/db/conversations.ts (validateConversationScope)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS workspace_group_id UUID
  REFERENCES remote_agent_workspace_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_workspace_group
  ON remote_agent_conversations(workspace_group_id)
  WHERE deleted_at IS NULL;
