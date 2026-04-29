-- Workspace groups: a non-git parent directory containing N sibling git repositories.
-- One AI session edits across all members; each commit lands in its own repo's git history.
-- See packages/core/src/db/workspace-groups.ts for query helpers.

CREATE TABLE IF NOT EXISTS remote_agent_workspace_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  parent_path  TEXT NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Many-to-many junction between groups and codebases. relative_path is the
-- subdirectory name under the group's parent_path (typically the basename of
-- the child repo).
CREATE TABLE IF NOT EXISTS remote_agent_workspace_group_members (
  group_id      UUID NOT NULL REFERENCES remote_agent_workspace_groups(id) ON DELETE CASCADE,
  codebase_id   UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  PRIMARY KEY (group_id, codebase_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_group_members_codebase
  ON remote_agent_workspace_group_members(codebase_id);
