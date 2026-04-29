import { Link } from 'react-router';
import { FolderTree, ChevronRight } from 'lucide-react';
import type { WorkspaceGroupResponse } from '@/lib/api';

export function GroupCard(props: {
  group: WorkspaceGroupResponse;
  memberCount?: number;
}): React.ReactElement {
  const { group, memberCount } = props;
  return (
    <Link
      to={`/groups/${encodeURIComponent(group.name)}`}
      className="group flex items-center gap-3 rounded-md border border-border bg-surface p-3 hover:bg-surface-elevated transition-colors"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <FolderTree className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary">{group.name}</div>
        <div className="truncate text-xs text-text-tertiary">{group.parent_path}</div>
      </div>
      {typeof memberCount === 'number' && (
        <div className="text-xs text-text-tertiary">
          {memberCount} {memberCount === 1 ? 'repo' : 'repos'}
        </div>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary group-hover:text-text-primary transition-colors" />
    </Link>
  );
}
