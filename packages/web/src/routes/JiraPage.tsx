/**
 * Top-level Jira workspace: lists every ticket assigned to the configured
 * user and lets them spawn a chat on any of them. Mirrors the per-group
 * TicketsPanel but adds a group picker so you can pick where the chat
 * lands when you have more than one workspace group.
 *
 * Why a separate page (vs only the per-group panel): on most days the
 * "what am I working on?" question doesn't start from a specific group —
 * it starts from a ticket. This is the front door for that flow.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router';
import { Loader2, ExternalLink, MessageSquarePlus, RefreshCw, AlertCircle } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import {
  listJiraTickets,
  createConversation,
  getJiraConfig,
  listWorkspaceGroups,
  type JiraTicket,
  type WorkspaceGroupResponse,
} from '@/lib/api';

const GROUP_PREF_KEY = 'archon-jira-default-group';

export function JiraPage(): React.ReactElement {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ['jira-config'],
    queryFn: getJiraConfig,
  });

  const ticketsQuery = useQuery({
    queryKey: ['jira-tickets'],
    queryFn: listJiraTickets,
    enabled: configQuery.data?.configured === true,
  });

  const groupsQuery = useQuery({
    queryKey: ['workspace-groups'],
    queryFn: listWorkspaceGroups,
    staleTime: 30_000,
  });

  // Auto-pick a group: use the user's last choice if it still exists,
  // otherwise default to the only group when there's exactly one.
  const [selectedGroupId, setSelectedGroupId] = useState<string>(() => {
    try {
      return localStorage.getItem(GROUP_PREF_KEY) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!groupsQuery.data) return;
    if (selectedGroupId && groupsQuery.data.some(g => g.id === selectedGroupId)) return;
    if (groupsQuery.data.length === 1) {
      const only = groupsQuery.data[0].id;
      setSelectedGroupId(only);
      try {
        localStorage.setItem(GROUP_PREF_KEY, only);
      } catch {
        /* localStorage unavailable */
      }
    }
  }, [groupsQuery.data, selectedGroupId]);

  const startChat = useMutation({
    mutationFn: async (ticket: JiraTicket): Promise<string> => {
      const message = `Working on ${ticket.key}: ${ticket.summary}\n\nTicket: ${ticket.url}`;
      // selectedGroupId may be "" (no group chosen) — that creates a plain
      // orchestrator conversation, which is still useful for ticket research
      // even without group worktree isolation.
      const created = await createConversation(undefined, message, selectedGroupId || undefined);
      return created.conversationId;
    },
    onSuccess: conversationId => {
      navigate(`/chat/${encodeURIComponent(conversationId)}`);
    },
  });

  const tickets = ticketsQuery.data?.tickets ?? [];
  const filtered = useMemo(() => {
    if (!filter.trim()) return tickets;
    const f = filter.toLowerCase();
    return tickets.filter(
      t =>
        t.key.toLowerCase().includes(f) ||
        t.summary.toLowerCase().includes(f) ||
        t.projectKey.toLowerCase().includes(f)
    );
  }, [tickets, filter]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title="Jira" />
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {!configQuery.isLoading && !configQuery.data?.configured && <NotConfiguredEmptyState />}

          {configQuery.data?.configured && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">My open tickets</h2>
                <span className="text-xs text-text-tertiary">({tickets.length})</span>
                <div className="ml-auto flex items-center gap-2">
                  <input
                    value={filter}
                    onChange={(e): void => {
                      setFilter(e.target.value);
                    }}
                    placeholder="Filter by key, summary, or project..."
                    className="h-8 w-64 rounded-md border border-border bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(): void => {
                      void ticketsQuery.refetch();
                    }}
                    disabled={ticketsQuery.isFetching}
                  >
                    <RefreshCw
                      className={`mr-1 h-3.5 w-3.5 ${ticketsQuery.isFetching ? 'animate-spin' : ''}`}
                    />
                    Refresh
                  </Button>
                </div>
              </div>

              <GroupPicker
                groups={groupsQuery.data ?? []}
                selectedGroupId={selectedGroupId}
                onChange={(id): void => {
                  setSelectedGroupId(id);
                  try {
                    if (id) localStorage.setItem(GROUP_PREF_KEY, id);
                    else localStorage.removeItem(GROUP_PREF_KEY);
                  } catch {
                    /* best-effort */
                  }
                }}
              />

              {ticketsQuery.isLoading && (
                <div className="flex items-center gap-2 text-sm text-text-tertiary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tickets...
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

              <div className="flex flex-col gap-1.5">
                {filtered.map(ticket => (
                  <TicketRow
                    key={ticket.key}
                    ticket={ticket}
                    busy={busyKey === ticket.key}
                    selectedGroupName={groupsQuery.data?.find(g => g.id === selectedGroupId)?.name}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NotConfiguredEmptyState(): React.ReactElement {
  return (
    <div className="rounded-md border border-dashed border-border bg-surface p-6 text-sm text-text-secondary">
      <div className="mb-2 flex items-center gap-2 text-text-primary">
        <AlertCircle className="h-4 w-4 text-text-tertiary" />
        Jira isn't configured yet.
      </div>
      <p className="text-xs text-text-tertiary">
        Add your Atlassian host, email, and API token in{' '}
        <Link to="/settings" className="text-primary hover:underline">
          Settings → Jira
        </Link>
        . Generate a token at{' '}
        <a
          href="https://id.atlassian.com/manage-profile/security/api-tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          id.atlassian.com → API tokens
        </a>
        .
      </p>
    </div>
  );
}

function GroupPicker(props: {
  groups: WorkspaceGroupResponse[];
  selectedGroupId: string;
  onChange: (id: string) => void;
}): React.ReactElement | null {
  const { groups, selectedGroupId, onChange } = props;
  if (groups.length === 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs">
      <span className="text-text-tertiary">Open chats under group:</span>
      <select
        value={selectedGroupId}
        onChange={(e): void => {
          onChange(e.target.value);
        }}
        className="h-7 rounded-md border border-border bg-surface-elevated px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">(none — plain chat)</option>
        {groups.map(g => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <span className="text-text-tertiary">
        Group-scoped chats get their own folder-level worktree on first message.
      </span>
    </div>
  );
}

function TicketRow(props: {
  ticket: JiraTicket;
  busy: boolean;
  selectedGroupName: string | undefined;
  onStart: () => Promise<void>;
}): React.ReactElement {
  const { ticket, busy, selectedGroupName, onStart } = props;
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
      <Link
        to={`/jira/${encodeURIComponent(ticket.key)}`}
        className="text-xs font-mono text-primary hover:underline"
      >
        {ticket.key}
      </Link>
      <Link
        to={`/jira/${encodeURIComponent(ticket.key)}`}
        className="min-w-0 flex-1 truncate text-sm text-text-primary hover:underline"
      >
        {ticket.summary}
      </Link>
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
        title={
          selectedGroupName
            ? `Start chat in ${selectedGroupName} pre-titled with this ticket`
            : 'Start a plain chat pre-titled with this ticket'
        }
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
