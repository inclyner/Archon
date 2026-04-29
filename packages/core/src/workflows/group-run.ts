/**
 * Shared setup for running a workflow against a registered workspace group.
 *
 * Both the CLI (archon workflow run --group <name>) and the server endpoint
 * (POST /api/workflows/:name/run-group) need the same sequence:
 *
 *   1. Look up the group and its members.
 *   2. Resolve each member's source repo path via the codebases table.
 *   3. Detect a base branch from the first member.
 *   4. Generate a branch name.
 *   5. Create the group worktree on disk (N git worktrees + parent file copy).
 *   6. Pre-substitute $GROUP / $GROUP_DIR / $REPOS / $REPO_<NAME>_DIR into
 *      every node's prompt/bash/script/command field.
 *
 * This module returns everything the caller needs to invoke executeWorkflow
 * and stream events. The platform-specific bits (adapter, conversation
 * creation, event subscription, post-run side effects like --auto-pr) stay
 * with the caller.
 */
import { execFileAsync, getDefaultBranch, toRepoPath } from '@archon/git';
import { createGroupWorktree, type GroupWorktreeResult } from '@archon/isolation';
import {
  applyGroupSubstitutionsToWorkflow,
  type GroupSubstitutionContext,
} from '@archon/workflows/utils/group-substitution';
import type {
  WorkflowDefinition,
  WorkflowExecutionResult,
} from '@archon/workflows/schemas/workflow';
import { executeWorkflow } from '@archon/workflows/executor';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';
import * as workspaceGroupDb from '../db/workspace-groups';
import * as codebaseDb from '../db/codebases';
import type { WorkspaceGroup } from '../types';
import { createWorkflowDeps } from './store-adapter';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('core.group-run');
  return cachedLog;
}

export interface GroupRunMember {
  codebaseId: string;
  sourceRepoPath: string;
  relativePath: string;
}

export interface GroupRunSetup {
  group: WorkspaceGroup;
  members: GroupRunMember[];
  branch: string;
  baseBranch: string;
  worktree: GroupWorktreeResult;
  groupContext: GroupSubstitutionContext;
  /** Workflow definition with group vars pre-substituted. Pass this — not the original — to executeWorkflow. */
  resolvedWorkflow: WorkflowDefinition;
}

export interface SetUpGroupRunOpts {
  groupName: string;
  workflowName: string;
  workflow: WorkflowDefinition;
  /**
   * Optional explicit branch name. When omitted, generates `<workflowName>-<timestamp>`
   * (matching the single-repo convention).
   */
  branch?: string;
}

/**
 * Validates the group + members, creates the on-disk worktree, and pre-substitutes
 * the workflow definition. The returned `resolvedWorkflow` is what the caller
 * should hand to executeWorkflow; cwd should be `setup.worktree.groupDir`.
 *
 * Throws on:
 *  - unknown group
 *  - empty group (no members)
 *  - missing codebase row referenced by a member junction
 *  - any failure inside createGroupWorktree (which itself rolls back partial state)
 */
export async function setUpGroupRun(opts: SetUpGroupRunOpts): Promise<GroupRunSetup> {
  const { groupName, workflowName, workflow } = opts;

  const group = await workspaceGroupDb.getGroupByName(groupName);
  if (!group) {
    throw new Error(
      `No workspace group named "${groupName}". Register it first via the CLI or POST /api/groups.`
    );
  }

  const memberRows = await workspaceGroupDb.getMembersForGroup(group.id);
  if (memberRows.length === 0) {
    throw new Error(
      `Group "${groupName}" has no members. Re-register the group from ${group.parent_path}.`
    );
  }

  const members: GroupRunMember[] = [];
  for (const m of memberRows) {
    const cb = await codebaseDb.getCodebase(m.codebase_id);
    if (!cb) {
      throw new Error(
        `Group member references missing codebase ${m.codebase_id} ` +
          `(relative_path="${m.relative_path}"). The codebase row was likely deleted out ` +
          `from under the group. Re-register the group from ${group.parent_path}.`
      );
    }
    members.push({
      codebaseId: cb.id,
      sourceRepoPath: cb.default_cwd,
      relativePath: m.relative_path,
    });
  }

  // Pick a base branch from the first member.
  //
  // Detection chain:
  //   1. getDefaultBranch (reads origin/HEAD symbolic-ref)
  //   2. local 'main' branch
  //   3. local 'master' branch (older convention; common for cloned-from-template repos)
  //   4. throw with a clear message — no silent fallback
  //
  // Why try local refs before failing: a cloned-from-template repo often has
  // no origin/HEAD set, so getDefaultBranch fails. The repo still has a local
  // 'main' or 'master'. Silently falling back to 'main' meant `git branch <new>
  // main` would fail later with a confusing "main is not a valid object name"
  // error deep inside the worktree provider.
  const firstMemberPath = members[0].sourceRepoPath;
  let baseBranch: string | null = null;
  try {
    baseBranch = await getDefaultBranch(toRepoPath(firstMemberPath));
  } catch (err) {
    getLog().debug(
      { err: err as Error, sourceRepoPath: firstMemberPath },
      'core.group_run.default_branch_detect_failed'
    );
  }
  if (!baseBranch) {
    for (const candidate of ['main', 'master']) {
      try {
        await execFileAsync(
          'git',
          ['-C', firstMemberPath, 'rev-parse', '--verify', `refs/heads/${candidate}`],
          { timeout: 10000 }
        );
        baseBranch = candidate;
        break;
      } catch {
        // try next candidate
      }
    }
  }
  if (!baseBranch) {
    throw new Error(
      `Could not detect a base branch for group "${groupName}". The first member ` +
        `(${firstMemberPath}) has no origin/HEAD symbolic-ref and no local 'main' or ` +
        "'master' branch. Set worktree.baseBranch in .archon/config.yaml or pass an " +
        'explicit branch via the API/CLI.'
    );
  }

  const branch = opts.branch ?? `${workflowName}-${String(Date.now())}`;

  const worktree = await createGroupWorktree({
    groupName: group.name,
    parentPath: group.parent_path,
    members,
    branch,
    baseBranch,
  });

  const groupContext: GroupSubstitutionContext = {
    groupName: group.name,
    groupDir: worktree.groupDir,
    members: members.map(m => ({
      relativePath: m.relativePath,
      memberDir: worktree.memberDirs[m.codebaseId] ?? '',
    })),
  };
  const resolvedWorkflow = applyGroupSubstitutionsToWorkflow(workflow, groupContext);

  return {
    group,
    members,
    branch,
    baseBranch,
    worktree,
    groupContext,
    resolvedWorkflow,
  };
}

export interface RunGroupWorkflowOpts {
  groupName: string;
  workflowName: string;
  workflow: WorkflowDefinition;
  platform: IWorkflowPlatform;
  /** Platform conversation ID (the SSE/chat key). */
  conversationId: string;
  /** Database conversation row ID. */
  conversationDbId: string;
  userMessage: string;
  /** Optional explicit branch (else auto-generated). Forwarded to setUpGroupRun. */
  branch?: string;
  /**
   * Optional callback after worktree + substitution succeed but before
   * executeWorkflow runs. Use this for caller-specific announcements
   * (CLI prints `console.log`, orchestrator sends a platform message).
   */
  onSetupComplete?: (setup: GroupRunSetup) => Promise<void> | void;
}

export interface RunGroupWorkflowResult {
  setup: GroupRunSetup;
  result: WorkflowExecutionResult;
}

/**
 * setUpGroupRun → onSetupComplete → executeWorkflow, in that order.
 *
 * Wraps the platform-agnostic core of "run a workflow against a registered
 * workspace group." Both the CLI's runWorkflowAgainstGroup and the
 * orchestrator's handleGroupWorkflowRunCommand call this so they can't drift
 * on the actual setup + execute sequence.
 *
 * Caller responsibilities (kept outside this helper):
 *   - Conversation creation/lookup (the IDs are inputs to this helper).
 *   - Event subscriptions / SSE bridge wiring.
 *   - Platform-specific announcements (use onSetupComplete for "before run"
 *     output and inspect the returned `setup` for "after run" output like
 *     auto-pr).
 *   - Failure surface beyond what executeWorkflow returns (e.g. CLI's
 *     `Worktree left in place at ...` line).
 *
 * Errors:
 *   - setUpGroupRun failures bubble up unchanged so callers can format the
 *     "set up failed" message in their own dialect.
 *   - executeWorkflow returns a result object (with success: boolean); we
 *     pass it through. We don't translate failures into thrown errors.
 */
export async function runGroupWorkflow(
  opts: RunGroupWorkflowOpts
): Promise<RunGroupWorkflowResult> {
  const setup = await setUpGroupRun({
    groupName: opts.groupName,
    workflowName: opts.workflowName,
    workflow: opts.workflow,
    branch: opts.branch,
  });

  if (opts.onSetupComplete) {
    await opts.onSetupComplete(setup);
  }

  const result = await executeWorkflow(
    createWorkflowDeps(),
    opts.platform,
    opts.conversationId,
    setup.worktree.groupDir,
    setup.resolvedWorkflow,
    opts.userMessage,
    opts.conversationDbId
    // No codebaseId for group runs — per-codebase env vars and isolation env
    // tracking don't apply at group scope.
  );

  return { setup, result };
}
