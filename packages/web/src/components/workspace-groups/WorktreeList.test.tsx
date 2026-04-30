/**
 * Component test for WorktreeList. Covers the four useQuery states:
 *   - loading (spinner + "Loading worktrees...")
 *   - error   (server returns 500 → "Failed to load worktrees: ...")
 *   - empty   (server returns []  → onboarding hint with `--group`)
 *   - data    (server returns rows → branch + path render, one row per entry)
 *
 * Like RegisterGroupDialog.test.tsx, we stub `globalThis.fetch` per test
 * instead of mock.module() to avoid bun process-global pollution.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorktreeList } from './WorktreeList';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderList(): void {
  render(
    <QueryClientProvider client={makeClient()}>
      <WorktreeList groupName="platform" />
    </QueryClientProvider>
  );
}

describe('WorktreeList', () => {
  it('shows a loading state while the query is in-flight', () => {
    // Pending fetch: never resolves before assert.
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;
    renderList();
    expect(screen.getByText(/Loading worktrees/)).toBeDefined();
  });

  it('shows an error state when the API returns 5xx', async () => {
    globalThis.fetch = mock(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof fetch;
    renderList();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load worktrees/)).toBeDefined();
    });
  });

  it('shows the empty-state hint when there are no worktrees', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ worktrees: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    renderList();
    await waitFor(() => {
      expect(screen.getByText(/No on-disk worktrees/)).toBeDefined();
    });
    // Hint mentions the `--group` flag so users know how to populate the list.
    expect(screen.getByText('--group')).toBeDefined();
  });

  it('renders one row per worktree with the branch name and path', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            worktrees: [
              {
                groupName: 'platform',
                branch: 'feat-a',
                path: '/home/x/.archon/workspace-groups/platform/worktrees/feat-a',
              },
              {
                groupName: 'platform',
                branch: 'feat-b',
                path: '/home/x/.archon/workspace-groups/platform/worktrees/feat-b',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    ) as unknown as typeof fetch;
    renderList();
    await waitFor(() => {
      expect(screen.getByText('feat-a')).toBeDefined();
    });
    expect(screen.getByText('feat-b')).toBeDefined();
    expect(
      screen.getByText('/home/x/.archon/workspace-groups/platform/worktrees/feat-a')
    ).toBeDefined();
  });
});
