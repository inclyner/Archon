import { useParams, useNavigate, Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronRight,
  FolderGit2,
  FolderTree,
  Loader2,
  Trash2,
  Play,
} from 'lucide-react';
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
import { Separator } from '@/components/ui/separator';
import { WorktreeList } from '@/components/workspace-groups/WorktreeList';
import { deleteWorkspaceGroup, getWorkspaceGroup } from '@/lib/api';

export function GroupDetailPage(): React.ReactElement {
  const params = useParams<{ name: string }>();
  const groupName = params.name ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['workspace-group', groupName],
    queryFn: () => getWorkspaceGroup(groupName),
    enabled: groupName.length > 0,
  });

  const removeMutation = useMutation({
    mutationFn: () => deleteWorkspaceGroup(groupName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
      navigate('/groups');
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <div className="text-sm text-error">Failed to load group: {query.error.message}</div>
        <Link to="/groups">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to groups
          </Button>
        </Link>
      </div>
    );
  }

  const detail = query.data;
  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <div className="text-sm text-text-tertiary">Group not found.</div>
        <Link to="/groups">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to groups
          </Button>
        </Link>
      </div>
    );
  }

  const { group, members } = detail;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Link to="/groups">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Groups
          </Button>
        </Link>
        <ChevronRight className="h-4 w-4 text-text-tertiary" />
        <div className="flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-primary" />
          <h1 className="text-lg font-semibold text-text-primary">{group.name}</h1>
        </div>
      </div>

      <div className="px-4 pb-3">
        <p className="text-xs text-text-tertiary">
          Parent: <span className="text-text-secondary">{group.parent_path}</span>
        </p>
      </div>

      <Separator className="bg-border" />

      <div className="flex flex-col gap-6 p-4">
        {/* Members section */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">
              Member repos{' '}
              <span className="text-text-tertiary">
                ({members.length}; each will get its own PR)
              </span>
            </h2>
          </div>
          {members.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-4 text-sm text-text-tertiary">
              This group has no members. Re-register to refresh.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {members.map(m => (
                <div
                  key={m.codebase_id}
                  className="flex items-center gap-3 rounded-md border border-border bg-surface p-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <FolderGit2 className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {m.relative_path}
                    </div>
                    <div className="truncate text-[11px] text-text-tertiary">
                      codebase {m.codebase_id}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Run workflow section (B3 wires this up to actually fire) */}
        <section>
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-text-primary">Run a workflow</h2>
            <p className="text-xs text-text-tertiary">
              Runs the workflow against all members in one AI session. The button below is wired up
              in B3 (web-triggered group runs); for now, use the CLI:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-surface-elevated p-3 text-[11px] text-text-secondary">
              archon workflow run &lt;workflow&gt; --group {group.name} &quot;your task&quot;
            </pre>
          </div>
          <Button size="sm" disabled title="Coming in B3 — web-triggered group runs">
            <Play className="mr-1 h-4 w-4" />
            Run workflow against this group
          </Button>
        </section>

        {/* Worktrees section */}
        <section>
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-text-primary">Group worktrees</h2>
            <p className="text-xs text-text-tertiary">
              On-disk dirs created by past runs. Each contains one git worktree per member, on the
              same branch name.
            </p>
          </div>
          <WorktreeList groupName={groupName} />
        </section>

        {/* Danger zone */}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-error">Danger zone</h2>
          <div className="rounded-md border border-error/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-text-secondary">
                Unregister this group. Member codebases stay registered; on-disk worktrees are
                untouched (use the worktree list above to clean those up first).
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-error hover:text-error">
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    Unregister
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Unregister group &quot;{group.name}&quot;?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Drops the group + member junction rows from the DB. Member codebases are
                      preserved, and any on-disk worktrees remain in place.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {removeMutation.isError && (
                    <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
                      {removeMutation.error.message}
                    </div>
                  )}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={e => {
                        e.preventDefault();
                        removeMutation.mutate();
                      }}
                      disabled={removeMutation.isPending}
                    >
                      Unregister
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
