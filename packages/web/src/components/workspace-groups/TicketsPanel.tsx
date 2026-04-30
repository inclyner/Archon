/**
 * Lists Jira tickets currently assigned to the configured user, with a
 * "Start chat" button per ticket that creates a new group conversation
 * pre-titled with the ticket key + summary.
 *
 * Renders nothing (collapsed message) if Jira isn't configured — points
 * the user at Settings → Jira.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Loader2, ExternalLink, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { listJiraTickets, createConversation, getJiraConfig, type JiraTicket } from '@/lib/api';

interface Props {
  groupId: string;
  groupName: string;
}

export function TicketsPanel({ groupId, groupName }: Props): React.ReactElement {
  const navigate = useNavigate();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const configQuery = useQuery({
    queryKey: ['jira-config'],
    queryFn: getJiraConfig,
  });

  const ticketsQuery = useQuery({
    queryKey: ['jira-tickets'],
    queryFn: listJiraTickets,
    enabled: configQuery.data?.configured === true,
  });

  const startChat = useMutation({
    mutationFn: async (ticket: JiraTicket): Promise<string> => {
      // Pre-title the conversation with the ticket key + truncated summary.
      // The orchestrator's title generator can rewrite this if/when the AI
      // gives a better one; ours is a sensible placeholder.
      const message = `Working on ${ticket.key}: ${ticket.summary}\n\nTicket: ${ticket.url}`;
      const created = await createConversation(undefined, message, groupId);
      return created.conversationId;
    },
    onSuccess: conversationId => {
      navigate(`/chat/${encodeURIComponent(conversationId)}`);
    },
  });

  const filtered = useMemo(() => {
    const tickets = ticketsQuery.data?.tickets ?? [];
    if (!filter.trim()) return tickets;
    const f = filter.toLowerCase();
    return tickets.filter(
      t =>
        t.key.toLowerCase().includes(f) ||
        t.summary.toLowerCase().includes(f) ||
        t.projectKey.toLowerCase().includes(f)
    );
  }, [ticketsQuery.data, filter]);

  if (!configQuery.isLoading && !configQuery.data?.configured) {
    return (
      <div>
        <h2 className="mb-2 text-sm font-semibold text-text-primary">Jira tickets</h2>
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-text-tertiary">
          Jira isn't configured.{' '}
          <Link to="/settings" className="text-primary hover:underline">
            Open Settings → Jira
          </Link>{' '}
          to add your host, email, and API token.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          My Jira tickets{' '}
          {ticketsQuery.data && (
            <span className="text-text-tertiary">({ticketsQuery.data.tickets.length})</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e): void => {
              setFilter(e.target.value);
            }}
            placeholder="Filter by key, summary, or project..."
            className="h-7 w-56 rounded-md border border-border bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={(): void => {
              void ticketsQuery.refetch();
            }}
            disabled={ticketsQuery.isFetching}
            title="Refresh tickets"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${ticketsQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {ticketsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading tickets...
        </div>
      )}

      {ticketsQuery.isError && (
        <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
          {ticketsQuery.error.message}
        </div>
      )}

      {!ticketsQuery.isLoading && filtered.length === 0 && !ticketsQuery.isError && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-text-tertiary">
          {filter
            ? 'No tickets match the filter.'
            : 'No open tickets assigned to you. Done by Friday!'}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {filtered.map(ticket => (
            <TicketRow
              key={ticket.key}
              ticket={ticket}
              groupName={groupName}
              busy={busyKey === ticket.key}
              onStart={async (): Promise<void> => {
                setBusyKey(ticket.key);
                try {
                  await startChat.mutateAsync(ticket);
                } finally {
                  setBusyKey(null);
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketRow(props: {
  ticket: JiraTicket;
  groupName: string;
  busy: boolean;
  onStart: () => Promise<void>;
}): React.ReactElement {
  const { ticket, groupName, busy, onStart } = props;
  const dotClass =
    ticket.statusCategory === 'inprogress'
      ? 'bg-yellow-500'
      : ticket.statusCategory === 'done'
        ? 'bg-green-500'
        : ticket.statusCategory === 'todo'
          ? 'bg-blue-500'
          : 'bg-text-tertiary';
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <a
        href={ticket.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-mono text-primary hover:underline"
      >
        {ticket.key}
      </a>
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{ticket.summary}</span>
      <span className="shrink-0 text-[11px] text-text-tertiary">{ticket.status}</span>
      <a
        href={ticket.url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-text-tertiary hover:text-text-primary"
        title="Open in Jira"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <Button
        size="sm"
        variant="outline"
        onClick={(): void => {
          void onStart();
        }}
        disabled={busy}
        title={`New chat against ${groupName} pre-titled with this ticket`}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
        )}
        Start chat
      </Button>
    </div>
  );
}
