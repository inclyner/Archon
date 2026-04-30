/**
 * Process manager for per-conversation dev servers.
 *
 * Singleton in-memory registry keyed by conversation id. Each entry owns N
 * child processes (one per group member with a detected dev command),
 * captures their stdout/stderr into a rolling buffer for the UI to poll,
 * and tracks idle activity so an unattended conversation's servers can be
 * auto-stopped.
 *
 * Lifetime: tied to the Archon server process. If you restart Archon, all
 * dev servers are killed. That's the right default — leftover Node/dotnet
 * processes from yesterday's chat hogging ports is exactly the problem
 * this thing prevents.
 *
 * Cleanup on conversation soft-delete is wired via the API DELETE handler;
 * here we just expose stop() and rely on callers to call it.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from '@archon/paths';
import type { DevCommandSpec } from './dev-command';
import type { AllocatedMemberPorts } from './port-allocator';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('dev-servers.process-manager');
  return cachedLog;
}

const LOG_RING_SIZE = 500; // lines per session

export interface ServerStatus {
  codebaseId: string;
  label: string;
  port: number;
  pid: number | null;
  state: 'starting' | 'ready' | 'crashed' | 'stopped';
  /** URL the user can click in the UI. http://localhost:<port>. */
  url: string;
  /** Last N log lines (from rolling buffer). */
  logTail: string[];
  /** Reason for the current state (when crashed/stopped). */
  message: string | null;
}

interface ProcessSession {
  codebaseId: string;
  label: string;
  port: number;
  spec: DevCommandSpec;
  child: ChildProcess | null;
  state: ServerStatus['state'];
  message: string | null;
  logBuffer: string[];
}

interface ConversationDevServers {
  conversationId: string;
  sessions: Map<string, ProcessSession>; // codebaseId → session
  lastActivityAt: number;
  idleTimeoutMs: number;
}

const registry = new Map<string, ConversationDevServers>();

/** Update the activity timestamp so the auto-stop timer doesn't kill us. */
export function markConversationActive(conversationId: string): void {
  const entry = registry.get(conversationId);
  if (entry) entry.lastActivityAt = Date.now();
}

/** True if any server is running for this conversation. */
export function hasRunningServers(conversationId: string): boolean {
  const entry = registry.get(conversationId);
  if (!entry) return false;
  for (const s of entry.sessions.values()) {
    if (s.state === 'starting' || s.state === 'ready') return true;
  }
  return false;
}

export interface StartMemberSpec {
  codebaseId: string;
  label: string;
  spec: DevCommandSpec;
  portInfo: AllocatedMemberPorts;
}

export interface StartRequest {
  conversationId: string;
  /** Per-member spec + port. Caller resolved the worktree dirs and ran detectDevCommand. */
  members: StartMemberSpec[];
  /** Idle timeout before auto-stop. 0 disables. */
  idleTimeoutMs: number;
  /**
   * Cross-repo env var injection. After ports are allocated, the runner
   * may need to set `NEXT_PUBLIC_API_URL=http://localhost:<api-port>` on
   * the front-end's process. The caller computes this map per-codebase.
   */
  crossRepoEnv?: Record<string, Record<string, string>>;
}

export interface StartResult {
  servers: ServerStatus[];
}

/**
 * Start (or restart) all dev servers for a conversation. Idempotent:
 * existing running servers are stopped first.
 */
export async function startConversationServers(req: StartRequest): Promise<StartResult> {
  await stopConversationServers(req.conversationId);

  const sessions = new Map<string, ProcessSession>();
  for (const m of req.members) {
    const session: ProcessSession = {
      codebaseId: m.codebaseId,
      label: m.label,
      port: m.portInfo.port,
      spec: m.spec,
      child: null,
      state: 'starting',
      message: null,
      logBuffer: [],
    };
    sessions.set(m.codebaseId, session);
  }

  const entry: ConversationDevServers = {
    conversationId: req.conversationId,
    sessions,
    lastActivityAt: Date.now(),
    idleTimeoutMs: req.idleTimeoutMs,
  };
  registry.set(req.conversationId, entry);

  // Spawn processes after registering — if a spawn throws synchronously the
  // entry stays in the registry and the caller can read the crashed state.
  for (const session of sessions.values()) {
    spawnSession(session, req.crossRepoEnv?.[session.codebaseId] ?? {});
  }

  return { servers: snapshotStatuses(entry) };
}

function spawnSession(session: ProcessSession, extraEnv: Record<string, string>): void {
  const env: Record<string, string> = { ...process.env, ...extraEnv } as Record<string, string>;

  // Inject the allocated port through whichever env var the dev command
  // reads, formatted appropriately. For uvicorn (which doesn't honor an env
  // var) we patch the args array to replace the PORT_PLACEHOLDER token.
  if (session.spec.portEnvVar === 'UVICORN_PORT') {
    session.spec = {
      ...session.spec,
      args: session.spec.args.map(a => (a === 'PORT_PLACEHOLDER' ? String(session.port) : a)),
    };
  } else if (session.spec.portEnvVar) {
    env[session.spec.portEnvVar] =
      session.spec.portFormat === 'kestrelUrl' ? `http://*:${session.port}` : String(session.port);
  }

  try {
    const child = spawn(session.spec.command, session.spec.args, {
      cwd: session.spec.cwd,
      env,
      shell: false,
      // Detached + new process group so we can kill the child AND its
      // descendants (dotnet watch in particular spawns a child it doesn't
      // forward signals to). Windows uses a different mechanism — we'll
      // use child.kill('SIGTERM') and accept that orphans may leak under
      // certain crash scenarios; acceptable for personal use.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.child = child;

    const onLine = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/).filter(l => l.length > 0);
      for (const line of lines) {
        appendLog(session, line);
        if (
          session.state === 'starting' &&
          session.spec.readinessMarkers?.some(marker => line.includes(marker))
        ) {
          session.state = 'ready';
        }
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);

    child.on('exit', (code, signal) => {
      session.state = code === 0 ? 'stopped' : 'crashed';
      session.message =
        code !== null ? `exit ${String(code)}` : signal ? `signal ${signal}` : 'exited';
      appendLog(session, `[archon] process exited (${session.message})`);
      session.child = null;
    });

    child.on('error', err => {
      session.state = 'crashed';
      session.message = err.message;
      appendLog(session, `[archon] spawn error: ${err.message}`);
      session.child = null;
      getLog().error(
        { err, command: session.spec.command, args: session.spec.args, cwd: session.spec.cwd },
        'dev_servers.spawn_error'
      );
    });
  } catch (err) {
    session.state = 'crashed';
    session.message = (err as Error).message;
    appendLog(session, `[archon] spawn threw: ${(err as Error).message}`);
    getLog().error(
      { err, command: session.spec.command, cwd: session.spec.cwd },
      'dev_servers.spawn_threw'
    );
  }
}

function appendLog(session: ProcessSession, line: string): void {
  session.logBuffer.push(line);
  if (session.logBuffer.length > LOG_RING_SIZE) {
    session.logBuffer.splice(0, session.logBuffer.length - LOG_RING_SIZE);
  }
}

/** Stop all dev servers for a conversation. Idempotent — no-op if none. */
export async function stopConversationServers(conversationId: string): Promise<void> {
  const entry = registry.get(conversationId);
  if (!entry) return;

  for (const session of entry.sessions.values()) {
    if (session.child && session.state !== 'stopped' && session.state !== 'crashed') {
      try {
        if (process.platform === 'win32') {
          // Windows: child.kill() sends SIGTERM but some shells (dotnet) ignore it.
          // taskkill /F /T /PID kills the whole tree.
          const { spawn: spawnSync } = await import('child_process');
          spawnSync('taskkill', ['/F', '/T', '/PID', String(session.child.pid)], {
            stdio: 'ignore',
          });
        } else if (session.child.pid != null) {
          // Unix: -pid kills the process group (because we spawned detached).
          try {
            process.kill(-session.child.pid, 'SIGTERM');
          } catch {
            session.child.kill('SIGTERM');
          }
        }
      } catch (err) {
        getLog().warn(
          { err, conversationId, codebaseId: session.codebaseId },
          'dev_servers.kill_failed'
        );
      }
      session.state = 'stopped';
      session.message = 'stopped by user';
    }
    session.child = null;
  }

  // Keep the entry in the registry so the user's last log tail is still
  // viewable after stop. A subsequent start replaces it.
}

/** Snapshot of all sessions for a conversation. Returns empty if none. */
export function getConversationStatus(conversationId: string): ServerStatus[] {
  const entry = registry.get(conversationId);
  if (!entry) return [];
  return snapshotStatuses(entry);
}

function snapshotStatuses(entry: ConversationDevServers): ServerStatus[] {
  const out: ServerStatus[] = [];
  for (const s of entry.sessions.values()) {
    out.push({
      codebaseId: s.codebaseId,
      label: s.label,
      port: s.port,
      pid: s.child?.pid ?? null,
      state: s.state,
      url: `http://localhost:${String(s.port)}`,
      logTail: [...s.logBuffer].slice(-100),
      message: s.message,
    });
  }
  return out;
}

/**
 * Background sweeper: every minute, check each conversation's
 * lastActivityAt against its idleTimeoutMs and stop servers that have
 * gone quiet. Caller is responsible for calling startIdleSweeper() once
 * during server bootstrap. Safe to call multiple times — no-op if already
 * started.
 */
let sweeperHandle: ReturnType<typeof setInterval> | null = null;
export function startIdleSweeper(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    const now = Date.now();
    for (const entry of registry.values()) {
      if (entry.idleTimeoutMs <= 0) continue;
      if (!hasRunningServers(entry.conversationId)) continue;
      if (now - entry.lastActivityAt > entry.idleTimeoutMs) {
        getLog().info(
          {
            conversationId: entry.conversationId,
            idleMs: now - entry.lastActivityAt,
          },
          'dev_servers.auto_stop_idle'
        );
        // Fire-and-forget — sweep tick can't await.
        void stopConversationServers(entry.conversationId);
      }
    }
  }, 60_000);
}

export function stopIdleSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}

/** Test-only: clear all state. */
export function resetForTests(): void {
  for (const id of [...registry.keys()]) {
    void stopConversationServers(id);
  }
  registry.clear();
  stopIdleSweeper();
}
