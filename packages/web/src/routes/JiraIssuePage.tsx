/**
 * Inline Jira ticket detail page. Read-only for v1: description, comments,
 * metadata sidebar. Editing (transitions, add comment) lives behind a
 * second pass once the read view earns its keep.
 *
 * Rendering uses the shared AdfRenderer so descriptions and comments use
 * the same walker (and so future ADF features land in one place).
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Loader2, MessageSquare, MessageSquarePlus } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { AdfRenderer } from '@/components/jira/AdfRenderer';
import { getJiraIssueDetail, createConversation, listWorkspaceGroups } from '@/lib/api';
import { buildJiraChatSeed, stashChatSeed } from '@/lib/jira-context';

const GROUP_PREF_KEY = 'archon-jira-default-group';

export function JiraIssuePage(): React.ReactElement {
  const { key: rawKey } = useParams<{ key: string }>();
  const ticketKey = rawKey ?? '';
  const navigate = useNavigate();

  const detailQuery = useQuery({
    queryKey: ['jira-issue', ticketKey],
    queryFn: () => getJiraIssueDetail(ticketKey),
    enabled: ticketKey.length > 0,
  });

  const groupsQuery = useQuery({
    queryKey: ['workspace-groups'],
    queryFn: listWorkspaceGroups,
    staleTime: 30_000,
  });

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
      setSelectedGroupId(groupsQuery.data[0].id);
    }
  }, [groupsQuery.data, selectedGroupId]);

  const startChat = useMutation({
    mutationFn: async (): Promise<string> => {
      const detail = detailQuery.data;
      if (!detail) throw new Error('Issue not loaded yet');
      // Don't auto-dispatch (no `message` arg); the orchestrator stays
      // idle until the user hits Enter on the pre-filled input.
      const created = await createConversation(undefined, undefined, selectedGroupId || undefined);
      const seedMessage = buildJiraChatSeed(detail.issue, detail.comments);
      stashChatSeed(created.conversationId, seedMessage);
      return created.conversationId;
    },
    onSuccess: conversationId => {
      navigate(`/chat/${encodeURIComponent(conversationId)}`);
    },
  });

  const issue = detailQuery.data?.issue;
  const comments = detailQuery.data?.comments ?? [];
  const sortedComments = useMemo(
    () => [...comments].sort((a, b) => (a.created < b.created ? -1 : 1)),
    [comments]
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title={issue ? `${issue.key} · ${issue.summary}` : ticketKey || 'Ticket'} />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Link to="/jira">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                Back to Jira
              </Button>
            </Link>
          </div>

          {detailQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading {ticketKey}...
            </div>
          )}

          {detailQuery.isError && (
            <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-sm text-error">
              {detailQuery.error.message}
            </div>
          )}

          {issue && (
            <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
              {/* Main column */}
              <div className="min-w-0 space-y-5">
                <div>
                  <div className="mb-1 flex items-center gap-2 text-xs text-text-tertiary">
                    <span>{issue.issueType}</span>
                    <span>·</span>
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-primary hover:underline"
                    >
                      {issue.key}
                      <ExternalLink className="ml-1 inline h-3 w-3" />
                    </a>
                    <StatusPill status={issue.status} category={issue.statusCategory} />
                  </div>
                  <h1 className="text-xl font-semibold text-text-primary">{issue.summary}</h1>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {groupsQuery.data && groupsQuery.data.length > 0 && (
                    <select
                      value={selectedGroupId}
                      onChange={(e): void => {
                        setSelectedGroupId(e.target.value);
                        try {
                          if (e.target.value) {
                            localStorage.setItem(GROUP_PREF_KEY, e.target.value);
                          } else {
                            localStorage.removeItem(GROUP_PREF_KEY);
                          }
                        } catch {
                          /* best-effort */
                        }
                      }}
                      className="h-9 rounded-md border border-border bg-surface-elevated px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">No group (plain chat)</option>
                      {groupsQuery.data.map(g => (
                        <option key={g.id} value={g.id}>
                          Open chat in: {g.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    onClick={(): void => {
                      startChat.mutate();
                    }}
                    disabled={startChat.isPending}
                  >
                    {startChat.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Start chat
                  </Button>
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open in Jira
                  </a>
                </div>

                <div>
                  <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                    Description
                  </h2>
                  <div className="rounded-md border border-border bg-surface px-4 py-3">
                    <AdfRenderer doc={issue.description} />
                  </div>
                </div>

                <div>
                  <h2 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                    <MessageSquare className="h-3.5 w-3.5" />
                    Comments ({sortedComments.length})
                  </h2>
                  {sortedComments.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-3 text-xs text-text-tertiary">
                      No comments yet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {sortedComments.map(c => (
                        <div
                          key={c.id}
                          className="rounded-md border border-border bg-surface px-3 py-2"
                        >
                          <div className="mb-1 flex items-center gap-2 text-[11px] text-text-tertiary">
                            <span className="font-medium text-text-secondary">
                              {c.author?.name ?? 'unknown'}
                            </span>
                            <span>· {formatRelative(c.created)}</span>
                            {c.updated !== c.created && (
                              <span title={`updated ${c.updated}`}>· edited</span>
                            )}
                          </div>
                          <AdfRenderer doc={c.body} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Metadata sidebar */}
              <aside className="space-y-3 text-sm">
                <MetaRow label="Status">
                  <StatusPill status={issue.status} category={issue.statusCategory} />
                </MetaRow>
                <MetaRow label="Type">{issue.issueType}</MetaRow>
                <MetaRow label="Priority">{issue.priority ?? '—'}</MetaRow>
                <MetaRow label="Assignee">{issue.assignee?.name ?? 'Unassigned'}</MetaRow>
                <MetaRow label="Reporter">{issue.reporter?.name ?? '—'}</MetaRow>
                <MetaRow label="Project">
                  <span className="font-mono">{issue.projectKey}</span>
                </MetaRow>
                {issue.labels.length > 0 && (
                  <MetaRow label="Labels">
                    <div className="flex flex-wrap gap-1">
                      {issue.labels.map(l => (
                        <span
                          key={l}
                          className="rounded bg-surface-elevated px-1.5 py-0.5 text-[11px] text-text-secondary"
                        >
                          {l}
                        </span>
                      ))}
                    </div>
                  </MetaRow>
                )}
                <MetaRow label="Created">{formatRelative(issue.created)}</MetaRow>
                <MetaRow label="Updated">{formatRelative(issue.updated)}</MetaRow>
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div className="mt-0.5 text-text-primary">{children}</div>
    </div>
  );
}

function StatusPill({
  status,
  category,
}: {
  status: string;
  category: 'todo' | 'inprogress' | 'done' | 'unknown';
}): React.ReactElement {
  const cls =
    category === 'inprogress'
      ? 'bg-yellow-500/15 text-yellow-500'
      : category === 'done'
        ? 'bg-green-500/15 text-green-500'
        : category === 'todo'
          ? 'bg-blue-500/15 text-blue-500'
          : 'bg-text-tertiary/15 text-text-tertiary';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${String(diffMin)}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${String(diffHr)}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${String(diffDay)}d ago`;
  return d.toLocaleString();
}
