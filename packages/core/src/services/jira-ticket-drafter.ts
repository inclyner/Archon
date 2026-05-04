/**
 * AI-powered Jira ticket drafter for the Slack inbox.
 *
 * Given a Slack message + optional user-supplied extra context, asks the
 * configured AI provider to draft a clean ticket title + structured
 * description + suggested issue type. Mirrors the pattern in
 * services/title-generator.ts: one-shot LLM call, no tools, plain text +
 * structured output via JSON.
 *
 * Always returns SOMETHING — falls back to a verbatim summary if the AI
 * call or JSON parse fails. Callers shouldn't have to handle a null.
 */
import { getAgentProvider } from '@archon/providers';
import { createLogger } from '@archon/paths';
import { getArchonWorkspacesPath } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('service.jira-ticket-drafter');
  return cachedLog;
}

export interface DraftTicketInput {
  /** Raw Slack message text. */
  messageText: string;
  /** Channel name without `#`. */
  channelName: string;
  /** Display name of the message author. */
  userDisplay: string;
  /** Slack permalink to the message. */
  slackPermalink: string;
  /**
   * Anything the user typed into the "Extra context" field before hitting
   * ✨ Suggest. We feed it to the AI as additional info — Claude treats it
   * as authoritative ("the user already knows X about this bug").
   */
  extraContext?: string;
}

export interface DraftTicket {
  /** Concise ticket title (≤120 chars). */
  summary: string;
  /**
   * Markdown body for the ticket. Sections like "## Reported", "## Symptom",
   * "## Source" — the caller appends the Slack quote + permalink itself, so
   * this should NOT include them.
   */
  extraContext: string;
  /** AI's best guess: 'Bug' / 'Task' / 'Story' / 'Improvement'. */
  issueType: 'Bug' | 'Task' | 'Story' | 'Improvement';
  /** Best-effort severity hint. May be ignored by the caller. */
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Draft a Jira ticket from a Slack message. Always returns a result —
 * falls back to a sensible default if the AI call fails so the UI never
 * deadends.
 */
export async function draftJiraTicket(
  input: DraftTicketInput,
  assistantType: string
): Promise<DraftTicket> {
  try {
    // Reuse TITLE_GENERATION_MODEL when set — the user already opted into
    // a cheap/fast model for ambient AI tasks like this. Otherwise SDK
    // default. (We could add JIRA_DRAFT_MODEL too; keeping the surface
    // small for now.)
    const model = process.env.TITLE_GENERATION_MODEL || undefined;

    const prompt = buildPrompt(input);
    const client = getAgentProvider(assistantType);
    let raw = '';
    for await (const chunk of client.sendQuery(prompt, getArchonWorkspacesPath(), undefined, {
      model,
      nodeConfig: { allowed_tools: [] }, // no tools — pure text generation
    })) {
      if (chunk.type === 'assistant') {
        raw += chunk.content;
      }
    }

    const parsed = parseJsonBlob(raw);
    if (parsed) {
      return parsed;
    }

    getLog().warn({ rawLen: raw.length, snippet: raw.slice(0, 200) }, 'jira_drafter.parse_failed');
    return fallback(input);
  } catch (err) {
    getLog().warn({ err: err as Error }, 'jira_drafter.ai_call_failed');
    return fallback(input);
  }
}

function buildPrompt(input: DraftTicketInput): string {
  const extra = input.extraContext?.trim()
    ? `\n\nThe user has added this extra context (treat as authoritative):\n${input.extraContext.trim()}`
    : '';
  return `You are drafting a Jira ticket from a Slack message. Return JSON ONLY (no prose, no code fences) matching this exact shape:

{
  "summary": "string, 5-12 words, action-oriented, no trailing period",
  "extraContext": "string, markdown with 2-4 short sections like ## Reported / ## Symptom / ## Browser scope / ## Affected component. Skip sections that don't apply. Keep each section to 1-3 sentences. Do NOT quote the original message — the caller appends it. Do NOT include a Slack permalink — the caller appends it.",
  "issueType": "Bug | Task | Story | Improvement",
  "severity": "low | medium | high | critical"
}

Rules:
- summary: capture the bug or request, not the speaker. Bad: "Customer reported pricing bug". Good: "Pricing page shows $0 for Enterprise on Safari mobile".
- issueType: Bug for something broken, Task for work that needs doing, Story for a user-facing feature, Improvement for an enhancement to existing behavior. Default to Task if ambiguous.
- severity: high for customer-impacting / payment / auth / data-loss; medium for broken-but-workaround-exists; low for cosmetic; critical only for outage / security.

Slack message:
- Channel: #${input.channelName}
- Author: ${input.userDisplay}
- Text: ${input.messageText}${extra}

Return JSON now:`;
}

function parseJsonBlob(raw: string): DraftTicket | null {
  // Strip code fences if the model added any despite the "no fences" rule.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const extraContext = typeof obj.extraContext === 'string' ? obj.extraContext.trim() : '';
  if (!summary) return null;

  const issueTypeRaw = typeof obj.issueType === 'string' ? obj.issueType : 'Task';
  const issueType: DraftTicket['issueType'] =
    (['Bug', 'Task', 'Story', 'Improvement'] as const).find(
      t => t.toLowerCase() === issueTypeRaw.toLowerCase()
    ) ?? 'Task';

  const severityRaw = typeof obj.severity === 'string' ? obj.severity.toLowerCase() : 'medium';
  const severity: DraftTicket['severity'] =
    (['low', 'medium', 'high', 'critical'] as const).find(s => s === severityRaw) ?? 'medium';

  return {
    summary: summary.slice(0, 120),
    extraContext,
    issueType,
    severity,
  };
}

/**
 * Sensible default when AI is unreachable / parse fails. Same shape the
 * existing UI already produces by hand — we don't want a worse experience
 * than not pressing the button at all.
 */
function fallback(input: DraftTicketInput): DraftTicket {
  const summary = input.messageText.replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    summary,
    extraContext: input.extraContext?.trim() ?? '',
    issueType: 'Task',
    severity: 'medium',
  };
}
