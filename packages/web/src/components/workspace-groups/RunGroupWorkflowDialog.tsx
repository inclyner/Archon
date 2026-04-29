import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
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
import { Textarea } from '@/components/ui/textarea';
import {
  createConversation,
  listWorkflows,
  runWorkspaceGroupWorkflow,
  type RunGroupWorkflowResponse,
} from '@/lib/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
}

export function RunGroupWorkflowDialog(props: Props): React.ReactElement {
  const { open, onOpenChange, groupName } = props;
  const navigate = useNavigate();
  const [workflowName, setWorkflowName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const workflowsQuery = useQuery({
    queryKey: ['workflows-for-groups'],
    queryFn: () => listWorkflows(),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: async (): Promise<RunGroupWorkflowResponse> => {
      // Conversation first, so the run has somewhere to stream events to.
      const conv = await createConversation();
      return runWorkspaceGroupWorkflow(groupName, {
        workflowName: workflowName.trim(),
        message: message.trim(),
        conversationId: conv.conversationId,
      });
    },
    onSuccess: result => {
      onOpenChange(false);
      setMessage('');
      setError(null);
      // Navigate to the chat view for this conversation so the user sees the
      // SSE stream of workflow events.
      navigate(`/chat/${encodeURIComponent(result.conversationId)}`);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (): void => {
    if (!workflowName.trim() || mutation.isPending) return;
    setError(null);
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run a workflow against {groupName}</DialogTitle>
          <DialogDescription>
            One AI session edits across all members of <strong>{groupName}</strong>. Each member's
            edits land in its own worktree → its own commits → its own PR.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Workflow</label>
            {workflowsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-text-tertiary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading workflows...
              </div>
            ) : (
              <Input
                value={workflowName}
                onChange={e => {
                  setWorkflowName(e.target.value);
                }}
                placeholder="e.g. archon-cross-repo-orient"
                disabled={mutation.isPending}
                list="group-workflow-options"
              />
            )}
            <datalist id="group-workflow-options">
              {workflowsQuery.data?.map(w => (
                <option key={w.workflow.name} value={w.workflow.name} />
              ))}
            </datalist>
            <p className="text-[11px] text-text-tertiary">
              Type or pick a workflow. Bundled defaults and per-repo workflows both show up.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Task</label>
            <Textarea
              value={message}
              onChange={e => {
                setMessage(e.target.value);
              }}
              rows={4}
              placeholder="Describe what you want the AI to do across these repos..."
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
          <Button onClick={handleSubmit} disabled={!workflowName.trim() || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Run
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
