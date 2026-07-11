import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Filter, Loader2, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../../utils/apiClient';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import { Button } from '../../../shared/view/ui';

import { mapWithConcurrency, matchesCategory, messageText } from './auditUtils';
import type { AuditCategory, ReplayMessage } from './auditUtils';

type AuditSession = ProjectSession & {
  projectId: string;
  projectName: string;
  resolvedProvider: LLMProvider;
  timestamp: string | null;
};
type ReplayPayload = {
  messages: ReplayMessage[];
  total?: number;
  hasMore?: boolean;
  tokenUsage?: unknown;
};

const PROVIDERS: Array<'all' | LLMProvider> = ['all', 'claude', 'cursor', 'codex', 'opencode'];

function resolveTimestamp(session: ProjectSession): string | null {
  const value = session.lastActivity || session.updated_at || session.createdAt || session.created_at;
  return typeof value === 'string' && value ? value : null;
}

function resolveProvider(session: ProjectSession): LLMProvider {
  const provider = session.__provider || session.provider;
  return PROVIDERS.includes(provider as LLMProvider) ? provider as LLMProvider : 'claude';
}

function sessionLabel(session: ProjectSession): string {
  return String(session.title || session.summary || session.name || session.id);
}

async function loadProjectSessions(project: Project, signal?: AbortSignal): Promise<AuditSession[]> {
  const collected: ProjectSession[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await apiClient.get<{ sessions?: ProjectSession[]; sessionMeta?: { total?: number; hasMore?: boolean } }>(
      `/api/projects/${encodeURIComponent(project.projectId)}/sessions`,
      { limit, offset },
      signal,
    );
    const sessions = Array.isArray(page.sessions) ? page.sessions : [];
    collected.push(...sessions);
    offset += sessions.length;
    const total = Number(page.sessionMeta?.total || 0);
    if (sessions.length === 0 || page.sessionMeta?.hasMore === false || (total > 0 && offset >= total) || sessions.length < limit) {
      break;
    }
  }

  return collected.map((session) => ({
    ...session,
    projectId: project.projectId,
    projectName: project.displayName,
    resolvedProvider: resolveProvider(session),
    timestamp: resolveTimestamp(session),
  }));
}

export default function ConversationAuditPanel() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<AuditSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<AuditSession | null>(null);
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [projectFilter, setProjectFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState<'all' | LLMProvider>('all');
  const [category, setCategory] = useState<AuditCategory>('all');
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const replayAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const nextProjects = await apiClient.get<Project[]>('/api/projects');
      const sessionGroups = await mapWithConcurrency(
        nextProjects,
        4,
        (project) => loadProjectSessions(project, controller.signal),
      );
      setProjects(nextProjects);
      setSessions(sessionGroups.flat().sort((left, right) => (
        Date.parse(right.timestamp || '') - Date.parse(left.timestamp || '')
      )));
    } catch (caughtError) {
      if (!(caughtError instanceof Error && caughtError.name === 'AbortError')) {
        setError(caughtError instanceof Error ? caughtError.message : t('audit.loadError'));
      }
    } finally {
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshAbortRef.current?.abort();
      replayAbortRef.current?.abort();
    };
  }, [refresh]);

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
    return sessions.filter((session) => {
      const timestamp = session.timestamp ? Date.parse(session.timestamp) : 0;
      return (projectFilter === 'all' || session.projectId === projectFilter)
        && (providerFilter === 'all' || session.resolvedProvider === providerFilter)
        && timestamp >= fromTime
        && timestamp <= toTime
        && (!normalizedQuery || sessionLabel(session).toLowerCase().includes(normalizedQuery));
    });
  }, [dateFrom, dateTo, projectFilter, providerFilter, query, sessions]);

  const loadReplay = useCallback(async (session: AuditSession) => {
    replayAbortRef.current?.abort();
    const controller = new AbortController();
    replayAbortRef.current = controller;
    setSelectedSession(session);
    setReplayLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<{ data?: ReplayPayload } & ReplayPayload>(
        `/api/providers/sessions/${encodeURIComponent(session.id)}/messages`,
        { limit: 1000, offset: 0 },
        controller.signal,
      );
      setReplay(response.data || response);
    } catch (caughtError) {
      if (!(caughtError instanceof Error && caughtError.name === 'AbortError')) {
        setReplay(null);
        setError(caughtError instanceof Error ? caughtError.message : t('audit.replayError'));
      }
    } finally {
      if (replayAbortRef.current === controller) {
        replayAbortRef.current = null;
        setReplayLoading(false);
      }
    }
  }, [t]);

  const visibleMessages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (replay?.messages || []).filter((message) => (
      matchesCategory(message, category)
      && (!normalizedQuery || messageText(message).toLowerCase().includes(normalizedQuery))
    ));
  }, [category, query, replay?.messages]);

  const exportAudit = useCallback(() => {
    const payload = selectedSession && replay
      ? { exportedAt: new Date().toISOString(), session: selectedSession, replay, filters: { category, query } }
      : { exportedAt: new Date().toISOString(), sessions: filteredSessions, filters: { projectFilter, providerFilter, dateFrom, dateTo, query } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedSession ? `session-audit-${selectedSession.id}.json` : 'session-audit.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [category, dateFrom, dateTo, filteredSessions, projectFilter, providerFilter, query, replay, selectedSession]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="mr-auto">
          <h2 className="text-sm font-semibold text-foreground">{t('audit.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('audit.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('audit.refresh')}
        </Button>
        <Button variant="outline" size="sm" onClick={exportAudit} disabled={filteredSessions.length === 0 && !replay}>
          <Download className="h-4 w-4" />
          {t('audit.export')}
        </Button>
      </header>

      <div className="grid gap-2 border-b border-border p-3 md:grid-cols-6">
        <label className="relative md:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('audit.search')} aria-label={t('audit.search')} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm" />
        </label>
        <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label={t('audit.project')} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          <option value="all">{t('audit.allProjects')}</option>
          {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.displayName}</option>)}
        </select>
        <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value as 'all' | LLMProvider)} aria-label={t('audit.provider')} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider === 'all' ? t('audit.allProviders') : provider}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label={t('audit.dateFrom')} className="h-9 rounded-md border border-border bg-background px-2 text-sm" />
        <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label={t('audit.dateTo')} className="h-9 rounded-md border border-border bg-background px-2 text-sm" />
      </div>

      {error && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      <div className="grid min-h-0 flex-1 md:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-border p-2" aria-label={t('audit.sessions')}>
          {loading && sessions.length === 0 ? <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
          {!loading && filteredSessions.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">{t('audit.noSessions')}</p> : null}
          {filteredSessions.map((session) => (
            <button key={`${session.projectId}:${session.id}`} type="button" onClick={() => void loadReplay(session)} aria-pressed={selectedSession?.id === session.id} className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${selectedSession?.id === session.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted'}`}>
              <div className="truncate text-sm font-medium">{sessionLabel(session)}</div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{session.projectName}</span><span className="uppercase">{session.resolvedProvider}</span></div>
              {session.timestamp && <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={session.timestamp}>{new Date(session.timestamp).toLocaleString()}</time>}
            </button>
          ))}
        </aside>

        <main className="min-h-0 overflow-y-auto p-4">
          {!selectedSession ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Filter className="mr-2 h-4 w-4" />{t('audit.selectSession')}</div> : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="mr-auto text-sm font-semibold">{sessionLabel(selectedSession)}</h3>
                <select value={category} onChange={(event) => setCategory(event.target.value as AuditCategory)} aria-label={t('audit.eventType')} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
                  <option value="all">{t('audit.allEvents')}</option><option value="tool">{t('audit.toolCalls')}</option><option value="error">{t('audit.errors')}</option><option value="permission">{t('audit.permissions')}</option>
                </select>
              </div>
              {replay?.tokenUsage !== undefined && <pre className="mb-3 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs"><strong>{t('audit.tokenUsage')}</strong>{'\n'}{JSON.stringify(replay.tokenUsage, null, 2)}</pre>}
              {replayLoading ? <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin" /></div> : visibleMessages.map((message, index) => (
                <article key={String(message.id || message.uuid || index)} className="mb-2 rounded-md border border-border p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">{String(message.role || message.type || t('audit.event'))}</div>
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">{messageText(message)}</pre>
                </article>
              ))}
              {!replayLoading && replay && visibleMessages.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">{t('audit.noEvents')}</p>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
