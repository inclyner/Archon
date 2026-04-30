/**
 * Slack inbox: lists recent messages from configured Slack channels and
 * lets the user file a Jira ticket per message in three clicks
 * (expand → describe → preview → create).
 *
 * Auto-polls at the interval saved in Settings (default 30s) and exposes
 * a "Refresh now" button for impatience. If Slack isn't configured yet,
 * shows an empty-state pointing at /settings.
 *
 * Single Jira project per spec — the project key is read from the saved
 * Slack default. The form doesn't expose a per-message picker.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  RefreshCw,
  Loader2,
  ExternalLink,
  MessageSquarePlus,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  getSlackConfig,
  listSlackMessages,
  createJiraIssue,
  type SlackMessage,
  type JiraCreatedIssue,
} from '@/lib/api';

export function SlackPage(): React.ReactElement {
  const configQuery = useQuery({
    queryKey: ['slack-config'],
    queryFn: getSlackConfig,
  });

  const pollMs = (configQuery.data?.pollIntervalSeconds ?? 30) * 1000;
  const enabled = configQuery.data?.configured === true;

  const messagesQuery = useQuery({
    queryKey: ['slack-messages'],
    queryFn: listSlackMessages,
    enabled,
    refetchInterval: enabled ? pollMs : false,
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title="Slack inbox" />
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {!configQuery.isLoading && !enabled && (
            <div className="rounded-md border border-dashed border-border bg-surface p-6 text-sm text-text-secondary">
              <div className="mb-2 flex items-center gap-2 text-text-primary">
                <AlertCircle className="h-4 w-4 text-text-tertiary" />
                Slack inbox isn't set up yet.
              </div>
              <p className="text-xs text-text-tertiary">
                Add channel IDs and a default Jira project in{' '}
                <Link to="/settings" className="text-primary hover:underline">
                  Settings → Slack
                </Link>
                . The bot reuses your existing <code>SLACK_BOT_TOKEN</code> env var if you have one,
                otherwise paste a Bot User OAuth Token in Settings. Required scopes:{' '}
                <code>channels:history</code>, <code>groups:history</code>, <code>users:read</code>.
              </p>
            </div>
          )}

          {enabled && (
            <SlackFeed
              messagesQuery={messagesQuery}
              defaultProjectKey={configQuery.data?.defaultJiraProjectKey ?? null}
              pollSeconds={configQuery.data?.pollIntervalSeconds ?? 30}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface SlackFeedProps {
  messagesQuery: ReturnType<typeof useQuery<{ messages: SlackMessage[] }, Error>>;
  defaultProjectKey: string | null;
  pollSeconds: number;
}

function SlackFeed({
  messagesQuery,
  defaultProjectKey,
  pollSeconds,
}: SlackFeedProps): React.ReactElement {
  const messages = messagesQuery.data?.messages ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [created, setCreated] = useState<Record<string, JiraCreatedIssue>>({});

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-text-tertiary">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'} · auto-refreshes every{' '}
          {pollSeconds}s
          {defaultProjectKey && (
            <>
              {' '}
              · files into <span className="font-mono text-primary">{defaultProjectKey}</span>
            </>
          )}
          {!defaultProjectKey && (
            <>
              {' '}
              ·{' '}
              <Link to="/settings" className="text-error hover:underline">
                no default project set
              </Link>
            </>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={(): void => {
            void messagesQuery.refetch();
          }}
          disabled={messagesQuery.isFetching}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${messagesQuery.isFetching ? 'animate-spin' : ''}`}
          />
          Refresh now
        </Button>
      </div>

      {messagesQuery.isError && (
        <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
          {messagesQuery.error.message}
        </div>
      )}

      {messages.length === 0 && !messagesQuery.isFetching && !messagesQuery.isError && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-text-tertiary">
          No messages yet. The configured channels are quiet — or the bot isn't in them. Try{' '}
          <code>/invite @&lt;your-bot&gt;</code> in the channel.
        </div>
      )}

      {messages.map(m => (
        <MessageCard
          key={m.id}
          message={m}
          expanded={expandedId === m.id}
          onExpandChange={(open): void => {
            setExpandedId(open ? m.id : null);
          }}
          createdIssue={created[m.id]}
          onCreated={(issue): void => {
            setCreated(prev => ({ ...prev, [m.id]: issue }));
            setExpandedId(null);
          }}
          defaultProjectKey={defaultProjectKey}
        />
      ))}
    </div>
  );
}

interface MessageCardProps {
  message: SlackMessage;
  expanded: boolean;
  onExpandChange: (open: boolean) => void;
  createdIssue: JiraCreatedIssue | undefined;
  onCreated: (issue: JiraCreatedIssue) => void;
  defaultProjectKey: string | null;
}

function MessageCard({
  message,
  expanded,
  onExpandChange,
  createdIssue,
  onCreated,
  defaultProjectKey,
}: MessageCardProps): React.ReactElement {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold text-text-primary">{message.userDisplay}</span>
        <span className="text-text-tertiary">in #{message.channelName}</span>
        <span className="text-text-tertiary">· {formatTimestamp(message.timestamp)}</span>
        <a
          href={message.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-text-tertiary hover:text-text-primary"
          title="Open in Slack"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <div className="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-primary">
        {message.text}
      </div>

      {createdIssue ? (
        <div className="mt-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-xs">
          Filed as{' '}
          <a
            href={createdIssue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-primary hover:underline"
          >
            {createdIssue.key}
          </a>
        </div>
      ) : (
        <div className="mt-2">
          <button
            onClick={(): void => {
              onExpandChange(!expanded);
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <MessageSquarePlus className="h-3 w-3" />
            Make Jira ticket
          </button>

          {expanded && (
            <CreateTicketForm
              message={message}
              defaultProjectKey={defaultProjectKey}
              onCreated={onCreated}
              onCancel={(): void => {
                onExpandChange(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface CreateTicketFormProps {
  message: SlackMessage;
  defaultProjectKey: string | null;
  onCreated: (issue: JiraCreatedIssue) => void;
  onCancel: () => void;
}

function CreateTicketForm({
  message,
  defaultProjectKey,
  onCreated,
  onCancel,
}: CreateTicketFormProps): React.ReactElement {
  const queryClient = useQueryClient();
  // Default summary = first ~80 chars of the message text on one line.
  const defaultSummary = useMemo(
    () => message.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    [message.text]
  );
  const [summary, setSummary] = useState(defaultSummary);
  const [extraDescription, setExtraDescription] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  // Keep the summary in sync if the user navigates between messages without
  // unmounting the form (rare but cheap).
  useEffect(() => {
    setSummary(defaultSummary);
  }, [defaultSummary]);

  const fullDescription = useMemo(() => {
    const parts: string[] = [];
    if (extraDescription.trim()) {
      parts.push(extraDescription.trim());
      parts.push(''); // blank line
    }
    parts.push(`From #${message.channelName} · ${message.userDisplay}`);
    parts.push(message.text);
    parts.push('');
    parts.push(`Slack: ${message.permalink}`);
    return parts.join('\n');
  }, [extraDescription, message]);

  const create = useMutation({
    mutationFn: () =>
      createJiraIssue({
        summary: summary.trim() || defaultSummary,
        description: fullDescription,
      }),
    onSuccess: issue => {
      onCreated(issue);
      // Refresh the assigned-tickets query so the new ticket appears
      // immediately in the GroupDetailPage tickets panel.
      void queryClient.invalidateQueries({ queryKey: ['jira-tickets'] });
    },
  });

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-surface-elevated p-3">
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium text-text-secondary">Summary</label>
        <Input
          value={summary}
          onChange={(e): void => {
            setSummary(e.target.value);
          }}
          maxLength={120}
          disabled={create.isPending}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium text-text-secondary">
          Extra context (optional)
        </label>
        <Textarea
          rows={3}
          value={extraDescription}
          onChange={(e): void => {
            setExtraDescription(e.target.value);
          }}
          placeholder="What you want to add above the Slack quote..."
          disabled={create.isPending}
        />
      </div>

      {showPreview && (
        <div className="rounded border border-border bg-background p-2 text-[11px] text-text-secondary whitespace-pre-wrap">
          {fullDescription}
        </div>
      )}

      {create.isError && (
        <div className="rounded-md border border-error/40 bg-error/5 px-2 py-1 text-[11px] text-error">
          {create.error.message}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={(): void => {
            create.mutate();
          }}
          disabled={!summary.trim() || !defaultProjectKey || create.isPending}
        >
          {create.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
          )}
          Create ticket{defaultProjectKey ? ` in ${defaultProjectKey}` : ''}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={(): void => {
            setShowPreview(prev => !prev);
          }}
        >
          {showPreview ? 'Hide preview' : 'Preview'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        {!defaultProjectKey && (
          <span className="ml-auto text-[11px] text-error">No default project — set one</span>
        )}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${String(diffMin)}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${String(diffHr)}h ago`;
  return d.toLocaleString();
}
