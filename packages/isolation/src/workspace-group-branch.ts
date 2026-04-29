/**
 * Branch coherence across N repositories.
 *
 * For workspace groups we need the same branch name to exist in every member
 * repo before we can `git worktree add` in each. This helper creates the
 * branch in each repo where it's missing, and rolls back any branches it
 * created if a later member fails — so we never leave a partial state.
 */
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.workspace-group');
  return cachedLog;
}

export interface BranchCoherenceMember {
  codebaseId: string;
  sourceRepoPath: string;
}

export interface BranchCoherenceResult {
  /** Repos where we just created the branch. */
  created: BranchCoherenceMember[];
  /** Repos where the branch already existed and we didn't touch it. */
  alreadyExisted: BranchCoherenceMember[];
}

export class BranchCoherenceError extends Error {
  constructor(
    message: string,
    readonly failedAt: BranchCoherenceMember,
    readonly cause: Error
  ) {
    super(message);
    this.name = 'BranchCoherenceError';
  }
}

/**
 * Check whether `branch` exists in `repoPath`.
 *
 * Implementation note: `git show-ref --verify --quiet refs/heads/<branch>`
 * exits 0 if the branch exists, non-zero otherwise. We treat *any* non-zero
 * exit as "doesn't exist," matching the existing checkout() helper's
 * tolerance of expected git errors.
 */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Create `branch` (from `baseBranch`) in `repoPath` if it doesn't already exist.
 * Returns true if we created it, false if it was already there.
 */
async function createBranchIfMissing(
  repoPath: string,
  branch: string,
  baseBranch: string
): Promise<boolean> {
  if (await branchExists(repoPath, branch)) {
    return false;
  }
  await execFileAsync('git', ['-C', repoPath, 'branch', branch, baseBranch], {
    timeout: 30000,
  });
  return true;
}

/**
 * Best-effort delete of `branch` in `repoPath`. Used only by rollback —
 * swallows failures with a warn log because the original error from the
 * failing create is what the caller needs to see.
 */
async function deleteBranchBestEffort(
  repoPath: string,
  branch: string,
  context: { reason: string }
): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branch], { timeout: 10000 });
  } catch (err) {
    getLog().warn({ repoPath, branch, err, ...context }, 'workspace_group.branch_rollback_failed');
  }
}

/**
 * Ensure `branch` exists in every member's source repo, creating it from
 * `baseBranch` where missing. If creation fails on any member, rolls back
 * (deletes) every branch we created in this call before re-throwing.
 *
 * Note on baseBranch: this is the branch name to create from — typically the
 * default branch of the source repo. We accept it as a single string applied
 * uniformly across all members; if members have different default branches
 * (rare for a workspace group), the caller can resolve them upstream and we
 * may extend this signature later. Personal-use scope = uniform baseBranch.
 */
export async function ensureBranchAcrossMembers(
  members: readonly BranchCoherenceMember[],
  branch: string,
  baseBranch: string
): Promise<BranchCoherenceResult> {
  const created: BranchCoherenceMember[] = [];
  const alreadyExisted: BranchCoherenceMember[] = [];

  for (const member of members) {
    try {
      const wasCreated = await createBranchIfMissing(member.sourceRepoPath, branch, baseBranch);
      if (wasCreated) {
        created.push(member);
      } else {
        alreadyExisted.push(member);
      }
    } catch (err) {
      const error = err as Error;
      getLog().error(
        { repoPath: member.sourceRepoPath, branch, baseBranch, err: error },
        'workspace_group.branch_create_failed'
      );

      // Roll back: delete every branch we created in this call.
      for (const rb of created) {
        await deleteBranchBestEffort(rb.sourceRepoPath, branch, { reason: 'rollback' });
      }

      throw new BranchCoherenceError(
        `Failed to create branch "${branch}" in ${member.sourceRepoPath}: ${error.message}`,
        member,
        error
      );
    }
  }

  return { created, alreadyExisted };
}
