import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router';
import {
  Plus,
  Loader2,
  ChevronDown,
  FolderGit2,
  FolderTree,
  MessageSquarePlus,
} from 'lucide-react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { SearchBar } from '@/components/sidebar/SearchBar';
import { ProjectSelector } from '@/components/sidebar/ProjectSelector';
import { ProjectDetail } from '@/components/sidebar/ProjectDetail';
import { AllConversationsView } from '@/components/sidebar/AllConversationsView';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useProject } from '@/contexts/ProjectContext';
import {
  addCodebase,
  getCodebaseInput,
  listWorkspaceGroups,
  createConversation,
  type WorkspaceGroupResponse,
} from '@/lib/api';

const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;
const STORAGE_KEY = 'archon-sidebar-width';

function getInitialWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (parsed >= SIDEBAR_MIN && parsed <= SIDEBAR_MAX) return parsed;
    }
  } catch {
    // localStorage unavailable (Safari private mode, Firefox privacy settings)
  }
  return SIDEBAR_DEFAULT;
}

export function Sidebar(): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(getInitialWidth);
  const isResizing = useRef(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);

  const navigate = useNavigate();
  const {
    selectedProjectId,
    setSelectedProjectId,
    codebases,
    isLoadingCodebases,
    isErrorCodebases,
  } = useProject();

  const selectedProject = codebases?.find(cb => cb.id === selectedProjectId) ?? null;

  // Add-project state
  const [showAddInput, setShowAddInput] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Focus input when shown
  useEffect(() => {
    if (showAddInput) {
      addInputRef.current?.focus();
    }
  }, [showAddInput]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = width;

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      let currentWidth = startWidth; // tracks the final dragged value

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const newWidth = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, startWidth + moveEvent.clientX - startX)
        );
        currentWidth = newWidth; // keep in sync with latest dragged position
        setWidth(newWidth);
      };

      const onMouseUp = (): void => {
        isResizing.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        // Persist only on mouseup to avoid 60-120Hz localStorage writes during drag
        try {
          localStorage.setItem(STORAGE_KEY, String(currentWidth)); // final dragged value
        } catch {
          // localStorage unavailable (Safari private mode, Firefox privacy settings)
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width]
  );

  const handleSelectProject = useCallback(
    (id: string | null): void => {
      setSelectedProjectId(id);
      setProjectsExpanded(false);
    },
    [setSelectedProjectId]
  );

  const handleAddSubmit = useCallback((): void => {
    const trimmed = addValue.trim();
    if (!trimmed || addLoading) return;

    setAddLoading(true);
    setAddError(null);

    void addCodebase(getCodebaseInput(trimmed))
      .then(codebase => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        handleSelectProject(codebase.id);
        setShowAddInput(false);
        setAddValue('');
        setAddError(null);
      })
      .catch((err: Error) => {
        setAddError(err.message);
      })
      .finally(() => {
        setAddLoading(false);
      });
  }, [addValue, addLoading, queryClient, handleSelectProject]);

  const handleAddKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        handleAddSubmit();
      } else if (e.key === 'Escape') {
        setShowAddInput(false);
        setAddValue('');
        setAddError(null);
      }
    },
    [handleAddSubmit]
  );

  const shortcuts = useMemo(
    () => ({
      '/': (): void => searchInputRef.current?.focus(),
      Escape: (): void => {
        setSearchQuery('');
        searchInputRef.current?.blur();
      },
    }),
    []
  );

  const handleNewOrchestratorChat = useCallback((): void => {
    setSelectedProjectId(null);
    navigate('/chat');
  }, [navigate, setSelectedProjectId]);

  useKeyboardShortcuts(shortcuts);

  return (
    <aside
      className="relative flex h-full flex-col border-r border-border bg-surface"
      style={{ width: `${String(width)}px` }}
    >
      {/* Logo */}
      <div className="flex flex-col gap-3 p-4">
        <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-semibold text-primary-foreground">A</span>
          </div>
          <span className="text-base font-semibold text-text-primary">Archon</span>
        </Link>
      </div>

      <Separator className="bg-border" />

      {/* Search - always visible */}
      <div className="px-3 py-2">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search..."
          inputRef={searchInputRef}
        />
      </div>

      {/* Orchestrator (unscoped) new chat */}
      <div className="px-3 pb-2">
        <button
          onClick={handleNewOrchestratorChat}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0" />
          New Chat
        </button>
      </div>

      <Separator className="bg-border" />

      <WorkspaceGroupsSection />

      <Separator className="bg-border" />

      {/* Collapsible Project Selector */}
      <div className="px-2 py-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Projects
          </span>
          <button
            onClick={(): void => {
              setShowAddInput(prev => !prev);
              setAddError(null);
              setAddValue('');
            }}
            className="p-1 rounded hover:bg-surface-elevated transition-colors"
            title="Add project"
          >
            <Plus className="h-4 w-4 text-text-tertiary hover:text-primary" />
          </button>
        </div>

        {showAddInput && (
          <div className="mt-1.5 px-1">
            <div className="flex items-center gap-1">
              <input
                ref={addInputRef}
                value={addValue}
                onChange={(e): void => {
                  setAddValue(e.target.value);
                }}
                onKeyDown={handleAddKeyDown}
                onBlur={(): void => {
                  // Close on blur only if empty and no error
                  if (!addValue.trim() && !addError) {
                    setShowAddInput(false);
                  }
                }}
                placeholder="GitHub URL or local path"
                disabled={addLoading}
                className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
              />
              {addLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
            </div>
            {addError && <p className="mt-1 text-[10px] text-error line-clamp-2">{addError}</p>}
          </div>
        )}

        <Collapsible open={projectsExpanded} onOpenChange={setProjectsExpanded}>
          {selectedProjectId && !projectsExpanded ? (
            <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 mt-1 text-left text-sm text-primary hover:bg-surface-elevated transition-colors">
              <FolderGit2 className="h-4 w-4 shrink-0" />
              <span className="truncate flex-1">{selectedProject?.name ?? 'Project'}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            </CollapsibleTrigger>
          ) : (
            <CollapsibleTrigger className="hidden" />
          )}
          <CollapsibleContent>
            <div className="max-h-[35vh] overflow-y-auto">
              <ProjectSelector
                projects={codebases ?? []}
                selectedProjectId={selectedProjectId}
                onSelectProject={handleSelectProject}
                isLoading={isLoadingCodebases}
                searchQuery={searchQuery}
              />
            </div>
          </CollapsibleContent>
          {/* Show full list when no project selected (not inside collapsible content) */}
        </Collapsible>
        {!selectedProjectId && (
          <div className="max-h-[35vh] overflow-y-auto">
            <ProjectSelector
              projects={codebases ?? []}
              selectedProjectId={selectedProjectId}
              onSelectProject={handleSelectProject}
              isLoading={isLoadingCodebases}
              searchQuery={searchQuery}
            />
          </div>
        )}
        {isErrorCodebases && (
          <p className="px-2 text-[10px] text-error mt-1">Failed to load projects — retrying</p>
        )}
      </div>

      <Separator className="bg-border" />

      {/* Project-scoped or all-conversations content */}
      {selectedProjectId ? (
        <div className="min-w-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full px-2 py-2">
            <ProjectDetail
              codebaseId={selectedProjectId}
              projectName={selectedProject?.name ?? ''}
              repositoryUrl={selectedProject?.repository_url}
              searchQuery={searchQuery}
            />
          </ScrollArea>
        </div>
      ) : (
        <div className="min-w-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full px-2 py-2">
            <AllConversationsView searchQuery={searchQuery} />
          </ScrollArea>
        </div>
      )}

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-border/50 hover:bg-primary/40 transition-colors"
      />
    </aside>
  );
}

/**
 * Lists registered workspace groups in the sidebar. Click → spawns a fresh
 * conversation tagged with that group's id, then navigates to the chat. The
 * orchestrator + group-chat helper materializes the per-conversation
 * worktree lazily on the first message.
 *
 * Standalone component (not inlined into Sidebar) so the useQuery + useMutation
 * hooks live alongside the JSX they drive.
 */
function WorkspaceGroupsSection(): React.ReactElement {
  const navigate = useNavigate();
  const { data: groups, isLoading } = useQuery({
    queryKey: ['workspace-groups'],
    queryFn: listWorkspaceGroups,
    staleTime: 30_000,
  });
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);

  async function startGroupChat(group: WorkspaceGroupResponse): Promise<void> {
    if (busyGroupId) return;
    setBusyGroupId(group.id);
    try {
      const created = await createConversation(undefined, undefined, group.id);
      navigate(`/chat/${encodeURIComponent(created.conversationId)}`);
    } catch (e) {
      // Surface to console; toast plumbing for the sidebar is a follow-up.
      // The Groups page has full error UI, so this is a nudge to head there.

      console.error('Failed to start group chat', e);
    } finally {
      setBusyGroupId(null);
    }
  }

  return (
    <div className="px-2 py-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Workspace Groups
        </span>
        <Link
          to="/groups"
          className="p-1 rounded hover:bg-surface-elevated transition-colors text-text-tertiary hover:text-primary"
          title="Manage groups"
        >
          <FolderTree className="h-3.5 w-3.5" />
        </Link>
      </div>
      {isLoading && (
        <div className="mt-1 flex items-center gap-2 px-3 py-1.5 text-xs text-text-tertiary">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading groups...
        </div>
      )}
      {!isLoading && groups?.length === 0 && (
        <Link
          to="/groups"
          className="mt-1 block px-3 py-1.5 text-[11px] text-text-tertiary hover:text-primary"
        >
          No groups yet — register one →
        </Link>
      )}
      {groups?.map(group => (
        <button
          key={group.id}
          onClick={(): void => {
            void startGroupChat(group);
          }}
          disabled={busyGroupId !== null}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors disabled:opacity-50"
          title={`New chat across all members of ${group.name}`}
        >
          {busyGroupId === group.id ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          <span className="truncate flex-1">{group.name}</span>
          <MessageSquarePlus className="h-3 w-3 shrink-0 text-text-tertiary" />
        </button>
      ))}
    </div>
  );
}
