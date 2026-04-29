import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Loader2, FolderTree } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GroupCard } from '@/components/workspace-groups/GroupCard';
import { RegisterGroupDialog } from '@/components/workspace-groups/RegisterGroupDialog';
import { listWorkspaceGroups } from '@/lib/api';

export function GroupsPage(): React.ReactElement {
  const [registerOpen, setRegisterOpen] = useState(false);
  const query = useQuery({
    queryKey: ['workspace-groups'],
    queryFn: listWorkspaceGroups,
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-text-primary">Workspace Groups</h1>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setRegisterOpen(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          Register group
        </Button>
      </div>

      <div className="px-4 pb-2">
        <p className="text-xs text-text-tertiary">
          A workspace group is a non-git parent directory containing N sibling git repos. One AI
          session edits across all members; each commit lands in its own repo's git history.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {query.isLoading && (
          <div className="flex items-center gap-2 text-sm text-text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading groups...
          </div>
        )}

        {query.isError && (
          <div className="rounded-md border border-error/40 bg-error/5 p-3 text-sm text-error">
            Failed to load groups: {query.error.message}
          </div>
        )}

        {!query.isLoading && !query.isError && (query.data?.length ?? 0) === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <FolderTree className="h-6 w-6 text-primary" />
            </div>
            <div className="text-sm font-medium text-text-primary">No workspace groups yet</div>
            <p className="max-w-sm text-xs text-text-tertiary">
              Register a parent directory to bundle its child git repos into a group. Workflow runs
              against the group operate across all members in one AI session.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setRegisterOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              Register your first group
            </Button>
          </div>
        )}

        {!query.isLoading && !query.isError && (query.data?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-2">
            {query.data?.map(group => (
              <GroupCard key={group.id} group={group} />
            ))}
          </div>
        )}
      </div>

      <RegisterGroupDialog open={registerOpen} onOpenChange={setRegisterOpen} />
    </div>
  );
}
