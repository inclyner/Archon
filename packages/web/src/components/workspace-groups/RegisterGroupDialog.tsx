import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { registerWorkspaceGroup } from '@/lib/api';
import type { WorkspaceGroupRegisterResponse } from '@/lib/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegistered?: (result: WorkspaceGroupRegisterResponse) => void;
}

export function RegisterGroupDialog(props: Props): React.ReactElement {
  const { open, onOpenChange, onRegistered } = props;
  const queryClient = useQueryClient();
  const [parentPath, setParentPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      return registerWorkspaceGroup({
        parentPath: parentPath.trim(),
        name: name.trim() || undefined,
      });
    },
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-groups'] });
      onRegistered?.(result);
      onOpenChange(false);
      setParentPath('');
      setName('');
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (): void => {
    if (!parentPath.trim() || mutation.isPending) return;
    setError(null);
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a workspace group</DialogTitle>
          <DialogDescription>
            Point Archon at a parent directory containing N sibling git repositories. Each child
            repo will be registered as its own codebase, and the group will track them as a unit for
            cross-repo workflow runs.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Parent path</label>
            <Input
              value={parentPath}
              onChange={e => {
                setParentPath(e.target.value);
              }}
              placeholder="/absolute/path/to/parent/folder"
              disabled={mutation.isPending}
            />
            <p className="text-[11px] text-text-tertiary">
              Must be a non-git folder containing one or more git repos one level deep.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Group name <span className="text-text-tertiary">(optional)</span>
            </label>
            <Input
              value={name}
              onChange={e => {
                setName(e.target.value);
              }}
              placeholder="Defaults to the parent dir basename"
              disabled={mutation.isPending}
            />
          </div>

          {error && (
            <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!parentPath.trim() || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Register
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
