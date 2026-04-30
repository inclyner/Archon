/**
 * Group-scoped chat support: every conversation that's tagged with a
 * workspace_group_id owns its own folder-level git worktree (one branch shared
 * across all group members), so parallel chats are fully isolated and the AI
 * session gets a single cwd containing all member repos as siblings.
 *
 * Branch naming: `chat-<8 hex chars from conversation.id>`. Deterministic so
 * reconnecting after a restart resolves to the same on-disk state.
 *
 * Lifecycle:
 *   - First message in a group conversation → createGroupWorktree.
 *   - Subsequent messages → return the existing groupDir (idempotent — we
 *     check existsSync before calling createGroupWorktree, since
 *     `git worktree add` fails if the target dir already exists).
 *   - Cleanup on conversation soft-delete is deferred — orphaned worktrees
 *     can be removed via `archon group cleanup`. Worth wiring properly once
 *     we've validated the basic flow works.
 */
import { existsSync } from 'fs';
import { createLogger } from '@archon/paths';
import { execFileAsync, getDefaultBranch, toRepoPath } from '@archon/git';
import { createGroupWorktree, type GroupWorktreeResult } from '@archon/isolation';
import { getWorkspaceGroupWorktreePath } from '@archon/paths';
import * as workspaceGroupDb from '../db/workspace-groups';
import * as codebaseDb from '../db/codebases';
import type { Conversation, WorkspaceGroup } from '../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.group-chat');
  return cachedLog;
}

export interface GroupChatContext {
  group: WorkspaceGroup;
  /** Branch shared across all members for this conversation's lifetime. */
  branch: string;
  /** The non-git outer dir containing all member worktrees. AI session cwd. */
  groupDir: string;
  /** Per-codebase resolved worktree dir (absolute path). */
  memberDirs: Record<string, string>;
}

/**
 * Derive the chat branch name from the conversation id. 8 hex chars from the
 * id is plenty of entropy for a single-developer tool — even a thousand
 * concurrent chats per group would have effectively zero collision risk.
 */
export function chatBranchForConversation(conversationId: string): string {
  // Strip dashes (Postgres UUIDs have them, SQLite ids don't) so the slice
  // operates on the same character class either way.
  const cleaned = conversationId.replace(/-/g, '').toLowerCase();
  return `chat-${cleaned.slice(0, 8)}`;
}

/**
 * Resolve or create the group worktree for a group-scoped conversation.
 *
 * Idempotent: safe to call on every message. Returns immediately if the
 * worktree dir already exists on disk; otherwise calls createGroupWorktree
 * (which itself rolls back partial state on failure).
 *
 * Throws if:
 *   - conversation has no workspace_group_id
 *   - the group is missing or has zero members
 *   - any member's codebase row is missing
 *   - createGroupWorktree fails (and rollback completes)
 */
export async function ensureGroupConversationWorktree(
  conversation: Conversation
): Promise<GroupChatContext> {
  if (!conversation.workspace_group_id) {
    throw new Error(
      'ensureGroupConversationWorktree called on a non-group conversation. ' +
        'Caller should check conversation.workspace_group_id first.'
    );
  }

  const group = await workspaceGroupDb.getGroupById(conversation.workspace_group_id);
  if (!group) {
    throw new Error(
      `Workspace group ${conversation.workspace_group_id} not found ` +
        `(referenced by conversation ${conversation.id}). The group was likely deleted; ` +
        'soft-delete this conversation or re-register the group.'
    );
  }

  const memberRows = await workspaceGroupDb.getMembersForGroup(group.id);
  if (memberRows.length === 0) {
    throw new Error(
      `Group "${group.name}" has no members. Re-register the group from ${group.parent_path}.`
    );
  }

  const branch = chatBranchForConversation(conversation.id);
  const expectedGroupDir = getWorkspaceGroupWorktreePath(group.name, branch);

  // Fast path: the worktree dir already exists from a previous message in
  // this conversation. Reconstruct the member-dir map from the on-disk layout
  // (same convention createGroupWorktree uses: <groupDir>/<member.relative_path>).
  if (existsSync(expectedGroupDir)) {
    const memberDirs: Record<string, string> = {};
    for (const m of memberRows) {
      memberDirs[m.codebase_id] = `${expectedGroupDir}/${m.relative_path}`.replace(/[/\\]+/g, '/');
    }
    getLog().debug(
      {
        conversationId: conversation.id,
        groupName: group.name,
        branch,
        groupDir: expectedGroupDir,
      },
      'group_chat.worktree_resolved_existing'
    );
    return { group, branch, groupDir: expectedGroupDir, memberDirs };
  }

  // Slow path: first message — materialize the worktree.
  const members = [];
  for (const m of memberRows) {
    const cb = await codebaseDb.getCodebase(m.codebase_id);
    if (!cb) {
      throw new Error(
        `Group member references missing codebase ${m.codebase_id} ` +
          `(relative_path="${m.relative_path}"). Re-register the group from ${group.parent_path}.`
      );
    }
    members.push({
      codebaseId: cb.id,
      sourceRepoPath: cb.default_cwd,
      relativePath: m.relative_path,
    });
  }

  // Pick the base branch from the first member's source repo. Same fallback
  // chain as setUpGroupRun (getDefaultBranch → main → master) so chat and
  // workflow runs share the same convention.
  const firstMemberPath = members[0].sourceRepoPath;
  let baseBranch: string;
  try {
    baseBranch = await getDefaultBranch(toRepoPath(firstMemberPath));
  } catch {
    try {
      await execFileAsync('git', ['-C', firstMemberPath, 'rev-parse', '--verify', 'main']);
      baseBranch = 'main';
    } catch {
      try {
        await execFileAsync('git', ['-C', firstMemberPath, 'rev-parse', '--verify', 'master']);
        baseBranch = 'master';
      } catch {
        throw new Error(
          `Could not detect a base branch in ${firstMemberPath}. ` +
            'Set origin/HEAD or have a local main/master branch.'
        );
      }
    }
  }

  getLog().info(
    {
      conversationId: conversation.id,
      groupName: group.name,
      branch,
      baseBranch,
      memberCount: members.length,
    },
    'group_chat.worktree_creating'
  );

  let result: GroupWorktreeResult;
  try {
    result = await createGroupWorktree({
      groupName: group.name,
      parentPath: group.parent_path,
      members,
      branch,
      baseBranch,
    });
  } catch (err) {
    getLog().error(
      { err, conversationId: conversation.id, groupName: group.name, branch },
      'group_chat.worktree_create_failed'
    );
    throw err;
  }

  return {
    group,
    branch,
    groupDir: result.groupDir,
    memberDirs: result.memberDirs,
  };
}
