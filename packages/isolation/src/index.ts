// --- Types ---
export type {
  IsolationProviderType,
  IsolationWorkflowType,
  EnvironmentStatus,
  IssueIsolationRequest,
  PRIsolationRequest,
  ReviewIsolationRequest,
  ThreadIsolationRequest,
  TaskIsolationRequest,
  IsolationRequest,
  AdoptedWorktreeMetadata,
  CreatedWorktreeMetadata,
  WorktreeMetadata,
  WorktreeEnvironment,
  IsolatedEnvironment,
  DestroyOptions,
  WorktreeDestroyOptions,
  DestroyResult,
  IIsolationProvider,
  IsolationHints,
  IsolationBlockReason,
  IsolationEnvironmentRow,
  WorktreeCreateConfig,
  RepoConfigLoader,
  WorktreeStatusBreakdown,
  CreateEnvironmentParams,
  ResolveRequest,
  ResolutionMethod,
  IsolationResolution,
} from './types';

export { isPRIsolationRequest } from './types';

// --- Store ---
export type { IIsolationStore } from './store';

// --- Errors ---
export { IsolationBlockedError, classifyIsolationError } from './errors';

// --- Factory ---
export { getIsolationProvider, configureIsolation, resetIsolationProvider } from './factory';

// --- Resolver ---
export { IsolationResolver } from './resolver';
export type { IsolationResolverDeps } from './resolver';

// --- Provider ---
export { WorktreeProvider } from './providers/worktree';

// --- PR state lookup ---
export { getPrState } from './pr-state';
export type { PrState } from './pr-state';

// --- Workspace groups ---
export { ensureBranchAcrossMembers, BranchCoherenceError } from './workspace-group-branch';
export type { BranchCoherenceMember, BranchCoherenceResult } from './workspace-group-branch';
export {
  createGroupWorktree,
  removeGroupWorktree,
  listGroupWorktrees,
  GroupWorktreeError,
} from './providers/workspace-group';
export type {
  GroupWorktreeMember,
  GroupWorktreeRequest,
  GroupWorktreeResult,
  ListedGroupWorktree,
} from './providers/workspace-group';

// --- Worktree copy utility ---
export {
  copyWorktreeFiles,
  copyWorktreeFile,
  parseCopyFileEntry,
  isPathWithinRoot,
} from './worktree-copy';
export type { CopyFileEntry } from './worktree-copy';
