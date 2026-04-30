/**
 * Minimal Jira Cloud REST client for Phase D.
 *
 * Reads creds from (in order): app_settings DB rows → JIRA_HOST/JIRA_EMAIL/
 * JIRA_API_TOKEN env vars. Returns null if neither source has the full set.
 *
 * Auth: HTTP Basic with `email:token` per Atlassian's docs. The "API token"
 * here is what you generate at id.atlassian.com/manage-profile/security/
 * api-tokens — NOT the OAuth flow.
 */
import { createLogger } from '@archon/paths';
import { getAppSettings, setAppSetting, deleteAppSetting } from '../db/app-settings';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('jira.client');
  return cachedLog;
}

const SETTING_KEYS = ['jira.host', 'jira.email', 'jira.token'] as const;

export interface JiraCreds {
  host: string; // e.g. "rimontech.atlassian.net" — no scheme, no trailing slash
  email: string;
  token: string;
}

export interface JiraConfigStatus {
  configured: boolean;
  host: string | null;
  email: string | null;
  /** Indicates we have a token without exposing it. */
  hasToken: boolean;
  /** Where the configured value comes from, for the UI to be honest about overrides. */
  source: 'db' | 'env' | 'none';
}

/**
 * Resolve the active credentials. DB rows beat env vars (UI-set values
 * always win); env vars are the fallback for power users who'd rather edit
 * .env. Returns null if either source is incomplete.
 */
export async function getJiraCreds(): Promise<JiraCreds | null> {
  const dbVals = await getAppSettings([...SETTING_KEYS]);
  const dbHost = dbVals['jira.host'];
  const dbEmail = dbVals['jira.email'];
  const dbToken = dbVals['jira.token'];
  if (dbHost && dbEmail && dbToken) {
    return { host: normalizeHost(dbHost), email: dbEmail, token: dbToken };
  }
  const envHost = process.env.JIRA_HOST?.trim();
  const envEmail = process.env.JIRA_EMAIL?.trim();
  const envToken = process.env.JIRA_API_TOKEN?.trim();
  if (envHost && envEmail && envToken) {
    return { host: normalizeHost(envHost), email: envEmail, token: envToken };
  }
  return null;
}

export async function getJiraConfigStatus(): Promise<JiraConfigStatus> {
  const dbVals = await getAppSettings([...SETTING_KEYS]);
  const dbHost = dbVals['jira.host'];
  const dbEmail = dbVals['jira.email'];
  const dbToken = dbVals['jira.token'];
  if (dbHost && dbEmail && dbToken) {
    return { configured: true, host: dbHost, email: dbEmail, hasToken: true, source: 'db' };
  }
  const envHost = process.env.JIRA_HOST?.trim();
  const envEmail = process.env.JIRA_EMAIL?.trim();
  const envToken = process.env.JIRA_API_TOKEN?.trim();
  if (envHost && envEmail && envToken) {
    return {
      configured: true,
      host: envHost,
      email: envEmail,
      hasToken: true,
      source: 'env',
    };
  }
  // Not fully configured. Surface whatever partial DB values exist so the UI
  // can prefill the form correctly.
  return {
    configured: false,
    host: dbHost ?? envHost ?? null,
    email: dbEmail ?? envEmail ?? null,
    hasToken: Boolean(dbToken ?? envToken),
    source: 'none',
  };
}

export async function saveJiraCreds(creds: JiraCreds): Promise<void> {
  await setAppSetting('jira.host', normalizeHost(creds.host));
  await setAppSetting('jira.email', creds.email);
  await setAppSetting('jira.token', creds.token);
}

export async function clearJiraCreds(): Promise<void> {
  for (const k of SETTING_KEYS) await deleteAppSetting(k);
}

function normalizeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function authHeader(creds: JiraCreds): string {
  const token = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
  return `Basic ${token}`;
}

export interface JiraTicket {
  key: string; // e.g. "RH-1050"
  summary: string;
  status: string;
  statusCategory: 'todo' | 'inprogress' | 'done' | 'unknown';
  url: string;
  projectKey: string;
  updated: string; // ISO timestamp
  assigneeName: string | null;
}

interface JiraSearchResponse {
  issues: {
    key: string;
    fields: {
      summary: string;
      updated: string;
      status: { name: string; statusCategory: { key: string } };
      project: { key: string };
      assignee: { displayName: string } | null;
    };
  }[];
}

/**
 * GET tickets currently assigned to the authenticated user. Limit defaults
 * to 30 — enough for a sidebar without flooding the UI.
 */
export async function getAssignedTickets(creds: JiraCreds, limit = 30): Promise<JiraTicket[]> {
  const url = new URL(`https://${creds.host}/rest/api/3/search/jql`);
  url.searchParams.set(
    'jql',
    'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  );
  url.searchParams.set('fields', 'summary,status,project,updated,assignee');
  url.searchParams.set('maxResults', String(limit));

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(creds),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    getLog().warn(
      { status: res.status, body: body.slice(0, 200), url: url.pathname },
      'jira.search_failed'
    );
    throw new Error(
      `Jira search failed: ${String(res.status)}. ${
        res.status === 401
          ? 'Check email/token (or rotate the token at id.atlassian.com).'
          : res.status === 404
            ? 'Wrong host? Try without https://, e.g. rimontech.atlassian.net.'
            : body.slice(0, 200)
      }`
    );
  }
  const data = (await res.json()) as JiraSearchResponse;
  return data.issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    statusCategory: mapStatusCategory(issue.fields.status.statusCategory.key),
    url: `https://${creds.host}/browse/${issue.key}`,
    projectKey: issue.fields.project.key,
    updated: issue.fields.updated,
    assigneeName: issue.fields.assignee?.displayName ?? null,
  }));
}

function mapStatusCategory(key: string): JiraTicket['statusCategory'] {
  if (key === 'new') return 'todo';
  if (key === 'indeterminate') return 'inprogress';
  if (key === 'done') return 'done';
  return 'unknown';
}

export interface JiraProjectSummary {
  id: string;
  key: string;
  name: string;
}

interface JiraProjectSearchResponse {
  values: { id: string; key: string; name: string }[];
}

/**
 * List Jira projects the authenticated user can see. Used to populate the
 * "default project" picker in the Slack settings card.
 */
export async function listJiraProjects(creds: JiraCreds): Promise<JiraProjectSummary[]> {
  const url = new URL(`https://${creds.host}/rest/api/3/project/search`);
  url.searchParams.set('maxResults', '100');
  const res = await fetch(url, {
    headers: { Authorization: authHeader(creds), Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Jira project list failed: ${String(res.status)}`);
  }
  const data = (await res.json()) as JiraProjectSearchResponse;
  return data.values.map(p => ({ id: p.id, key: p.key, name: p.name }));
}

export interface JiraCreatedIssue {
  id: string;
  key: string;
  url: string;
}

/**
 * Create a Jira issue. v1: hardcodes issue type to "Task" — most "make a
 * ticket from this Slack message" use cases want Task. Configurable later.
 *
 * Description is plain text; we wrap it in minimal ADF (Atlassian Document
 * Format) — one paragraph per blank-line-separated chunk.
 */
export async function createJiraIssue(
  creds: JiraCreds,
  input: { projectKey: string; summary: string; description: string }
): Promise<JiraCreatedIssue> {
  const adfDescription = {
    type: 'doc',
    version: 1,
    content: input.description
      .split(/\n{2,}/)
      .filter(p => p.trim().length > 0)
      .map(paragraph => ({
        type: 'paragraph',
        content: [{ type: 'text', text: paragraph }],
      })),
  };
  // Empty description → one empty paragraph (ADF requires non-empty content).
  if (adfDescription.content.length === 0) {
    adfDescription.content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: '(no description)' }],
    });
  }
  const url = `https://${creds.host}/rest/api/3/issue`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: input.projectKey },
        summary: input.summary,
        description: adfDescription,
        issuetype: { name: 'Task' },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    getLog().warn(
      { status: res.status, body: body.slice(0, 200), projectKey: input.projectKey },
      'jira.create_issue_failed'
    );
    throw new Error(`Jira create issue failed: ${String(res.status)}. ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id: string; key: string };
  return {
    id: data.id,
    key: data.key,
    url: `https://${creds.host}/browse/${data.key}`,
  };
}

/**
 * Verify creds work. Used by the "Test connection" button in Settings.
 * Throws on failure with a user-readable message; returns the authed user's
 * displayName on success.
 */
export async function verifyJiraCreds(
  creds: JiraCreds
): Promise<{ accountId: string; displayName: string }> {
  const url = `https://${creds.host}/rest/api/3/myself`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(creds),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Jira auth check failed: ${String(res.status)}. ${
        res.status === 401
          ? 'Wrong email or token. Generate a fresh token at id.atlassian.com/manage-profile/security/api-tokens.'
          : body.slice(0, 200)
      }`
    );
  }
  const data = (await res.json()) as { accountId: string; displayName: string };
  return { accountId: data.accountId, displayName: data.displayName };
}
