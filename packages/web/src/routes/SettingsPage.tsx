import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getConfig,
  getHealth,
  listCodebases,
  listProviders,
  addCodebase,
  getCodebaseInput,
  deleteCodebase,
  updateAssistantConfig,
  getCodebaseEnvVars,
  setCodebaseEnvVar,
  deleteCodebaseEnvVar,
  getJiraConfig,
  saveJiraConfig,
  clearJiraConfig,
  testJiraConnection,
  getSlackConfig,
  saveSlackConfig,
  clearSlackConfig,
  testSlackConnection,
  listJiraProjects,
} from '@/lib/api';
import type {
  SafeConfigResponse,
  CodebaseResponse,
  ProviderDefaults,
  ProviderInfo,
} from '@/lib/api';

const selectClass =
  'h-9 rounded-md border border-border bg-surface-elevated text-text-primary px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface-elevated [&>option]:text-text-primary';

function SystemHealthSection({
  health,
  database,
}: {
  health:
    | {
        status: string;
        adapter: string;
        concurrency: { active: number; queuedTotal: number; maxConcurrent: number };
        runningWorkflows: number;
        version?: string;
      }
    | undefined;
  database: string | undefined;
}): React.ReactElement {
  const gitCommit = import.meta.env.VITE_GIT_COMMIT as string;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <CardContent>
        {!health ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <span className="text-muted-foreground">Status: </span>
              <Badge variant={health.status === 'ok' ? 'default' : 'destructive'}>
                {health.status}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Adapter: </span>
              <span className="font-medium">{health.adapter}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Database: </span>
              <span className="font-medium">{database ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Active: </span>
              <span className="font-medium">
                {health.concurrency.active}/{health.concurrency.maxConcurrent}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Queued: </span>
              <span className="font-medium">{health.concurrency.queuedTotal}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Workflows: </span>
              <span className="font-medium">{health.runningWorkflows}</span>
            </div>
            {health.version && (
              <div>
                <span className="text-muted-foreground">Version: </span>
                <span className="font-medium">{health.version}</span>
              </div>
            )}
            {gitCommit && gitCommit !== 'unknown' && (
              <div>
                <span className="text-muted-foreground">Commit: </span>
                <span className="font-medium font-mono">{gitCommit}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EnvVarsPanel({ codebaseId }: { codebaseId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data: envVars } = useQuery({
    queryKey: ['codebaseEnvVars', codebaseId],
    queryFn: () => getCodebaseEnvVars(codebaseId),
  });

  const [mutationError, setMutationError] = useState<string | null>(null);

  const setMutation = useMutation({
    mutationFn: (data: { key: string; value: string }) => setCodebaseEnvVar(codebaseId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebaseEnvVars', codebaseId] });
      if (editingKey) {
        setEditingKey(null);
        setEditValue('');
      } else {
        setNewKey('');
        setNewValue('');
      }
      setMutationError(null);
    },
    onError: (err: Error) => {
      setMutationError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteCodebaseEnvVar(codebaseId, key),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebaseEnvVars', codebaseId] });
      setMutationError(null);
    },
    onError: (err: Error) => {
      setMutationError(err.message);
    },
  });

  function handleAdd(e: React.FormEvent): void {
    e.preventDefault();
    if (newKey.trim() && newValue !== '') {
      setMutation.mutate({ key: newKey.trim(), value: newValue });
    }
  }

  function handleEditSave(key: string): void {
    if (editValue !== '') {
      setMutation.mutate({ key, value: editValue });
    }
  }

  const keys = envVars ?? [];

  return (
    <div className="mt-2 pl-2 border-l border-border space-y-2">
      {mutationError && <div className="text-xs text-destructive">{mutationError}</div>}
      {keys.length === 0 ? (
        <div className="text-xs text-muted-foreground">No env vars set.</div>
      ) : (
        <div className="space-y-1">
          {keys.map(key => (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-text-primary truncate flex-1">{key}</span>
                <span className="text-muted-foreground">= ------</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => {
                    if (editingKey === key) {
                      setEditingKey(null);
                      setEditValue('');
                    } else {
                      setEditingKey(key);
                      setEditValue('');
                    }
                  }}
                >
                  {editingKey === key ? 'Cancel' : 'Edit'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => {
                    deleteMutation.mutate(key);
                  }}
                  disabled={deleteMutation.isPending}
                >
                  Remove
                </Button>
              </div>
              {editingKey === key && (
                <div className="flex gap-1 pl-2">
                  <Input
                    value={editValue}
                    onChange={e => {
                      setEditValue(e.target.value);
                    }}
                    placeholder="new value"
                    className="flex-1 h-7 text-xs"
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleEditSave(key);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      handleEditSave(key);
                    }}
                    disabled={setMutation.isPending}
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleAdd} className="flex gap-1">
        <Input
          value={newKey}
          onChange={e => {
            setNewKey(e.target.value);
          }}
          placeholder="KEY"
          className="flex-1 h-7 text-xs font-mono"
        />
        <Input
          value={newValue}
          onChange={e => {
            setNewValue(e.target.value);
          }}
          placeholder="value"
          className="flex-1 h-7 text-xs"
        />
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={setMutation.isPending}>
          Add
        </Button>
      </form>
    </div>
  );
}

function ProjectsSection(): React.ReactElement {
  const queryClient = useQueryClient();
  const [addValue, setAddValue] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [expandedEnvVars, setExpandedEnvVars] = useState<string | null>(null);

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });

  const addMutation = useMutation({
    mutationFn: (value: string) => addCodebase(getCodebaseInput(value)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
      setAddValue('');
      setShowAdd(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCodebase(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
    },
  });

  function handleAddSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (addValue.trim()) {
      addMutation.mutate(addValue.trim());
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent>
        {!codebases || codebases.length === 0 ? (
          <div className="text-sm text-muted-foreground">No projects registered.</div>
        ) : (
          <div className="space-y-2">
            {codebases.map((cb: CodebaseResponse) => (
              <div key={cb.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{cb.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{cb.default_cwd}</div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        setExpandedEnvVars(expandedEnvVars === cb.id ? null : cb.id);
                      }}
                    >
                      Env Vars {expandedEnvVars === cb.id ? '\u25B2' : '\u25BC'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        deleteMutation.mutate(cb.id);
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {expandedEnvVars === cb.id && <EnvVarsPanel codebaseId={cb.id} />}
              </div>
            ))}
          </div>
        )}

        {showAdd ? (
          <form onSubmit={handleAddSubmit} className="mt-3 flex gap-2">
            <Input
              value={addValue}
              onChange={e => {
                setAddValue(e.target.value);
              }}
              placeholder="GitHub URL or local path"
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={addMutation.isPending}>
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAdd(false);
                setAddValue('');
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setShowAdd(true);
            }}
          >
            + Add Project
          </Button>
        )}

        {addMutation.isError && (
          <div className="mt-2 text-sm text-destructive">
            {addMutation.error instanceof Error
              ? addMutation.error.message
              : 'Failed to add project'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssistantConfigSection({ config }: { config: SafeConfigResponse }): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: listProviders,
    staleTime: 5 * 60 * 1000,
  });
  const [assistant, setAssistant] = useState<string>(config.assistant);
  const [assistantSettings, setAssistantSettings] = useState<Record<string, ProviderDefaults>>(
    config.assistants
  );
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const normalizedConfigSettings = JSON.stringify(config.assistants);
  const normalizedAssistantSettings = JSON.stringify(assistantSettings);
  const hasChanges =
    assistant !== config.assistant || normalizedAssistantSettings !== normalizedConfigSettings;

  useEffect(() => {
    setAssistant(config.assistant);
    setAssistantSettings(config.assistants);
  }, [config]);

  function getProviderSettings(providerId: string): ProviderDefaults {
    return assistantSettings[providerId] ?? {};
  }

  function updateProviderSettings(providerId: string, updates: ProviderDefaults): void {
    setAssistantSettings(current => ({
      ...current,
      [providerId]: {
        ...(current[providerId] ?? {}),
        ...updates,
      },
    }));
  }

  const allProviderEntries: ProviderInfo[] = [
    ...(providers ?? []),
    ...Object.keys(config.assistants)
      .filter(providerId => !(providers ?? []).some(provider => provider.id === providerId))
      .map(
        providerId =>
          ({
            id: providerId,
            displayName: providerId,
            capabilities: {},
            builtIn: false,
          }) satisfies ProviderInfo
      ),
  ];

  const mutation = useMutation({
    mutationFn: updateAssistantConfig,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setSaveMsg({ type: 'success', text: 'Settings saved.' });
      setTimeout(() => {
        setSaveMsg(null);
      }, 3000);
    },
    onError: (err: Error) => {
      setSaveMsg({ type: 'error', text: err.message });
    },
  });

  function handleSave(): void {
    mutation.mutate({
      assistant,
      assistants: assistantSettings,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assistant Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm">
            <label htmlFor="default-assistant">Default Assistant</label>
            <select
              id="default-assistant"
              value={assistant}
              onChange={e => {
                setAssistant(e.target.value);
              }}
              className={selectClass}
            >
              {allProviderEntries.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-4 border-t pt-4">
            {allProviderEntries.map(provider => {
              const providerSettings = getProviderSettings(provider.id);

              if (provider.id === 'claude') {
                return (
                  <div
                    key={provider.id}
                    className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
                  >
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-muted-foreground">Built-in provider settings</div>

                    <label htmlFor="claude-model">Model</label>
                    <select
                      id="claude-model"
                      value={(providerSettings.model as string | undefined) ?? 'sonnet'}
                      onChange={e => {
                        updateProviderSettings('claude', { model: e.target.value });
                      }}
                      className={selectClass}
                    >
                      <option value="sonnet">sonnet</option>
                      <option value="opus">opus</option>
                      <option value="haiku">haiku</option>
                    </select>
                  </div>
                );
              }

              if (provider.id === 'codex') {
                return (
                  <div
                    key={provider.id}
                    className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
                  >
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-muted-foreground">Built-in provider settings</div>

                    <label htmlFor="codex-model">Model</label>
                    <Input
                      id="codex-model"
                      value={(providerSettings.model as string | undefined) ?? ''}
                      onChange={e => {
                        updateProviderSettings('codex', { model: e.target.value });
                      }}
                      placeholder="gpt-5.3-codex"
                    />

                    <label htmlFor="reasoning">Reasoning Effort</label>
                    <select
                      id="reasoning"
                      value={
                        (providerSettings.modelReasoningEffort as string | undefined) ?? 'medium'
                      }
                      onChange={e => {
                        updateProviderSettings('codex', {
                          modelReasoningEffort: e.target.value,
                        });
                      }}
                      className={selectClass}
                    >
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                    </select>

                    <label htmlFor="web-search">Web Search</label>
                    <select
                      id="web-search"
                      value={(providerSettings.webSearchMode as string | undefined) ?? 'disabled'}
                      onChange={e => {
                        updateProviderSettings('codex', { webSearchMode: e.target.value });
                      }}
                      className={selectClass}
                    >
                      <option value="disabled">disabled</option>
                      <option value="cached">cached</option>
                      <option value="live">live</option>
                    </select>
                  </div>
                );
              }

              return (
                <div key={provider.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="font-medium">{provider.displayName}</div>
                  <div className="mt-1 text-muted-foreground">
                    Provider-specific settings are stored generically for Phase 2. This provider
                    does not have a dedicated editor yet.
                  </div>
                  {Object.keys(providerSettings).length > 0 && (
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify(providerSettings, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            {saveMsg && (
              <span
                className={`text-sm ${saveMsg.type === 'success' ? 'text-green-500' : 'text-destructive'}`}
              >
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlatformConnectionsSection({
  activePlatforms,
}: {
  activePlatforms: string[] | undefined;
}): React.ReactElement {
  const active = new Set(activePlatforms ?? []);
  const platforms = [
    { name: 'Web', connected: active.has('Web') },
    { name: 'Slack', connected: active.has('Slack') },
    { name: 'Telegram', connected: active.has('Telegram') },
    { name: 'Discord', connected: active.has('Discord') },
    { name: 'GitHub', connected: active.has('GitHub') },
    { name: 'Gitea', connected: active.has('Gitea') },
    { name: 'GitLab', connected: active.has('GitLab') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform Connections</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {platforms.map(p => (
            <div key={p.name} className="flex items-center justify-between text-sm">
              <span>{p.name}</span>
              <Badge variant={p.connected ? 'default' : 'secondary'}>
                {p.connected ? 'Connected' : 'Not configured'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConcurrencySection({
  health,
}: {
  health: { concurrency: { active: number; maxConcurrent: number } } | undefined;
}): React.ReactElement {
  const active = health?.concurrency.active ?? 0;
  const max = health?.concurrency.maxConcurrent ?? 1;
  const pct = max > 0 ? Math.min((active / max) * 100, 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Concurrency</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${String(pct)}%` }}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {active} / {max} concurrent conversations
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage(): React.ReactElement {
  const {
    data: configData,
    isLoading: configLoading,
    error: configError,
  } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  const {
    data: health,
    isLoading: healthLoading,
    error: healthError,
  } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
  });

  const isLoading = configLoading || healthLoading;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title="Settings" />
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {(configError || healthError) && (
            <div className="text-sm text-destructive">
              Failed to load settings:{' '}
              {((): string => {
                const err = configError ?? healthError;
                return err instanceof Error ? err.message : 'Unknown error';
              })()}
              . Check that the server is running.
            </div>
          )}

          {isLoading && <div className="text-sm text-muted-foreground">Loading settings...</div>}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SystemHealthSection health={health} database={configData?.database} />
            <ConcurrencySection health={health} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {configData && <AssistantConfigSection config={configData.config} />}
            <PlatformConnectionsSection activePlatforms={health?.activePlatforms} />
          </div>

          <ProjectsSection />

          <JiraSection />

          <SlackSection />
        </div>
      </div>
    </div>
  );
}

/**
 * Slack inbox configuration. Reuses the bot's existing token (from
 * SLACK_BOT_TOKEN env var) by default; lets the user paste a custom token
 * to override. Channel IDs persist as a JSON array. The default Jira
 * project picker is populated by hitting /api/jira/projects (only works
 * once Jira creds are saved above).
 */
function SlackSection(): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({
    queryKey: ['slack-config'],
    queryFn: getSlackConfig,
  });

  const { data: jiraProjects } = useQuery({
    queryKey: ['jira-projects'],
    queryFn: listJiraProjects,
    // Only attempt once Jira's been configured — otherwise we get a 400
    // and the user has to read the network tab to figure out why the
    // dropdown is empty.
    enabled: true,
    retry: false,
  });

  const [token, setToken] = useState('');
  const [channelIdsText, setChannelIdsText] = useState('');
  const [pollSeconds, setPollSeconds] = useState(30);
  const [defaultProjectKey, setDefaultProjectKey] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    setChannelIdsText(status.channelIds.join('\n'));
    setPollSeconds(status.pollIntervalSeconds);
    setDefaultProjectKey(status.defaultJiraProjectKey ?? '');
  }, [status]);

  const save = useMutation({
    mutationFn: () =>
      saveSlackConfig({
        // Empty token field = "don't change" (so users can save channels
        // without retyping a token they're keeping or that came from env).
        token: token.trim() || undefined,
        channelIds: channelIdsText
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 0),
        pollIntervalSeconds: pollSeconds,
        defaultJiraProjectKey: defaultProjectKey || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slack-config'] });
      setToken('');
      setTestResult('Saved.');
    },
    onError: (e: Error) => {
      setTestResult(`Save failed: ${e.message}`);
    },
  });

  const clear = useMutation({
    mutationFn: () => clearSlackConfig(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slack-config'] });
      setToken('');
      setChannelIdsText('');
      setDefaultProjectKey('');
      setTestResult('Cleared.');
    },
  });

  const test = useMutation({
    mutationFn: () => testSlackConnection(),
    onSuccess: result => {
      if (result.ok) {
        setTestResult(
          `Connected to ${result.teamName ?? 'workspace'} as @${result.botName ?? 'bot'}.`
        );
      } else {
        setTestResult(`Failed: ${result.error ?? 'unknown error'}`);
      }
    },
    onError: (e: Error) => {
      setTestResult(`Failed: ${e.message}`);
    },
  });

  const sourceLabel =
    status?.tokenSource === 'env'
      ? 'env (SLACK_BOT_TOKEN)'
      : status?.tokenSource === 'db'
        ? 'saved'
        : 'unset';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack inbox</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Token source:</span>
              <Badge variant={status?.hasToken ? 'default' : 'secondary'}>{sourceLabel}</Badge>
              {status?.tokenSource === 'env' && (
                <span className="text-[11px] text-text-tertiary">
                  Reusing the bot adapter's token. Paste below to override.
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">
                Bot User OAuth Token{' '}
                <span className="text-text-tertiary">
                  (xoxb-…; needed scopes: channels:history, groups:history, users:read)
                </span>
              </label>
              <Input
                type="password"
                value={token}
                onChange={(e): void => {
                  setToken(e.target.value);
                }}
                placeholder={status?.hasToken ? '••••••••  (set — paste to replace)' : 'xoxb-...'}
                disabled={save.isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">
                Channel IDs (one per line)
              </label>
              <textarea
                value={channelIdsText}
                onChange={(e): void => {
                  setChannelIdsText(e.target.value);
                }}
                rows={4}
                placeholder={'C0123456789\nC0987654321'}
                disabled={save.isPending}
                className="rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
              />
              <p className="text-[11px] text-text-tertiary">
                Find a channel id by clicking the channel name in Slack → "About" → bottom of the
                modal. The bot must be a member of each channel (
                <code>/invite @&lt;your-bot&gt;</code>).
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-text-secondary">
                  Poll interval (seconds)
                </label>
                <Input
                  type="number"
                  min={10}
                  value={pollSeconds}
                  onChange={(e): void => {
                    setPollSeconds(Math.max(10, Number(e.target.value) || 30));
                  }}
                  disabled={save.isPending}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-text-secondary">
                  Default Jira project (for "Make ticket")
                </label>
                <select
                  value={defaultProjectKey}
                  onChange={(e): void => {
                    setDefaultProjectKey(e.target.value);
                  }}
                  disabled={save.isPending}
                  className={selectClass}
                >
                  <option value="">—</option>
                  {jiraProjects?.projects.map(p => (
                    <option key={p.id} value={p.key}>
                      {p.key} — {p.name}
                    </option>
                  ))}
                </select>
                {!jiraProjects && (
                  <p className="text-[11px] text-text-tertiary">
                    Configure Jira above to load projects.
                  </p>
                )}
              </div>
            </div>

            {testResult && (
              <div className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs">
                {testResult}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                onClick={(): void => {
                  save.mutate();
                }}
                disabled={save.isPending}
              >
                Save
              </Button>
              <Button
                variant="outline"
                onClick={(): void => {
                  test.mutate();
                }}
                disabled={!status?.hasToken || test.isPending}
              >
                Test connection
              </Button>
              <Button
                variant="ghost"
                onClick={(): void => {
                  clear.mutate();
                }}
                disabled={clear.isPending}
              >
                Clear
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Jira credentials panel for Phase D. Persists via the app_settings table
 * so the user can edit creds without touching .env. Env-var fallback still
 * works for power users — Settings just shows the source.
 */
function JiraSection(): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({
    queryKey: ['jira-config'],
    queryFn: getJiraConfig,
  });
  const [host, setHost] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);

  // Prefill host/email when known (token is never returned for security).
  useEffect(() => {
    if (!status) return;
    if (status.host && !host) setHost(status.host);
    if (status.email && !email) setEmail(status.email);
  }, [status, host, email]);

  const save = useMutation({
    mutationFn: () =>
      saveJiraConfig({ host: host.trim(), email: email.trim(), token: token.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jira-config'] });
      setToken(''); // never keep the token in the form after save
      setTestResult('Saved.');
    },
    onError: (e: Error) => {
      setTestResult(`Save failed: ${e.message}`);
    },
  });

  const clear = useMutation({
    mutationFn: () => clearJiraConfig(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jira-config'] });
      setHost('');
      setEmail('');
      setToken('');
      setTestResult('Cleared.');
    },
  });

  const test = useMutation({
    mutationFn: () => testJiraConnection(),
    onSuccess: result => {
      if (result.ok) {
        setTestResult(`Connected as ${result.displayName ?? 'unknown user'}.`);
      } else {
        setTestResult(`Failed: ${result.error ?? 'unknown error'}`);
      }
    },
    onError: (e: Error) => {
      setTestResult(`Failed: ${e.message}`);
    },
  });

  const canSave = host.trim() && email.trim() && token.trim();
  const sourceBadge =
    status?.source === 'env' ? 'env vars' : status?.source === 'db' ? 'saved' : 'unset';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jira</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Source:</span>
              <Badge variant={status?.configured ? 'default' : 'secondary'}>{sourceBadge}</Badge>
              {status?.configured && (
                <Badge variant="outline">
                  {status.email} @ {status.host}
                </Badge>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">
                Atlassian host (no scheme)
              </label>
              <Input
                value={host}
                onChange={(e): void => {
                  setHost(e.target.value);
                }}
                placeholder="rimontech.atlassian.net"
                disabled={save.isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">Email</label>
              <Input
                value={email}
                onChange={(e): void => {
                  setEmail(e.target.value);
                }}
                placeholder="you@example.com"
                disabled={save.isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">
                API token{' '}
                <span className="text-text-tertiary">
                  (id.atlassian.com → Manage profile → Security → API tokens)
                </span>
              </label>
              <Input
                type="password"
                value={token}
                onChange={(e): void => {
                  setToken(e.target.value);
                }}
                placeholder={status?.hasToken ? '••••••••  (saved — paste to replace)' : ''}
                disabled={save.isPending}
              />
            </div>

            {testResult && (
              <div className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs">
                {testResult}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                onClick={(): void => {
                  save.mutate();
                }}
                disabled={!canSave || save.isPending}
              >
                Save
              </Button>
              <Button
                variant="outline"
                onClick={(): void => {
                  test.mutate();
                }}
                disabled={!status?.configured || test.isPending}
              >
                Test connection
              </Button>
              <Button
                variant="ghost"
                onClick={(): void => {
                  clear.mutate();
                }}
                disabled={!status?.configured || clear.isPending}
              >
                Clear
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
