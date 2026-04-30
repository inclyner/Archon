/**
 * Component test for RegisterGroupDialog. Covers:
 *   - submit button is disabled until parentPath is non-empty (UX guardrail —
 *     prevents the empty-path POST that the server would reject anyway).
 *   - submit triggers POST /api/groups with the typed values, fires
 *     onRegistered, and closes the dialog.
 *   - 4xx error from the API renders the error block inline (the user sees
 *     `Error: ...` from fetchJSON's error path, not just a console log).
 *
 * Uses fetch-stubbing rather than mock.module() to avoid bun's process-global
 * mock pollution (this test invocation runs alongside other component tests
 * that may stub the same modules).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RegisterGroupDialog } from './RegisterGroupDialog';

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
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDialog(overrides: Partial<Parameters<typeof RegisterGroupDialog>[0]> = {}): {
  onOpenChange: ReturnType<typeof mock>;
  onRegistered: ReturnType<typeof mock>;
} {
  const onOpenChange = mock(() => {});
  const onRegistered = mock(() => {});
  render(
    <QueryClientProvider client={makeClient()}>
      <RegisterGroupDialog
        open={true}
        onOpenChange={onOpenChange}
        onRegistered={onRegistered}
        {...overrides}
      />
    </QueryClientProvider>
  );
  return { onOpenChange, onRegistered };
}

describe('RegisterGroupDialog', () => {
  it('disables the Register button until parentPath is non-empty', async () => {
    renderDialog();
    const registerBtn = screen.getByRole('button', { name: /register/i });
    expect((registerBtn as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByPlaceholderText(/absolute\/path/i);
    await userEvent.type(input, '/some/path');
    expect((registerBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits to POST /api/groups, fires onRegistered, and closes the dialog', async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            group: { id: 'g1', name: 'platform', parent_path: '/p' },
            members: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { onOpenChange, onRegistered } = renderDialog();
    await userEvent.type(screen.getByPlaceholderText(/absolute\/path/i), '/Users/x/platform');
    await userEvent.click(screen.getByRole('button', { name: /register/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/groups');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ parentPath: '/Users/x/platform' });

    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('renders an inline error when the API returns a 4xx', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('Parent path is not a directory', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        })
    ) as unknown as typeof fetch;

    const { onRegistered } = renderDialog();
    await userEvent.type(screen.getByPlaceholderText(/absolute\/path/i), '/bad/path');
    await userEvent.click(screen.getByRole('button', { name: /register/i }));

    // fetchJSON wraps the body into the message; our test just asserts the
    // body text shows up inline. We don't assert on the full error string —
    // that's an implementation detail of fetchJSON.
    await waitFor(() => {
      expect(screen.getByText(/Parent path is not a directory/)).toBeDefined();
    });
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
