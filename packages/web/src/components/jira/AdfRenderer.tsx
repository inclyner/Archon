/**
 * Render Atlassian Document Format (ADF) into React. ADF is a tree of
 * `{ type, content }` nodes. This handles the ~95% case (paragraphs,
 * headings, lists, code, links, mentions, emoji, hard breaks) and falls
 * back to a "[unsupported: <type>]" sentinel for anything exotic so we
 * see what's missing rather than rendering it invisibly.
 *
 * Reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */
import { createElement } from 'react';
import type { AdfNode } from '@/lib/api';

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * ADF attrs are typed `Record<string, unknown>` because Atlassian's spec
 * varies per node type. Safely coerce a single key to a string, with a
 * fallback for missing/non-string values.
 */
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

function renderText(text: string, marks: Mark[] | undefined, key: string): React.ReactNode {
  if (!marks || marks.length === 0) return text;
  // Apply marks outside-in so the innermost is closest to the text.
  let node: React.ReactNode = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        node = <strong key={key}>{node}</strong>;
        break;
      case 'em':
        node = <em key={key}>{node}</em>;
        break;
      case 'code':
        node = (
          <code
            key={key}
            className="rounded bg-surface-elevated px-1 py-0.5 text-[0.85em] font-mono"
          >
            {node}
          </code>
        );
        break;
      case 'strike':
        node = <s key={key}>{node}</s>;
        break;
      case 'underline':
        node = <u key={key}>{node}</u>;
        break;
      case 'link': {
        const href = attrString(mark.attrs, 'href', '#');
        node = (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {node}
          </a>
        );
        break;
      }
      case 'subsup': {
        const isSub = mark.attrs?.type === 'sub';
        node = isSub ? <sub key={key}>{node}</sub> : <sup key={key}>{node}</sup>;
        break;
      }
      // Unknown marks: pass through unstyled rather than crashing.
    }
  }
  return node;
}

function renderNode(node: AdfNode, key: string): React.ReactNode {
  switch (node.type) {
    case 'doc':
      return <>{(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}</>;

    case 'paragraph':
      return (
        <p key={key} className="my-2 leading-relaxed">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </p>
      );

    case 'heading': {
      const level = Math.min(6, Math.max(1, attrNumber(node.attrs, 'level', 1)));
      const cls =
        level === 1
          ? 'mt-4 mb-2 text-lg font-semibold'
          : level === 2
            ? 'mt-3 mb-1.5 text-base font-semibold'
            : 'mt-2 mb-1 text-sm font-semibold';
      const children = (node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`));
      // Dynamic heading level — use createElement to dodge the lint rule
      // around capitalised JSX-tag variables.
      return createElement(`h${String(level)}`, { key, className: cls }, children);
    }

    case 'text':
      return (
        <span key={key}>{renderText(node.text ?? '', node.marks as Mark[] | undefined, key)}</span>
      );

    case 'hardBreak':
      return <br key={key} />;

    case 'bulletList':
      return (
        <ul key={key} className="my-2 list-disc pl-5">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </ul>
      );

    case 'orderedList':
      return (
        <ol key={key} className="my-2 list-decimal pl-5">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </ol>
      );

    case 'listItem':
      return (
        <li key={key} className="my-0.5">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </li>
      );

    case 'codeBlock':
      return (
        <pre
          key={key}
          className="my-2 overflow-x-auto rounded-md border border-border bg-surface-elevated px-3 py-2 text-[12px] font-mono leading-snug"
        >
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </pre>
      );

    case 'blockquote':
      return (
        <blockquote key={key} className="my-2 border-l-2 border-border pl-3 text-text-secondary">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </blockquote>
      );

    case 'rule':
      return <hr key={key} className="my-3 border-border" />;

    case 'mention':
      return (
        <span key={key} className="rounded bg-primary/10 px-1 text-[0.95em] text-primary">
          @{attrString(node.attrs, 'text') || attrString(node.attrs, 'id', 'user')}
        </span>
      );

    case 'emoji':
      return (
        <span key={key}>
          {attrString(node.attrs, 'text') || attrString(node.attrs, 'shortName')}
        </span>
      );

    case 'inlineCard': {
      const url = attrString(node.attrs, 'url', '#');
      return (
        <a
          key={key}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {url}
        </a>
      );
    }

    case 'panel':
    case 'expand':
      // Panels/expands wrap content; render their children in a tinted box.
      return (
        <div
          key={key}
          className="my-2 rounded-md border border-border bg-surface-elevated px-3 py-2"
        >
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </div>
      );

    case 'table':
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
            </tbody>
          </table>
        </div>
      );

    case 'tableRow':
      return (
        <tr key={key} className="border-b border-border">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </tr>
      );

    case 'tableHeader':
      return (
        <th key={key} className="border border-border bg-surface-elevated px-2 py-1 text-left">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </th>
      );

    case 'tableCell':
      return (
        <td key={key} className="border border-border px-2 py-1 align-top">
          {(node.content ?? []).map((c, i) => renderNode(c, `${key}-${String(i)}`))}
        </td>
      );

    case 'mediaGroup':
    case 'mediaSingle':
      // We don't render embedded media (Jira attachments need a separate
      // auth flow to fetch). Show a placeholder so the user knows there's
      // something there and can click through to Jira to view it.
      return (
        <div
          key={key}
          className="my-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-text-tertiary"
        >
          [attachment — view in Jira]
        </div>
      );

    default:
      return (
        <span
          key={key}
          className="text-[11px] text-text-tertiary"
          title={`Unsupported ADF node: ${node.type}`}
        >
          [unsupported: {node.type}]
        </span>
      );
  }
}

export function AdfRenderer({ doc }: { doc: AdfNode | null }): React.ReactElement {
  if (!doc) {
    return <p className="text-sm italic text-text-tertiary">No description.</p>;
  }
  return <div className="text-sm text-text-primary">{renderNode(doc, 'root')}</div>;
}
