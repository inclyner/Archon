/**
 * High-level dev-server runner: the only thing API endpoints should call.
 *
 * Bridges the orchestrator's group-chat helper (which knows the worktree
 * paths) and the process manager (which knows how to spawn/stop). Handles:
 *   - port allocation (deterministic per conversation)
 *   - dev-command auto-detection per member
 *   - cross-repo env var injection (the front-end needs to know the api's
 *     allocated port — this is what makes it a "platform" instead of just
 *     "four random servers")
 *
 * Keeps a thin abstraction around process-manager so future replacements
 * (e.g. Docker-based runners) don't ripple into the API layer.
 */
import { createLogger } from '@archon/paths';
import type { Conversation } from '../types';
import { ensureGroupConversationWorktree, type GroupChatContext } from '../orchestrator/group-chat';
import * as workspaceGroupDb from '../db/workspace-groups';
import * as codebaseDb from '../db/codebases';
import { allocateConversationPorts } from './port-allocator';
import { detectDevCommand, type DevCommandSpec } from './dev-command';
import {
  startConversationServers,
  stopConversationServers,
  getConversationStatus,
  markConversationActive,
  type ServerStatus,
} from './process-manager';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('dev-servers.runner');
  return cachedLog;
}

export interface SkippedMember {
  codebaseId: string;
  relativePath: string;
  reason: string;
}

export interface DevServerStartResult {
  servers: ServerStatus[];
  /** Members for which auto-detection found no dev command. */
  skipped: SkippedMember[];
  /** The on-disk group dir, for the UI to display. */
  groupDir: string;
}

export interface DevServerStartOptions {
  /** Idle timeout in ms; 0 disables auto-stop. */
  idleTimeoutMs: number;
}

/**
 * Start dev servers for a group-scoped conversation.
 *
 * Resolves the worktree (creating it if needed via ensureGroupConversationWorktree),
 * allocates ports, auto-detects per-member dev commands, then hands off to
 * the process manager.
 *
 * Throws if conversation isn't group-scoped.
 */
export async function startDevServers(
  conversation: Conversation,
  options: DevServerStartOptions
): Promise<DevServerStartResult> {
  if (!conversation.workspace_group_id) {
    throw new Error('Conversation is not group-scoped — dev servers only run for group chats.');
  }

  const ctx: GroupChatContext = await ensureGroupConversationWorktree(conversation);
  const memberRows = await workspaceGroupDb.getMembersForGroup(ctx.group.id);
  if (memberRows.length === 0) {
    throw new Error(`Group "${ctx.group.name}" has no members.`);
  }

  const ports = allocateConversationPorts(
    conversation.id,
    memberRows.map(m => m.codebase_id)
  );
  const portMap = new Map(ports.map(p => [p.codebaseId, p]));

  const skipped: DevServerStartResult['skipped'] = [];
  interface StartMember {
    codebaseId: string;
    label: string;
    spec: DevCommandSpec;
    portInfo: ReturnType<typeof allocateConversationPorts>[number];
  }
  const startMembers: StartMember[] = [];

  for (const m of memberRows) {
    const memberDir = ctx.memberDirs[m.codebase_id];
    if (!memberDir) {
      skipped.push({
        codebaseId: m.codebase_id,
        relativePath: m.relative_path,
        reason: 'Member dir missing from worktree result.',
      });
      continue;
    }
    const spec = detectDevCommand(memberDir);
    if (!spec) {
      skipped.push({
        codebaseId: m.codebase_id,
        relativePath: m.relative_path,
        reason:
          'No dev command detected. Add a package.json scripts.dev / pyproject.toml uvicorn dep / .csproj with Microsoft.NET.Sdk.Web, or override per-codebase config (TODO).',
      });
      continue;
    }
    const portInfo = portMap.get(m.codebase_id);
    if (!portInfo) {
      skipped.push({
        codebaseId: m.codebase_id,
        relativePath: m.relative_path,
        reason: 'Internal: port allocation missing for member.',
      });
      continue;
    }
    spec.label = m.relative_path;
    startMembers.push({
      codebaseId: m.codebase_id,
      label: m.relative_path,
      spec,
      portInfo,
    });
  }

  // Build cross-repo env. Currently a simple convention: every member that
  // looks like an API (label contains 'api' OR detected as dotnet/python)
  // exposes its URL to every member that looks like a frontend (label
  // contains 'front' OR has a package.json). NEXT_PUBLIC_API_URL is the
  // most common var name; we set it broadly and the front-end picks it up.
  // Wire-by-convention is brittle and we'll replace with explicit per-repo
  // mappings once a UI exists.
  const crossRepoEnv: Record<string, Record<string, string>> = {};
  const apiMember = startMembers.find(m => /api|service|backend/i.test(m.label));
  if (apiMember) {
    const apiUrl = `http://localhost:${String(apiMember.portInfo.port)}`;
    for (const m of startMembers) {
      if (m === apiMember) continue;
      crossRepoEnv[m.codebaseId] = {
        ...(crossRepoEnv[m.codebaseId] ?? {}),
        NEXT_PUBLIC_API_URL: apiUrl,
        VITE_API_URL: apiUrl,
        REACT_APP_API_URL: apiUrl,
      };
    }
  }

  getLog().info(
    {
      conversationId: conversation.id,
      groupName: ctx.group.name,
      members: startMembers.map(m => ({
        codebaseId: m.codebaseId,
        label: m.label,
        port: m.portInfo.port,
        cwd: m.spec.cwd,
        cmd: `${m.spec.command} ${m.spec.args.join(' ')}`,
      })),
      skipped,
    },
    'dev_servers.starting'
  );

  await startConversationServers({
    conversationId: conversation.id,
    members: startMembers,
    idleTimeoutMs: options.idleTimeoutMs,
    crossRepoEnv,
  });

  return {
    servers: getConversationStatus(conversation.id),
    skipped,
    groupDir: ctx.groupDir,
  };
}

export async function stopDevServers(conversationId: string): Promise<void> {
  await stopConversationServers(conversationId);
}

export function getDevServerStatus(conversationId: string): {
  servers: ServerStatus[];
} {
  // Touch activity on every status read so an actively-watching UI keeps
  // the auto-stop sweep at bay. (The chat polls this every couple of seconds.)
  markConversationActive(conversationId);
  return { servers: getConversationStatus(conversationId) };
}

/**
 * Codebase metadata lookup helper. Used by the API to enrich responses with
 * codebase names; not strictly needed but it's nicer than codebase_id UUIDs
 * everywhere in the UI.
 */
export async function getCodebaseLabels(
  codebaseIds: readonly string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of codebaseIds) {
    try {
      const cb = await codebaseDb.getCodebase(id);
      if (cb) out[id] = cb.name;
    } catch {
      // best-effort
    }
  }
  return out;
}
