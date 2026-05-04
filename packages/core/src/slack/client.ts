/**
 * Minimal Slack client for the inbox feature.
 *
 * Token resolution (DB beats env, same pattern as the Jira client):
 *   1. slack.bot_token in app_settings — UI-managed override
 *   2. SLACK_BOT_TOKEN env var — REUSES the same token Archon's existing
 *      bot adapter (packages/adapters/src/chat/slack/) already reads
 *
 * So the user normally doesn't need to enter a token at all — just add
 * the required scopes to their existing Slack app and configure channel
 * IDs in Settings → Slack. Required scopes for the inbox:
 *   - channels:history  (read public channel messages)
 *   - groups:history    (read private channel messages)
 *   - users:read        (resolve user IDs to display names)
 *
 * Other settings persisted in app_settings:
 *   slack.channel_ids               — JSON array of channel IDs to read from
 *   slack.poll_interval_seconds     — UI auto-poll cadence
 *   slack.default_jira_project_key  — where "Make Jira ticket" files into
 *
 * No webhooks (Slack Events API). Polling from the UI keeps this
 * self-hostable on localhost without a public ingress (ngrok etc.),
 * matching the rest of Archon's defaults.
 */
import { createLogger } from '@archon/paths';
import { getAppSettings, setAppSetting, deleteAppSetting } from '../db/app-settings';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('slack.client');
  return cachedLog;
}

const SETTING_KEYS = [
  'slack.bot_token',
  'slack.channel_ids',
  'slack.poll_interval_seconds',
  'slack.default_jira_project_key',
] as const;

export interface SlackConfig {
  token: string;
  channelIds: string[];
  pollIntervalSeconds: number;
}

export interface SlackConfigStatus {
  configured: boolean;
  hasToken: boolean;
  /** Where the active token came from. */
  tokenSource: 'db' | 'env' | 'none';
  channelIds: string[];
  pollIntervalSeconds: number;
  defaultJiraProjectKey: string | null;
}

/** Resolve the active token. DB row wins; env var is the fallback. */
function resolveToken(dbVal: string | null | undefined): {
  token: string | null;
  source: 'db' | 'env' | 'none';
} {
  const fromDb = dbVal?.trim();
  if (fromDb) return { token: fromDb, source: 'db' };
  const fromEnv = process.env.SLACK_BOT_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  return { token: null, source: 'none' };
}

export async function getSlackConfig(): Promise<SlackConfig | null> {
  const vals = await getAppSettings([...SETTING_KEYS]);
  const { token } = resolveToken(vals['slack.bot_token']);
  const channelIdsRaw = vals['slack.channel_ids'];
  const pollRaw = vals['slack.poll_interval_seconds'];
  if (!token || !channelIdsRaw) return null;
  let channelIds: string[];
  try {
    const parsed = JSON.parse(channelIdsRaw) as unknown;
    if (!Array.isArray(parsed)) return null;
    channelIds = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return null;
  }
  if (channelIds.length === 0) return null;
  const pollIntervalSeconds = pollRaw ? Math.max(10, Number(pollRaw)) : 30;
  return { token, channelIds, pollIntervalSeconds };
}

export async function getSlackConfigStatus(): Promise<SlackConfigStatus> {
  const vals = await getAppSettings([...SETTING_KEYS]);
  const { token, source: tokenSource } = resolveToken(vals['slack.bot_token']);
  const hasToken = Boolean(token);
  const channelIdsRaw = vals['slack.channel_ids'];
  let channelIds: string[] = [];
  if (channelIdsRaw) {
    try {
      const parsed = JSON.parse(channelIdsRaw) as unknown;
      if (Array.isArray(parsed)) {
        channelIds = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
      }
    } catch {
      // malformed; leave empty
    }
  }
  const pollRaw = vals['slack.poll_interval_seconds'];
  const pollIntervalSeconds = pollRaw ? Math.max(10, Number(pollRaw)) : 30;
  const defaultJiraProjectKey = vals['slack.default_jira_project_key'] ?? null;
  return {
    configured: hasToken && channelIds.length > 0,
    hasToken,
    tokenSource,
    channelIds,
    pollIntervalSeconds,
    defaultJiraProjectKey,
  };
}

/**
 * Returns the project key the user picked in Settings → Slack (or null if
 * not set). Used by the create-ticket endpoint to know where to file.
 */
export async function getDefaultJiraProjectKey(): Promise<string | null> {
  const vals = await getAppSettings(['slack.default_jira_project_key']);
  return vals['slack.default_jira_project_key'] ?? null;
}

export async function saveSlackConfig(input: {
  token?: string;
  channelIds?: string[];
  pollIntervalSeconds?: number;
  defaultJiraProjectKey?: string;
}): Promise<void> {
  if (input.token !== undefined) await setAppSetting('slack.bot_token', input.token);
  if (input.channelIds !== undefined) {
    await setAppSetting('slack.channel_ids', JSON.stringify(input.channelIds));
  }
  if (input.pollIntervalSeconds !== undefined) {
    await setAppSetting('slack.poll_interval_seconds', String(input.pollIntervalSeconds));
  }
  if (input.defaultJiraProjectKey !== undefined) {
    await setAppSetting('slack.default_jira_project_key', input.defaultJiraProjectKey);
  }
}

export async function clearSlackConfig(): Promise<void> {
  for (const k of SETTING_KEYS) await deleteAppSetting(k);
}

export interface SlackMessage {
  /** Composite id: channelId:ts. Stable across polls; UI uses it as React key. */
  id: string;
  channelId: string;
  channelName: string;
  ts: string;
  /** ISO timestamp derived from ts (Slack ts is "1700000000.123456"). */
  timestamp: string;
  userId: string | null;
  /** Resolved via users.info; falls back to userId when lookup fails. */
  userDisplay: string;
  text: string;
  /** Permalink to the message in Slack (slack.com/archives/<channel>/p<ts>). */
  permalink: string;
  /**
   * Thread parent timestamp. Null for non-threaded messages, equal to `ts`
   * for thread parents themselves, and equal to the parent's ts for replies.
   * UI uses this to know when to render a "🧵 N replies" expander.
   */
  threadTs: string | null;
  /** Number of replies in the thread. 0 for non-threaded messages. */
  replyCount: number;
  /** ISO timestamp of the most recent reply, if any. */
  latestReply: string | null;
}

interface SlackHistoryEntry {
  type: string;
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  /** Present on thread parents AND replies; absent on non-threaded messages. */
  thread_ts?: string;
  /** Only present on thread parents. Replies don't carry this. */
  reply_count?: number;
  /** ISO-ish ts of the most recent reply. Only on thread parents. */
  latest_reply?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackHistoryEntry[];
}

interface SlackChannelInfoResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string; name: string };
}

interface SlackUserInfoResponse {
  ok: boolean;
  error?: string;
  user?: { id: string; real_name?: string; name?: string };
}

/**
 * Slack uses application/x-www-form-urlencoded POST bodies for "Web API"
 * methods (a quirk of their original design). We always POST + URL-encode.
 */
async function slackCall<T>(
  token: string,
  method: string,
  params: Record<string, string>
): Promise<T> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Slack ${method} HTTP ${String(res.status)}: ${(await res.text()).slice(0, 200)}`
    );
  }
  return (await res.json()) as T;
}

/**
 * In-memory caches. Persistent caching is overkill for a single-developer
 * tool; on server restart we rehydrate on the next request.
 */
const channelNameCache = new Map<string, string>();
const userDisplayCache = new Map<string, string>();

async function resolveChannelName(token: string, channelId: string): Promise<string> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;
  try {
    const r = await slackCall<SlackChannelInfoResponse>(token, 'conversations.info', {
      channel: channelId,
    });
    if (r.ok && r.channel) {
      channelNameCache.set(channelId, r.channel.name);
      return r.channel.name;
    }
  } catch (e) {
    getLog().warn({ err: e as Error, channelId }, 'slack.channel_info_failed');
  }
  return channelId; // fall back to id so the UI can still render
}

/**
 * Slack message text contains mentions and links in their wire format:
 *   <@U12345>           — user mention
 *   <#C12345|name>      — channel mention
 *   <!here>, <!channel> — special mentions
 *   <https://url|text>  — link with display text
 *   <https://url>       — bare URL
 *
 * We rewrite all of these into a human-readable form. User IDs are
 * resolved to display names via the same in-memory cache the message
 * loop uses (no extra API calls if the user has appeared anywhere else).
 *
 * Channel IDs we don't bother resolving — Slack's wire format already
 * embeds the name after the `|`. We just strip the brackets.
 */
async function rewriteMentions(token: string, text: string): Promise<string> {
  // Collect all <@USERID> matches up front so we can resolve them in one
  // pass without holding the regex engine in an async loop.
  const userIdMatches = Array.from(text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g));
  const idToName = new Map<string, string>();
  for (const match of userIdMatches) {
    const id = match[1];
    if (idToName.has(id)) continue;
    idToName.set(id, await resolveUserDisplay(token, id));
  }

  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (_, id: string) => `@${idToName.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, (_, name: string) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, (_, id: string) => `#${id}`)
    .replace(/<!here>/g, '@here')
    .replace(/<!channel>/g, '@channel')
    .replace(/<!everyone>/g, '@everyone')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, (_, name: string) => `@${name}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, _url: string, label: string) => label)
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url: string) => url)
    .replace(/<mailto:([^|>]+)(?:\|[^>]+)?>/g, (_, email: string) => email);
}

async function resolveUserDisplay(token: string, userId: string): Promise<string> {
  const cached = userDisplayCache.get(userId);
  if (cached) return cached;
  try {
    const r = await slackCall<SlackUserInfoResponse>(token, 'users.info', { user: userId });
    if (r.ok && r.user) {
      const name = r.user.real_name ?? r.user.name ?? userId;
      userDisplayCache.set(userId, name);
      return name;
    }
  } catch (e) {
    getLog().warn({ err: e as Error, userId }, 'slack.user_info_failed');
  }
  return userId;
}

/**
 * Fetch the last `perChannelLimit` messages from each configured channel,
 * resolve channel and user names, and return them sorted newest-first.
 *
 * Subtype-handling: skip channel_join / channel_leave noise; keep regular
 * user messages and bot messages. (Bot messages are mostly app integrations
 * which often ARE the bug reports we want to file tickets from.)
 */
export async function getRecentMessages(
  cfg: SlackConfig,
  perChannelLimit = 25
): Promise<SlackMessage[]> {
  const SKIP_SUBTYPES = new Set([
    'channel_join',
    'channel_leave',
    'channel_topic',
    'channel_purpose',
    'channel_name',
  ]);

  const out: SlackMessage[] = [];
  for (const channelId of cfg.channelIds) {
    let history: SlackHistoryResponse;
    try {
      history = await slackCall<SlackHistoryResponse>(cfg.token, 'conversations.history', {
        channel: channelId,
        limit: String(perChannelLimit),
      });
    } catch (e) {
      getLog().warn({ err: e as Error, channelId }, 'slack.history_call_failed');
      continue;
    }
    if (!history.ok) {
      getLog().warn({ error: history.error, channelId }, 'slack.history_returned_error');
      // Surface 'not_in_channel' / 'missing_scope' as a thrown error on the
      // FIRST channel so the UI can show actionable text. Subsequent channels
      // we just log and skip — partial results beat a hard fail.
      if (out.length === 0) {
        throw new Error(
          `Slack returned "${history.error ?? 'unknown'}" for channel ${channelId}. ` +
            (history.error === 'not_in_channel'
              ? 'Invite the bot to that channel: /invite @<bot> in the channel.'
              : history.error === 'missing_scope'
                ? 'Bot is missing channels:history / groups:history scope. Re-grant at api.slack.com/apps.'
                : 'Check the token and channel id.')
        );
      }
      continue;
    }
    const channelName = await resolveChannelName(cfg.token, channelId);
    for (const m of history.messages ?? []) {
      if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) continue;
      if (!m.text || m.text.trim().length === 0) continue;
      const userId = m.user ?? null;
      const userDisplay = userId
        ? await resolveUserDisplay(cfg.token, userId)
        : (m.bot_id ?? 'bot');
      const tsNum = Number(m.ts);
      const timestamp = Number.isFinite(tsNum)
        ? new Date(tsNum * 1000).toISOString()
        : new Date().toISOString();
      out.push({
        id: `${channelId}:${m.ts}`,
        channelId,
        channelName,
        ts: m.ts,
        timestamp,
        userId,
        userDisplay,
        text: await rewriteMentions(cfg.token, m.text),
        // Slack permalinks: slack.com/archives/<channel>/p<ts-without-dot>
        permalink: `https://slack.com/archives/${channelId}/p${m.ts.replace('.', '')}`,
        threadTs: m.thread_ts ?? null,
        replyCount: m.reply_count ?? 0,
        latestReply: m.latest_reply ? new Date(Number(m.latest_reply) * 1000).toISOString() : null,
      });
    }
  }
  // Newest first.
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out;
}

/**
 * Fetch all replies in a thread (excluding the parent — Slack returns the
 * parent first, we strip it). Used by the inbox's "🧵 N replies" expander.
 *
 * Slack's `conversations.replies` always echoes the parent as the first
 * item; the UI already shows the parent in the feed, so we drop it.
 */
export async function getThreadReplies(
  cfg: SlackConfig,
  channelId: string,
  threadTs: string
): Promise<SlackMessage[]> {
  let history: SlackHistoryResponse;
  try {
    history = await slackCall<SlackHistoryResponse>(cfg.token, 'conversations.replies', {
      channel: channelId,
      ts: threadTs,
      limit: '100',
    });
  } catch (e) {
    getLog().warn({ err: e as Error, channelId, threadTs }, 'slack.replies_call_failed');
    throw e;
  }
  if (!history.ok) {
    throw new Error(
      `Slack returned "${history.error ?? 'unknown'}" for thread ${threadTs} in ${channelId}.`
    );
  }
  const channelName = await resolveChannelName(cfg.token, channelId);
  const out: SlackMessage[] = [];
  for (const m of history.messages ?? []) {
    // The first item in Slack's reply list is the parent — skip it.
    if (m.ts === threadTs) continue;
    if (!m.text || m.text.trim().length === 0) continue;
    const userId = m.user ?? null;
    const userDisplay = userId ? await resolveUserDisplay(cfg.token, userId) : (m.bot_id ?? 'bot');
    const tsNum = Number(m.ts);
    const timestamp = Number.isFinite(tsNum)
      ? new Date(tsNum * 1000).toISOString()
      : new Date().toISOString();
    out.push({
      id: `${channelId}:${m.ts}`,
      channelId,
      channelName,
      ts: m.ts,
      timestamp,
      userId,
      userDisplay,
      text: await rewriteMentions(cfg.token, m.text),
      permalink: `https://slack.com/archives/${channelId}/p${m.ts.replace('.', '')}?thread_ts=${threadTs}`,
      threadTs: m.thread_ts ?? threadTs,
      replyCount: 0,
      latestReply: null,
    });
  }
  // Replies in chronological order — older first, newer last (matches Slack UI).
  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return out;
}

/**
 * Quick auth check for the "Test connection" button. Calls auth.test and
 * returns the bot's display name on success.
 */
export async function verifySlackToken(
  token: string
): Promise<{ teamName: string; botName: string }> {
  interface AuthTest {
    ok: boolean;
    error?: string;
    team?: string;
    user?: string;
  }
  const r = await slackCall<AuthTest>(token, 'auth.test', {});
  if (!r.ok) {
    throw new Error(
      `Slack auth.test failed: ${r.error ?? 'unknown'}. ${
        r.error === 'invalid_auth'
          ? 'Token is invalid. Generate a fresh Bot User OAuth Token at api.slack.com/apps.'
          : ''
      }`
    );
  }
  return { teamName: r.team ?? 'unknown', botName: r.user ?? 'bot' };
}
