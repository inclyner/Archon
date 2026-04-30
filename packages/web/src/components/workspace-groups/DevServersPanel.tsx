/**
 * Per-conversation dev-server controls for group-scoped chats.
 *
 * Shows the Run/Stop button, lists allocated URLs with their state, and
 * exposes a collapsible log pane (last 100 lines per server, polled every
 * 2 seconds while servers are live).
 *
 * Mounted in the chat header above the message list when the conversation
 * is group-scoped. Hidden entirely otherwise.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, Square, Server, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  startConversationDevServers,
  stopConversationDevServers,
  getConversationDevServerStatus,
  type DevServerStatus,
} from '@/lib/api';

interface Props {
  conversationId: string;
}

export function DevServersPanel({ conversationId }: Props): React.ReactElement {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [logExpanded, setLogExpanded] = useState<string | null>(null);

  // Poll while servers exist; idle (no servers) → fall back to a slow refetch
  // so the user can see "stopped" linger but the panel doesn't hammer the API.
  const { data, isFetching } = useQuery({
    queryKey: ['dev-servers', conversationId],
    queryFn: () => getConversationDevServerStatus(conversationId),
    refetchInterval: query => {
      const servers = query.state.data?.servers ?? [];
      const anyLive = servers.some(s => s.state === 'starting' || s.state === 'ready');
      return anyLive ? 2_000 : 10_000;
    },
  });

  const start = useMutation({
    mutationFn: () => startConversationDevServers(conversationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dev-servers', conversationId] });
      setExpanded(true);
    },
  });

  const stop = useMutation({
    mutationFn: () => stopConversationDevServers(conversationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dev-servers', conversationId] });
    },
  });

  const servers = data?.servers ?? [];
  const anyLive = servers.some(s => s.state === 'starting' || s.state === 'ready');
  const anyKnown = servers.length > 0;

  return (
    <div className="border-b border-border bg-surface px-4 py-2">
      <div className="flex items-center gap-3">
        <button
          onClick={(): void => {
            setExpanded(prev => !prev);
          }}
          className="flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <Server className="h-3.5 w-3.5" />
          Dev servers
          {anyLive && (
            <span className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
          )}
          {anyKnown && (
            <span className="text-[11px] text-text-tertiary">
              ({servers.filter(s => s.state === 'ready').length}/{servers.length} ready)
            </span>
          )}
        </button>

        <div className="flex-1" />

        {!anyLive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(): void => {
              start.mutate();
            }}
            disabled={start.isPending}
          >
            {start.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Run servers
          </Button>
        )}
        {anyLive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(): void => {
              stop.mutate();
            }}
            disabled={stop.isPending}
          >
            {stop.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="mr-1.5 h-3.5 w-3.5" />
            )}
            Stop
          </Button>
        )}
      </div>

      {start.isError && (
        <div className="mt-2 rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
          {start.error.message}
        </div>
      )}

      {expanded && (
        <div className="mt-2 flex flex-col gap-1">
          {!isFetching && servers.length === 0 && (
            <div className="text-xs text-text-tertiary px-1">
              No dev servers yet. Click "Run servers" to start them.
            </div>
          )}
          {servers.map(s => (
            <ServerRow
              key={s.codebaseId}
              server={s}
              expanded={logExpanded === s.codebaseId}
              onToggleLog={(): void => {
                setLogExpanded(prev => (prev === s.codebaseId ? null : s.codebaseId));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerRow(props: {
  server: DevServerStatus;
  expanded: boolean;
  onToggleLog: () => void;
}): React.ReactElement {
  const { server, expanded, onToggleLog } = props;
  return (
    <div className="rounded-md border border-border bg-surface-elevated px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <StateDot state={server.state} />
        <span className="text-xs font-medium text-text-primary truncate flex-1">
          {server.label}
        </span>
        {server.state === 'ready' || server.state === 'starting' ? (
          <a
            href={server.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-primary hover:underline"
          >
            {server.url}
          </a>
        ) : (
          <span className="text-[11px] text-text-tertiary">:{server.port}</span>
        )}
        <button
          onClick={onToggleLog}
          className="text-[11px] text-text-tertiary hover:text-text-primary"
        >
          {expanded ? 'hide log' : 'log'}
        </button>
      </div>
      {server.message && (
        <div className="mt-0.5 text-[10px] text-text-tertiary">{server.message}</div>
      )}
      {expanded && (
        <pre className="mt-1.5 max-h-48 overflow-y-auto rounded bg-background px-2 py-1 text-[10px] leading-tight text-text-secondary whitespace-pre-wrap">
          {server.logTail.length === 0 ? '(no output yet)' : server.logTail.join('\n')}
        </pre>
      )}
    </div>
  );
}

function StateDot({ state }: { state: DevServerStatus['state'] }): React.ReactElement {
  const cls =
    state === 'ready'
      ? 'bg-green-500'
      : state === 'starting'
        ? 'bg-yellow-500 animate-pulse'
        : state === 'crashed'
          ? 'bg-red-500'
          : 'bg-text-tertiary';
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}
