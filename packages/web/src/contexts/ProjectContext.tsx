import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCodebases } from '@/lib/api';
import type { CodebaseResponse } from '@/lib/api';

const PROJECT_STORAGE_KEY = 'archon-selected-project';
const GROUP_STORAGE_KEY = 'archon-selected-group';

interface ProjectContextValue {
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  /**
   * Currently selected workspace group (for group-scoped chat). Mutually
   * exclusive with selectedProjectId — setting one clears the other so the
   * sidebar always renders exactly one detail pane.
   */
  selectedGroupId: string | null;
  setSelectedGroupId: (id: string | null) => void;
  codebases: CodebaseResponse[] | undefined;
  isLoadingCodebases: boolean;
  isErrorCodebases: boolean;
}

const projectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [selectedProjectId, setSelectedProjectIdRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PROJECT_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [selectedGroupId, setSelectedGroupIdRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem(GROUP_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const {
    data: codebases,
    isLoading: isLoadingCodebases,
    isError: isErrorCodebases,
  } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
    refetchInterval: 30_000,
  });

  const setSelectedProjectId = useCallback((id: string | null): void => {
    setSelectedProjectIdRaw(id);
    try {
      if (id) {
        localStorage.setItem(PROJECT_STORAGE_KEY, id);
        // Mutual exclusion: selecting a project clears any selected group so
        // the sidebar's main pane always reflects exactly one scope.
        setSelectedGroupIdRaw(null);
        localStorage.removeItem(GROUP_STORAGE_KEY);
      } else {
        localStorage.removeItem(PROJECT_STORAGE_KEY);
      }
    } catch {
      // localStorage unavailable (e.g. Safari private browsing, quota exceeded)
      // in-memory state already updated above; persistence is best-effort
    }
  }, []); // setSelectedProjectIdRaw is stable (useState setter)

  const setSelectedGroupId = useCallback((id: string | null): void => {
    setSelectedGroupIdRaw(id);
    try {
      if (id) {
        localStorage.setItem(GROUP_STORAGE_KEY, id);
        setSelectedProjectIdRaw(null);
        localStorage.removeItem(PROJECT_STORAGE_KEY);
      } else {
        localStorage.removeItem(GROUP_STORAGE_KEY);
      }
    } catch {
      // best-effort persistence
    }
  }, []);

  // Clear stale selection if the project no longer exists
  useEffect(() => {
    if (!codebases) return;
    if (selectedProjectId && !codebases.some(cb => cb.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [codebases, selectedProjectId, setSelectedProjectId]);

  return (
    <projectContext.Provider
      value={{
        selectedProjectId,
        setSelectedProjectId,
        selectedGroupId,
        setSelectedGroupId,
        codebases,
        isLoadingCodebases,
        isErrorCodebases,
      }}
    >
      {children}
    </projectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(projectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
}
