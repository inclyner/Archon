/**
 * Sidebar pane shown when a workspace group is selected. Mirrors
 * ProjectDetail in spirit — header + "New Chat" button + list of group
 * conversations — but scoped to a workspace group instead of a single
 * codebase. Workflow runs and codebase env vars are deliberately omitted;
 * those live elsewhere in the UI (Groups → group detail page).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import {
  listConversations,
  createConversation,
  listWorkspaceGroups,
  getWorkspaceGroup,
} from '@/lib/api';
import { ConversationItem } from '@/components/conversations/ConversationItem';

interface GroupDetailProps {
  groupId: string;
  searchQuery: string;
}

export function GroupDetail({ groupId, searchQuery }: GroupDetailProps): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The sidebar already caches listWorkspaceGroups; reuse that to resolve
  // groupId → name (the existing detail endpoint is keyed by name) without
  // a separate id-lookup endpoint.
  const { data: groupsList } = useQuery({
    queryKey: ['workspace-groups'],
    queryFn: listWorkspaceGroups,
    staleTime: 30_000,
  });
  const groupSummary = groupsList?.find(g => g.id === groupId);

  const { data: group } = useQuery({
    queryKey: ['workspace-group', groupSummary?.name ?? null],
    // groupSummary is guaranteed non-null because `enabled` gates the fetch.
    // The `?? ''` fallback only runs if groupSummary is undefined, in which
    // case `enabled: false` means queryFn is never called.
    queryFn: () => getWorkspaceGroup(groupSummary?.name ?? ''),
    enabled: Boolean(groupSummary),
    staleTime: 30_000,
  });

  const { data: conversations, isError: isErrorConversations } = useQuery({
    queryKey: ['conversations', { workspaceGroupId: groupId }],
    queryFn: () => listConversations(undefined, groupId),
    refetchInterval: 10_000,
  });

  const newChat = useMutation({
    mutationFn: () => createConversation(undefined, undefined, groupId),
    onSuccess: created => {
      void queryClient.invalidateQueries({
        queryKey: ['conversations', { workspaceGroupId: groupId }],
      });
      navigate(`/chat/${encodeURIComponent(created.conversationId)}`);
    },
  });

  const filteredConversations = conversations?.filter(conv => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(q);
  });

  return (
    <div className="min-w-0 flex flex-col gap-3">
      <div className="px-1">
        <h3 className="text-sm font-semibold text-text-primary truncate">
          {group?.group.name ?? 'Group'}
        </h3>
        {group?.group.parent_path && (
          <p className="text-[10px] text-text-tertiary truncate">{group.group.parent_path}</p>
        )}
        {group?.members && (
          <p className="mt-0.5 text-[10px] text-text-tertiary">
            {group.members.length} {group.members.length === 1 ? 'repo' : 'repos'}
          </p>
        )}
      </div>

      <button
        onClick={(): void => {
          newChat.mutate();
        }}
        disabled={newChat.isPending}
        className="mx-1 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
      >
        {newChat.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <MessageSquarePlus className="h-3.5 w-3.5" />
        )}
        New Chat
      </button>

      {newChat.isError && (
        <div className="mx-1 rounded-md border border-error/40 bg-error/5 px-2 py-1 text-[11px] text-error">
          {newChat.error.message}
        </div>
      )}

      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Conversations
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {isErrorConversations ? (
            <span className="px-1 text-xs text-error">Failed to load — retrying</span>
          ) : filteredConversations && filteredConversations.length > 0 ? (
            filteredConversations.map(conv => (
              <ConversationItem key={conv.id} conversation={conv} status="idle" />
            ))
          ) : (
            <span className="px-1 text-xs text-text-tertiary">
              No conversations yet — click "New Chat" to start one.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
