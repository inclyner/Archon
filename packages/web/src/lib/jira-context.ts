/**
 * Build the initial chat message that gets seeded when the user clicks
 * "Start chat" on a Jira ticket. The AI gets the full ticket context
 * (status, metadata, description, comments, links) instead of just the
 * key + summary, so the first response can be substantive instead of
 * "tell me more".
 *
 * ADF (Atlassian Document Format) → markdown conversion is intentionally
 * minimal — we lose some fidelity (panels, tables, attachments) but
 * preserve everything an LLM cares about. The shared AdfRenderer used
 * by the JiraIssuePage UI handles the same node set; this module is the
 * text-only sibling.
 */
import type { AdfNode, JiraIssueDetail, JiraCommentResponse } from '@/lib/api';

/**
 * Convert an ADF tree into a markdown-ish string. Best-effort; unknown
 * nodes are stringified as `[<type>]` so the LLM can at least see they
 * existed.
 */
export function adfToMarkdown(doc: AdfNode | null): string {
  if (!doc) return '';
  return renderNode(doc, 0).trim();
}

function renderNode(node: AdfNode, listDepth: number): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map(c => renderNode(c, listDepth)).join('\n\n');

    case 'paragraph':
      return (node.content ?? []).map(c => renderInline(c)).join('');

    case 'heading': {
      const level = clamp(attrNumber(node.attrs, 'level', 1), 1, 6);
      const hashes = '#'.repeat(level);
      const text = (node.content ?? []).map(c => renderInline(c)).join('');
      return `${hashes} ${text}`;
    }

    case 'bulletList':
      return (node.content ?? [])
        .map(item => `${'  '.repeat(listDepth)}- ${renderListItem(item, listDepth)}`)
        .join('\n');

    case 'orderedList':
      return (node.content ?? [])
        .map(
          (item, i) =>
            `${'  '.repeat(listDepth)}${String(i + 1)}. ${renderListItem(item, listDepth)}`
        )
        .join('\n');

    case 'codeBlock': {
      const lang = attrString(node.attrs, 'language', '');
      const body = (node.content ?? []).map(c => renderInline(c)).join('');
      return '```' + lang + '\n' + body + '\n```';
    }

    case 'blockquote':
      return (node.content ?? [])
        .map(c => renderNode(c, listDepth))
        .join('\n\n')
        .split('\n')
        .map(l => `> ${l}`)
        .join('\n');

    case 'rule':
      return '---';

    case 'panel':
    case 'expand':
      return (node.content ?? []).map(c => renderNode(c, listDepth)).join('\n\n');

    case 'table':
      return renderTable(node);

    case 'mediaGroup':
    case 'mediaSingle':
      return '*[attachment — view in Jira]*';

    default:
      // Inline node at the block level (rare). Just inline it.
      return renderInline(node);
  }
}

function renderListItem(item: AdfNode, listDepth: number): string {
  // listItem typically wraps one or more paragraphs / nested lists.
  return (item.content ?? [])
    .map((c, i) => {
      // For nested lists, recurse deeper. For paragraphs, render inline.
      if (c.type === 'bulletList' || c.type === 'orderedList') {
        return '\n' + renderNode(c, listDepth + 1);
      }
      const block = renderNode(c, listDepth);
      return i === 0 ? block : '\n' + block;
    })
    .join('')
    .trim();
}

function renderInline(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      let text = node.text ?? '';
      const marks = node.marks ?? [];
      for (const mark of marks) {
        switch (mark.type) {
          case 'strong':
            text = `**${text}**`;
            break;
          case 'em':
            text = `*${text}*`;
            break;
          case 'code':
            text = `\`${text}\``;
            break;
          case 'strike':
            text = `~~${text}~~`;
            break;
          case 'link': {
            const href = attrString(mark.attrs, 'href', '#');
            text = `[${text}](${href})`;
            break;
          }
        }
      }
      return text;
    }

    case 'hardBreak':
      return '\n';

    case 'mention':
      return `@${attrString(node.attrs, 'text') || attrString(node.attrs, 'id', 'user')}`;

    case 'emoji':
      return attrString(node.attrs, 'text') || attrString(node.attrs, 'shortName');

    case 'inlineCard':
      return attrString(node.attrs, 'url', '');

    case 'paragraph':
      // Sometimes paragraphs nest inside table cells etc. — flatten inline.
      return (node.content ?? []).map(c => renderInline(c)).join('');

    default:
      return (node.content ?? []).map(c => renderInline(c)).join('');
  }
}

function renderTable(node: AdfNode): string {
  const rows = (node.content ?? []).filter(r => r.type === 'tableRow');
  if (rows.length === 0) return '';
  const lines: string[] = [];
  rows.forEach((row, rIdx) => {
    const cells = (row.content ?? []).map(
      cell =>
        (cell.content ?? [])
          .map(c => renderInline(c))
          .join(' ')
          .trim() || ' '
    );
    lines.push('| ' + cells.join(' | ') + ' |');
    if (rIdx === 0) {
      lines.push('|' + cells.map(() => ' --- ').join('|') + '|');
    }
  });
  return lines.join('\n');
}

/**
 * Build the initial chat message from a fully-fetched ticket (issue +
 * comments). Caller passes both because the JiraIssuePage already has
 * them loaded; the list view has to fetch them on click.
 *
 * Output is a single markdown string suitable as the first user message
 * to the AI. ~5-15 KB typical, more for long-running tickets.
 */
export function buildJiraChatSeed(issue: JiraIssueDetail, comments: JiraCommentResponse[]): string {
  const lines: string[] = [];
  lines.push(`Working on **${issue.key}**: ${issue.summary}`);
  lines.push('');
  lines.push(`- Status: ${issue.status}`);
  lines.push(`- Type: ${issue.issueType}`);
  lines.push(`- Priority: ${issue.priority ?? '—'}`);
  lines.push(`- Assignee: ${issue.assignee?.name ?? 'Unassigned'}`);
  lines.push(`- Reporter: ${issue.reporter?.name ?? '—'}`);
  if (issue.labels.length > 0) {
    lines.push(`- Labels: ${issue.labels.join(', ')}`);
  }
  lines.push(`- Project: ${issue.projectKey}`);
  lines.push(`- Updated: ${formatRelative(issue.updated)}`);
  lines.push(`- Ticket: ${issue.url}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  const desc = adfToMarkdown(issue.description);
  lines.push(desc || '*(no description)*');

  if (comments.length > 0) {
    lines.push('');
    lines.push(`## Comments (${String(comments.length)})`);
    lines.push('');
    // Oldest-first to match how Jira renders threads.
    const sorted = [...comments].sort((a, b) => (a.created < b.created ? -1 : 1));
    for (const c of sorted) {
      const who = c.author?.name ?? 'unknown';
      const when = formatRelative(c.created);
      lines.push(`### ${who} · ${when}`);
      lines.push('');
      const body = adfToMarkdown(c.body);
      lines.push(body || '*(empty comment)*');
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

// ─── seed handoff (Jira/Slack page → /chat/<id>) ────────────────────────────
//
// React Router's `navigate(path, { state })` is supposed to pass arbitrary
// data across navigations, but in this app it landed empty by the time
// ChatInterface mounted (likely a remount-on-key-change race). sessionStorage
// is bulletproof: write before navigate, read on mount, delete after.
//
// Keyed by conversationId so:
//   - Back/forward to the same conversation doesn't re-seed (correct: the
//     user has already started typing).
//   - Multiple seeded chats in the same tab don't collide.
//   - New tab gets its own sessionStorage and doesn't re-seed stale stuff.

const SEED_KEY_PREFIX = 'archon-chat-seed:';

export function stashChatSeed(conversationId: string, seed: string): void {
  try {
    sessionStorage.setItem(SEED_KEY_PREFIX + conversationId, seed);
  } catch {
    // sessionStorage unavailable (private browsing) — caller falls back
    // to whatever it was doing before. Not fatal, just less ergonomic.
  }
}

export function consumeChatSeed(conversationId: string): string | null {
  try {
    const v = sessionStorage.getItem(SEED_KEY_PREFIX + conversationId);
    if (v != null) sessionStorage.removeItem(SEED_KEY_PREFIX + conversationId);
    return v;
  } catch {
    return null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function attrString(
  attrs: Record<string, unknown> | undefined,
  key: string,
  fallback = ''
): string {
  const v = attrs?.[key];
  return typeof v === 'string' ? v : fallback;
}

function attrNumber(
  attrs: Record<string, unknown> | undefined,
  key: string,
  fallback: number
): number {
  const v = attrs?.[key];
  return typeof v === 'number' ? v : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
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
