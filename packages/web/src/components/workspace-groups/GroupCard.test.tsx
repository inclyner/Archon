/**
 * Smoke test for GroupCard. Verifies render output, pluralization of the
 * member-count badge, and the link href (which depends on encodeURIComponent
 * for names with weird chars).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { GroupCard } from './GroupCard';
import type { WorkspaceGroupResponse } from '@/lib/api';

afterEach(() => {
  cleanup();
});

const baseGroup: WorkspaceGroupResponse = {
  id: 'group-1',
  name: 'my-platform',
  parent_path: '/Users/x/Documents/platform',
  created_at: '2026-04-30T12:00:00Z',
};

function renderCard(props: Parameters<typeof GroupCard>[0]): void {
  render(
    <MemoryRouter>
      <GroupCard {...props} />
    </MemoryRouter>
  );
}

describe('GroupCard', () => {
  it('renders the group name and parent path', () => {
    renderCard({ group: baseGroup });
    expect(screen.getByText('my-platform')).toBeDefined();
    expect(screen.getByText('/Users/x/Documents/platform')).toBeDefined();
  });

  it('renders "1 repo" (singular) when memberCount is 1', () => {
    renderCard({ group: baseGroup, memberCount: 1 });
    expect(screen.getByText('1 repo')).toBeDefined();
  });

  it('renders "N repos" (plural) when memberCount is >1', () => {
    renderCard({ group: baseGroup, memberCount: 4 });
    expect(screen.getByText('4 repos')).toBeDefined();
  });

  it('renders no member-count badge when memberCount is undefined', () => {
    renderCard({ group: baseGroup });
    expect(screen.queryByText(/repos?$/)).toBeNull();
  });

  it('encodes the group name in the link href (handles slashes/special chars)', () => {
    renderCard({
      group: { ...baseGroup, name: 'my group/weird' },
    });
    const link = screen.getByRole('link');
    // encodeURIComponent('my group/weird') → 'my%20group%2Fweird'
    expect(link.getAttribute('href')).toBe('/groups/my%20group%2Fweird');
  });
});
