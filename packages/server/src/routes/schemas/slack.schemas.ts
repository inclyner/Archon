/**
 * Schemas for the Slack inbox + Jira-issue creation endpoints.
 */
import { z } from '@hono/zod-openapi';

export const slackConfigStatusSchema = z
  .object({
    configured: z.boolean(),
    hasToken: z.boolean(),
    tokenSource: z.enum(['db', 'env', 'none']),
    channelIds: z.array(z.string()),
    pollIntervalSeconds: z.number(),
    defaultJiraProjectKey: z.string().nullable(),
  })
  .openapi('SlackConfigStatus');

/**
 * PUT /api/settings/slack body. All fields optional so the UI can save
 * incrementally; an empty/whitespace token means "don't change".
 */
export const slackConfigInputSchema = z
  .object({
    token: z.string().optional(),
    channelIds: z.array(z.string()).optional(),
    pollIntervalSeconds: z.number().int().min(10).optional(),
    defaultJiraProjectKey: z.string().optional(),
  })
  .openapi('SlackConfigInput');

export const slackTestResponseSchema = z
  .object({
    ok: z.boolean(),
    teamName: z.string().optional(),
    botName: z.string().optional(),
    error: z.string().optional(),
  })
  .openapi('SlackTestResponse');

export const slackMessageSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    channelName: z.string(),
    ts: z.string(),
    timestamp: z.string(),
    userId: z.string().nullable(),
    userDisplay: z.string(),
    text: z.string(),
    permalink: z.string(),
  })
  .openapi('SlackMessage');

export const slackMessagesResponseSchema = z
  .object({
    messages: z.array(slackMessageSchema),
  })
  .openapi('SlackMessagesResponse');

export const jiraProjectSchema = z
  .object({ id: z.string(), key: z.string(), name: z.string() })
  .openapi('JiraProject');

export const jiraProjectsResponseSchema = z
  .object({ projects: z.array(jiraProjectSchema) })
  .openapi('JiraProjectsResponse');

/** POST /api/jira/issues body. */
export const jiraCreateIssueInputSchema = z
  .object({
    summary: z.string().min(1).max(255),
    description: z.string(),
    /** Optional override; falls back to slack.default_jira_project_key. */
    projectKey: z.string().optional(),
  })
  .openapi('JiraCreateIssueInput');

export const jiraCreatedIssueSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    url: z.string(),
  })
  .openapi('JiraCreatedIssue');
