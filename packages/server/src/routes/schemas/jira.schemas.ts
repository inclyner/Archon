/**
 * Schemas for Phase D — Jira ticket panel + Settings UI persistence.
 */
import { z } from '@hono/zod-openapi';

const adfNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z
      .array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() }))
      .optional(),
    content: z.array(adfNodeSchema).optional(),
  })
);

export const jiraIssueDetailResponseSchema = z
  .object({
    issue: z.object({
      key: z.string(),
      summary: z.string(),
      status: z.string(),
      statusCategory: z.enum(['todo', 'inprogress', 'done', 'unknown']),
      url: z.string(),
      projectKey: z.string(),
      issueType: z.string(),
      priority: z.string().nullable(),
      reporter: z.object({ name: z.string(), accountId: z.string() }).nullable(),
      assignee: z.object({ name: z.string(), accountId: z.string() }).nullable(),
      labels: z.array(z.string()),
      created: z.string(),
      updated: z.string(),
      description: adfNodeSchema.nullable(),
    }),
    comments: z.array(
      z.object({
        id: z.string(),
        author: z.object({ name: z.string(), accountId: z.string() }).nullable(),
        body: adfNodeSchema.nullable(),
        created: z.string(),
        updated: z.string(),
      })
    ),
  })
  .openapi('JiraIssueDetailResponse');

export const jiraConfigStatusSchema = z
  .object({
    configured: z.boolean(),
    host: z.string().nullable(),
    email: z.string().nullable(),
    hasToken: z.boolean(),
    source: z.enum(['db', 'env', 'none']),
  })
  .openapi('JiraConfigStatus');

/** PUT /api/settings/jira request body. Token is required when setting. */
export const jiraConfigInputSchema = z
  .object({
    host: z.string().min(1),
    email: z.string().email(),
    token: z.string().min(1),
  })
  .openapi('JiraConfigInput');

export const jiraTestResponseSchema = z
  .object({
    ok: z.boolean(),
    accountId: z.string().optional(),
    displayName: z.string().optional(),
    error: z.string().optional(),
  })
  .openapi('JiraTestResponse');

export const jiraTicketSchema = z
  .object({
    key: z.string(),
    summary: z.string(),
    status: z.string(),
    statusCategory: z.enum(['todo', 'inprogress', 'done', 'unknown']),
    url: z.string(),
    projectKey: z.string(),
    updated: z.string(),
    assigneeName: z.string().nullable(),
  })
  .openapi('JiraTicket');

export const jiraTicketsResponseSchema = z
  .object({
    tickets: z.array(jiraTicketSchema),
  })
  .openapi('JiraTicketsResponse');
