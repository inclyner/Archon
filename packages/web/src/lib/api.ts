/**
 * API client functions for the Archon Web UI.
 * Uses relative URLs - Vite proxy handles routing in dev.
 * SSE streams bypass the proxy in dev mode (Vite proxy buffers SSE responses).
 */
import type { WorkflowRunStatus } from '@/lib/types';
import type { components } from '@/lib/api.generated';

export type WorkflowDefinition = components['schemas']['WorkflowDefinition'];
export type DagNode = components['schemas']['DagNode'];

/**
 * Base URL for SSE streams. In dev, bypasses Vite proxy by connecting directly
 * to the backend server. In production, uses relative URLs (same origin).
 * Uses the page hostname so it works from any network interface.
 */
const apiPort = (import.meta.env.VITE_API_PORT as string | undefined) ?? '3090';
export const SSE_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:${apiPort}`
  : '';

export { getCodebaseInput } from '@/lib/codebase-input';

export interface ConversationResponse {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  workspace_group_id: string | null;
  cwd: string | null;
  ai_assistant_type: string;
  title: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodebaseResponse {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
  ai_assistant_type: string;
  commands: Record<string, { path: string; description: string }>;
  created_at: string;
  updated_at: string;
}

export interface HealthResponse {
  status: string;
  adapter: string;
  concurrency: {
    active: number;
    queuedTotal: number;
    maxConcurrent: number;
  };
  runningWorkflows: number;
  version?: string;
  is_docker: boolean;
  activePlatforms?: string[];
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const path = new URL(url, window.location.origin).pathname;
    const error = new Error(`API error ${String(res.status)} (${path}): ${truncated}`);
    (error as Error & { status: number }).status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

// Providers
export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  builtIn: boolean;
}

export type ProviderDefaults = Record<string, unknown>;

export interface SafeConfigResponse {
  botName: string;
  assistant: string;
  assistants: Record<string, ProviderDefaults>;
  streaming: {
    telegram: 'stream' | 'batch';
    discord: 'stream' | 'batch';
    slack: 'stream' | 'batch';
  };
  concurrency: {
    maxConversations: number;
  };
  defaults: {
    copyDefaults: boolean;
    loadDefaultCommands: boolean;
    loadDefaultWorkflows: boolean;
  };
}

export interface UpdateAssistantConfigBody {
  assistant?: string;
  assistants?: Record<string, ProviderDefaults>;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const data = await fetchJSON<{ providers: ProviderInfo[] }>('/api/providers');
  return data.providers;
}

// Conversations
export async function listConversations(
  codebaseId?: string,
  workspaceGroupId?: string
): Promise<ConversationResponse[]> {
  const params = new URLSearchParams();
  if (codebaseId) params.set('codebaseId', codebaseId);
  if (workspaceGroupId) params.set('workspaceGroupId', workspaceGroupId);
  const qs = params.toString();
  return fetchJSON<ConversationResponse[]>(`/api/conversations${qs ? `?${qs}` : ''}`);
}

export async function createConversation(
  codebaseId?: string,
  message?: string,
  workspaceGroupId?: string
): Promise<{ conversationId: string; id: string; dispatched?: boolean }> {
  const body: Record<string, string> = {};
  if (codebaseId) body.codebaseId = codebaseId;
  if (workspaceGroupId) body.workspaceGroupId = workspaceGroupId;
  if (message) body.message = message;

  return fetchJSON('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function updateConversation(
  id: string,
  updates: { title?: string }
): Promise<{ success: boolean }> {
  return fetchJSON(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export async function deleteConversation(id: string): Promise<{ success: boolean }> {
  return fetchJSON(`/api/conversations/${id}`, { method: 'DELETE' });
}

export async function sendMessage(
  conversationId: string,
  message: string,
  files?: File[]
): Promise<{ accepted: boolean; status: string }> {
  const url = `/api/conversations/${encodeURIComponent(conversationId)}/message`;

  if (!files || files.length === 0) {
    return fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }

  const form = new FormData();
  form.append('message', message);
  for (const file of files) {
    form.append('files', file, file.name);
  }
  // No Content-Type header — browser sets multipart/form-data with boundary automatically
  return fetchJSON(url, { method: 'POST', body: form });
}

// Messages
export interface MessageResponse {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: string;
  created_at: string;
}

export async function getMessages(conversationId: string, limit = 200): Promise<MessageResponse[]> {
  return fetchJSON<MessageResponse[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${String(limit)}`
  );
}

// Codebases
export async function listCodebases(): Promise<CodebaseResponse[]> {
  return fetchJSON<CodebaseResponse[]>('/api/codebases');
}

export async function getCodebase(id: string): Promise<CodebaseResponse> {
  return fetchJSON<CodebaseResponse>(`/api/codebases/${id}`);
}

export async function addCodebase(
  input: { url: string } | { path: string }
): Promise<CodebaseResponse> {
  return fetchJSON<CodebaseResponse>('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteCodebase(id: string): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(`/api/codebases/${id}`, { method: 'DELETE' });
}

// Workspace groups
//
// A workspace group is a non-git parent directory containing N sibling git
// repositories. The web UI uses these endpoints to register groups, browse
// them, manage on-disk worktrees, and (in B3) launch workflow runs.

export interface WorkspaceGroupResponse {
  id: string;
  name: string;
  parent_path: string;
  created_at: string;
}

export interface WorkspaceGroupMemberResponse {
  group_id: string;
  codebase_id: string;
  relative_path: string;
}

export interface WorkspaceGroupRegisterMemberOutcome {
  relativePath: string;
  codebaseId: string | null;
  name: string | null;
  alreadyExisted: boolean;
  error: string | null;
}

export interface WorkspaceGroupRegisterResponse {
  group: WorkspaceGroupResponse;
  members: WorkspaceGroupMemberResponse[];
  summary: WorkspaceGroupRegisterMemberOutcome[];
}

export interface WorkspaceGroupDetailResponse {
  group: WorkspaceGroupResponse;
  members: WorkspaceGroupMemberResponse[];
}

export interface ListedGroupWorktreeResponse {
  groupName: string;
  branch: string;
  path: string;
}

export async function listWorkspaceGroups(): Promise<WorkspaceGroupResponse[]> {
  const data = await fetchJSON<{ groups: WorkspaceGroupResponse[] }>('/api/groups');
  return data.groups;
}

export async function getWorkspaceGroup(name: string): Promise<WorkspaceGroupDetailResponse> {
  return fetchJSON<WorkspaceGroupDetailResponse>(`/api/groups/${encodeURIComponent(name)}`);
}

export async function registerWorkspaceGroup(input: {
  parentPath: string;
  name?: string;
}): Promise<WorkspaceGroupRegisterResponse> {
  return fetchJSON<WorkspaceGroupRegisterResponse>('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteWorkspaceGroup(
  name: string,
  options: { withWorktrees?: boolean; discardUncommitted?: boolean } = {}
): Promise<{ success: boolean }> {
  const params = new URLSearchParams();
  if (options.withWorktrees) params.set('withWorktrees', 'true');
  if (options.discardUncommitted) params.set('discardUncommitted', 'true');
  const qs = params.toString();
  return fetchJSON<{ success: boolean }>(
    `/api/groups/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`,
    { method: 'DELETE' }
  );
}

export async function listWorkspaceGroupWorktrees(
  name: string
): Promise<ListedGroupWorktreeResponse[]> {
  const data = await fetchJSON<{ worktrees: ListedGroupWorktreeResponse[] }>(
    `/api/groups/${encodeURIComponent(name)}/worktrees`
  );
  return data.worktrees;
}

export async function deleteWorkspaceGroupWorktree(
  name: string,
  branch: string
): Promise<{ success: boolean }> {
  // Branch names are passed as recorded on disk (slashes already flattened to __).
  return fetchJSON<{ success: boolean }>(
    `/api/groups/${encodeURIComponent(name)}/worktrees/${encodeURIComponent(branch)}`,
    { method: 'DELETE' }
  );
}

export interface ConversationDetail {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  workspace_group_id: string | null;
  cwd: string | null;
  isolation_env_id: string | null;
  ai_assistant_type: string;
  title: string | null;
  hidden: boolean;
  deleted_at: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Look up a conversation by its platform conversation id (URL param). */
export async function getConversation(platformId: string): Promise<ConversationDetail> {
  return fetchJSON<ConversationDetail>(`/api/conversations/${encodeURIComponent(platformId)}`);
}

// ─── Slack inbox + Jira issue creation ──────────────────────────────────────

export interface SlackConfigStatus {
  configured: boolean;
  hasToken: boolean;
  tokenSource: 'db' | 'env' | 'none';
  channelIds: string[];
  pollIntervalSeconds: number;
  defaultJiraProjectKey: string | null;
}

export interface SlackMessage {
  id: string;
  channelId: string;
  channelName: string;
  ts: string;
  timestamp: string;
  userId: string | null;
  userDisplay: string;
  text: string;
  permalink: string;
}

export async function getSlackConfig(): Promise<SlackConfigStatus> {
  return fetchJSON<SlackConfigStatus>('/api/settings/slack');
}

export async function saveSlackConfig(input: {
  token?: string;
  channelIds?: string[];
  pollIntervalSeconds?: number;
  defaultJiraProjectKey?: string;
}): Promise<SlackConfigStatus> {
  return fetchJSON<SlackConfigStatus>('/api/settings/slack', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function clearSlackConfig(): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>('/api/settings/slack', { method: 'DELETE' });
}

export async function testSlackConnection(): Promise<{
  ok: boolean;
  teamName?: string;
  botName?: string;
  error?: string;
}> {
  return fetchJSON('/api/slack/test', { method: 'POST' });
}

export async function listSlackMessages(): Promise<{ messages: SlackMessage[] }> {
  return fetchJSON<{ messages: SlackMessage[] }>('/api/slack/messages');
}

export interface JiraProjectSummary {
  id: string;
  key: string;
  name: string;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

export interface JiraIssueDetail {
  key: string;
  summary: string;
  status: string;
  statusCategory: 'todo' | 'inprogress' | 'done' | 'unknown';
  url: string;
  projectKey: string;
  issueType: string;
  priority: string | null;
  reporter: { name: string; accountId: string } | null;
  assignee: { name: string; accountId: string } | null;
  labels: string[];
  created: string;
  updated: string;
  description: AdfNode | null;
}

export interface JiraCommentResponse {
  id: string;
  author: { name: string; accountId: string } | null;
  body: AdfNode | null;
  created: string;
  updated: string;
}

export async function getJiraIssueDetail(
  key: string
): Promise<{ issue: JiraIssueDetail; comments: JiraCommentResponse[] }> {
  return fetchJSON(`/api/jira/issues/${encodeURIComponent(key)}`);
}

export async function listJiraProjects(): Promise<{ projects: JiraProjectSummary[] }> {
  return fetchJSON<{ projects: JiraProjectSummary[] }>('/api/jira/projects');
}

export interface JiraCreatedIssue {
  id: string;
  key: string;
  url: string;
}

export async function createJiraIssue(input: {
  summary: string;
  description: string;
  projectKey?: string;
}): Promise<JiraCreatedIssue> {
  return fetchJSON<JiraCreatedIssue>('/api/jira/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// ─── Jira (Phase D) ──────────────────────────────────────────────────────────

export interface JiraConfigStatus {
  configured: boolean;
  host: string | null;
  email: string | null;
  hasToken: boolean;
  source: 'db' | 'env' | 'none';
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  statusCategory: 'todo' | 'inprogress' | 'done' | 'unknown';
  url: string;
  projectKey: string;
  updated: string;
  assigneeName: string | null;
}

export async function getJiraConfig(): Promise<JiraConfigStatus> {
  return fetchJSON<JiraConfigStatus>('/api/settings/jira');
}

export async function saveJiraConfig(input: {
  host: string;
  email: string;
  token: string;
}): Promise<JiraConfigStatus> {
  return fetchJSON<JiraConfigStatus>('/api/settings/jira', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function clearJiraConfig(): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>('/api/settings/jira', { method: 'DELETE' });
}

export async function testJiraConnection(): Promise<{
  ok: boolean;
  accountId?: string;
  displayName?: string;
  error?: string;
}> {
  return fetchJSON('/api/jira/test', { method: 'POST' });
}

export async function listJiraTickets(): Promise<{ tickets: JiraTicket[] }> {
  return fetchJSON<{ tickets: JiraTicket[] }>('/api/jira/tickets');
}

// ─── Per-conversation dev servers (Phase C) ─────────────────────────────────

export interface DevServerStatus {
  codebaseId: string;
  label: string;
  port: number;
  pid: number | null;
  state: 'starting' | 'ready' | 'crashed' | 'stopped';
  url: string;
  logTail: string[];
  message: string | null;
}

export interface DevServerStartResponse {
  servers: DevServerStatus[];
  skipped: { codebaseId: string; relativePath: string; reason: string }[];
  groupDir: string;
}

export async function startConversationDevServers(
  conversationId: string
): Promise<DevServerStartResponse> {
  return fetchJSON<DevServerStartResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/dev-servers/start`,
    { method: 'POST' }
  );
}

export async function stopConversationDevServers(
  conversationId: string
): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/dev-servers/stop`,
    { method: 'POST' }
  );
}

export async function getConversationDevServerStatus(
  conversationId: string
): Promise<{ servers: DevServerStatus[] }> {
  return fetchJSON<{ servers: DevServerStatus[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/dev-servers`
  );
}

export interface RunGroupWorkflowResponse {
  accepted: boolean;
  groupName: string;
  workflowName: string;
  branch: string;
  groupDir: string;
  conversationId: string;
  workflowRunId: string | null;
}

export async function runWorkspaceGroupWorkflow(
  groupName: string,
  input: { workflowName: string; message: string; conversationId: string }
): Promise<RunGroupWorkflowResponse> {
  return fetchJSON<RunGroupWorkflowResponse>(`/api/groups/${encodeURIComponent(groupName)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface WorkflowRunResponse {
  id: string;
  workflow_name: string;
  conversation_id: string;
  parent_conversation_id: string | null;
  codebase_id: string | null;
  status: WorkflowRunStatus;
  user_message: string;
  metadata: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  last_activity_at: string | null;
  worker_platform_id?: string;
  parent_platform_id?: string;
  conversation_platform_id?: string;
}

export interface WorkflowEventResponse {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export type WorkflowListEntry = components['schemas']['WorkflowListEntry'];

export async function listWorkflows(cwd?: string): Promise<WorkflowListEntry[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const result = await fetchJSON<{ workflows: WorkflowListEntry[] }>(`/api/workflows${params}`);
  return result.workflows;
}

export async function runWorkflow(
  name: string,
  conversationId: string,
  message: string
): Promise<{ accepted: boolean; status: string }> {
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message }),
  });
}

// Dashboard-enriched workflow run (includes joined data from single SQL query)
export interface DashboardRunResponse extends Omit<
  WorkflowRunResponse,
  'worker_platform_id' | 'parent_platform_id'
> {
  working_path: string | null;
  codebase_name: string | null;
  platform_type: string | null;
  worker_platform_id: string | null;
  parent_platform_id: string | null;
  current_step_name: string | null;
  total_steps: number | null;
  current_step_status: 'running' | 'completed' | 'failed' | null;
  agents_completed: number | null;
  agents_failed: number | null;
  agents_total: number | null;
}

/** Status counts across all matching runs (ignoring status filter). */
export interface DashboardCounts {
  all: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  pending: number;
  paused: number;
}

/** Paginated dashboard runs response. */
export interface DashboardRunsResult {
  runs: DashboardRunResponse[];
  total: number;
  counts: DashboardCounts;
}

export async function listDashboardRuns(options?: {
  status?: WorkflowRunStatus;
  codebaseId?: string;
  search?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}): Promise<DashboardRunsResult> {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.codebaseId) params.set('codebaseId', options.codebaseId);
  if (options?.search) params.set('search', options.search);
  if (options?.after) params.set('after', options.after);
  if (options?.before) params.set('before', options.before);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  const qs = params.toString();
  return fetchJSON<DashboardRunsResult>(`/api/dashboard/runs${qs ? `?${qs}` : ''}`);
}

export async function cancelWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

export async function resumeWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
  });
}

export async function abandonWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/abandon`, {
    method: 'POST',
  });
}

export async function deleteWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
}

export async function approveWorkflowRun(
  runId: string,
  comment?: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
}

export async function rejectWorkflowRun(
  runId: string,
  reason?: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus;
  limit?: number;
  codebaseId?: string;
}): Promise<WorkflowRunResponse[]> {
  const params = new URLSearchParams();
  if (options?.conversationId) params.set('conversationId', options.conversationId);
  if (options?.status) params.set('status', options.status);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.codebaseId) params.set('codebaseId', options.codebaseId);
  const qs = params.toString();
  const result = await fetchJSON<{ runs: WorkflowRunResponse[] }>(
    `/api/workflows/runs${qs ? `?${qs}` : ''}`
  );
  return result.runs;
}

export async function getWorkflowRun(
  runId: string
): Promise<{ run: WorkflowRunResponse; events: WorkflowEventResponse[] }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}

export async function getWorkflowRunByWorker(
  workerPlatformId: string
): Promise<{ run: WorkflowRunResponse } | null> {
  try {
    return await fetchJSON(`/api/workflows/runs/by-worker/${encodeURIComponent(workerPlatformId)}`);
  } catch (e: unknown) {
    // 404 means no run exists yet — expected during dispatch
    if ((e as Error & { status?: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

export type WorkflowSource = components['schemas']['WorkflowSource'];

export interface GetWorkflowResponse {
  workflow: WorkflowDefinition;
  filename: string;
  source: WorkflowSource;
}

export async function getWorkflow(name: string, cwd?: string): Promise<GetWorkflowResponse> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}${params}`);
}

export async function saveWorkflow(
  name: string,
  definition: WorkflowDefinition,
  cwd?: string
): Promise<GetWorkflowResponse> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}${params}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition }),
  });
}

export async function deleteWorkflow(
  name: string,
  cwd?: string
): Promise<{ deleted: boolean; name: string }> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}${params}`, {
    method: 'DELETE',
  });
}

export async function validateWorkflow(
  definition: WorkflowDefinition
): Promise<{ valid: boolean; errors?: string[] }> {
  return fetchJSON('/api/workflows/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition }),
  });
}

export interface CommandEntry {
  name: string;
  source: WorkflowSource;
}

export async function listCommands(cwd?: string): Promise<CommandEntry[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const result = await fetchJSON<{ commands: CommandEntry[] }>(`/api/commands${params}`);
  return result.commands;
}

export async function getConfig(): Promise<{ config: SafeConfigResponse; database: string }> {
  return fetchJSON('/api/config');
}

export async function updateAssistantConfig(
  body: UpdateAssistantConfigBody
): Promise<{ config: SafeConfigResponse; database: string }> {
  return fetchJSON('/api/config/assistants', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export type IsolationEnvironment = components['schemas']['IsolationEnvironment'];

export async function getCodebaseEnvironments(codebaseId: string): Promise<IsolationEnvironment[]> {
  const result = await fetchJSON<{ environments: IsolationEnvironment[] }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/environments`
  );
  return result.environments;
}

// Codebase env vars
export async function getCodebaseEnvVars(codebaseId: string): Promise<string[]> {
  const result = await fetchJSON<{ keys: string[] }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/env`
  );
  return result.keys;
}

export async function setCodebaseEnvVar(
  codebaseId: string,
  data: { key: string; value: string }
): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(`/api/codebases/${encodeURIComponent(codebaseId)}/env`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteCodebaseEnvVar(
  codebaseId: string,
  key: string
): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/env/${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  );
}

// System
export async function getHealth(): Promise<HealthResponse> {
  return fetchJSON<HealthResponse>('/api/health');
}

export type UpdateCheckResult = components['schemas']['UpdateCheckResponse'];

export async function getUpdateCheck(): Promise<UpdateCheckResult> {
  return fetchJSON<UpdateCheckResult>('/api/update-check');
}
