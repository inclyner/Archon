/**
 * Zod schemas for workspace-group API endpoints.
 *
 * A workspace group is a non-git parent directory containing N sibling git
 * repositories (codebases). The web UI uses these endpoints to register
 * groups, list them, inspect members, and manage on-disk group worktrees.
 */
import { z } from '@hono/zod-openapi';

/** A single workspace group record. */
export const workspaceGroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    parent_path: z.string(),
    created_at: z.string(),
  })
  .openapi('WorkspaceGroup');

/** A single membership-junction row linking a group to one of its codebases. */
export const workspaceGroupMemberSchema = z
  .object({
    group_id: z.string(),
    codebase_id: z.string(),
    relative_path: z.string(),
  })
  .openapi('WorkspaceGroupMember');

/** GET /api/groups response. */
export const groupListResponseSchema = z
  .object({
    groups: z.array(workspaceGroupSchema),
  })
  .openapi('WorkspaceGroupListResponse');

/** GET /api/groups/:name response — group plus its members. */
export const groupDetailResponseSchema = z
  .object({
    group: workspaceGroupSchema,
    members: z.array(workspaceGroupMemberSchema),
  })
  .openapi('WorkspaceGroupDetailResponse');

/** Path params for /api/groups/:name. */
export const groupNameParamsSchema = z.object({ name: z.string() });

/** Path params for /api/groups/:name/worktrees/:branch. */
export const groupBranchParamsSchema = z.object({
  name: z.string(),
  branch: z.string(),
});

/** POST /api/groups body — register a new group from a parent directory. */
export const addGroupBodySchema = z
  .object({
    parentPath: z.string().min(1),
    name: z.string().min(1).optional(),
  })
  .openapi('AddWorkspaceGroupBody');

/** POST /api/groups per-member outcome. */
const addGroupMemberOutcomeSchema = z
  .object({
    relativePath: z.string(),
    codebaseId: z.string().nullable(),
    name: z.string().nullable(),
    alreadyExisted: z.boolean(),
    error: z.string().nullable(),
  })
  .openapi('AddWorkspaceGroupMemberOutcome');

/** POST /api/groups response — registered group + member outcomes summary. */
export const addGroupResponseSchema = z
  .object({
    group: workspaceGroupSchema,
    members: z.array(workspaceGroupMemberSchema),
    summary: z.array(addGroupMemberOutcomeSchema),
  })
  .openapi('AddWorkspaceGroupResponse');

/** DELETE /api/groups/:name response. */
export const deleteGroupResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteWorkspaceGroupResponse');

/** A single on-disk group-worktree entry. */
const listedGroupWorktreeSchema = z
  .object({
    groupName: z.string(),
    branch: z.string(),
    path: z.string(),
  })
  .openapi('ListedGroupWorktree');

/** GET /api/groups/:name/worktrees response. */
export const groupWorktreesResponseSchema = z
  .object({
    worktrees: z.array(listedGroupWorktreeSchema),
  })
  .openapi('WorkspaceGroupWorktreesResponse');

/** DELETE /api/groups/:name/worktrees/:branch response. */
export const deleteGroupWorktreeResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteWorkspaceGroupWorktreeResponse');

/** POST /api/groups/:name/run body. */
export const runGroupWorkflowBodySchema = z
  .object({
    workflowName: z.string().min(1),
    message: z.string(),
    conversationId: z.string().min(1),
  })
  .openapi('RunGroupWorkflowBody');

/** POST /api/groups/:name/run response. */
export const runGroupWorkflowResponseSchema = z
  .object({
    accepted: z.boolean(),
    groupName: z.string(),
    workflowName: z.string(),
    branch: z.string(),
    groupDir: z.string(),
    conversationId: z.string(),
    workflowRunId: z.string().nullable(),
  })
  .openapi('RunGroupWorkflowResponse');
