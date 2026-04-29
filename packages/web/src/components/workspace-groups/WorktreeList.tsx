import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  deleteWorkspaceGroupWorktree,
  listWorkspaceGroupWorktrees,
  type ListedGroupWorktreeResponse,
} from '@/lib/api';

interface Props {
  groupName: string;
}

export function WorktreeList({ groupName }: Props): React.ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['workspace-group-worktrees', groupName],
    queryFn: () => listWorkspaceGroupWorktrees(groupName),
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-tertiary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading worktrees...
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="text-sm text-error">Failed to load worktrees: {query.error.message}</div>
    );
  }

  const worktrees = query.data ?? [];

  if (worktrees.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-sm text-text-tertiary">
        No on-disk worktrees for this group. They appear after a workflow run with{' '}
        <code className="rounded bg-surface-elevated px-1 py-0.5 text-[11px]">--group</code>.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {worktrees.map(wt => (
        <WorktreeRow
          key={`${wt.groupName}/${wt.branch}`}
          worktree={wt}
          onRemoved={() => {
            void queryClient.invalidateQueries({
              queryKey: ['workspace-group-worktrees', groupName],
            });
          }}
        />
      ))}
    </div>
  );
}

function WorktreeRow(props: {
  worktree: ListedGroupWorktreeResponse;
  onRemoved: () => void;
}): React.ReactElement {
  const { worktree, onRemoved } = props;
  const mutation = useMutation({
    mutationFn: () => deleteWorkspaceGroupWorktree(worktree.groupName, worktree.branch),
    onSuccess: () => {
      onRemoved();
    },
  });

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary">{worktree.branch}</div>
        <div className="truncate text-xs text-text-tertiary">{worktree.path}</div>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-text-tertiary hover:text-error">
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this group worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              This will run <code>git worktree remove</code> against each member's source repo and
              delete the group dir at <code>{worktree.path}</code>. The source repos and any commits
              already pushed are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError && (
            <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
              {mutation.error.message}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault();
                mutation.mutate();
              }}
              disabled={mutation.isPending}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
