import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { startVisibleInterval } from '../../../utils/visibilityInterval';
import { apiClient } from '../../../utils/apiClient';
import type { RunningSession } from '../dashboardTypes';

import { DashCard, DashCardTitle, DashEmpty, DashSkeleton } from './dashShared';

type RunningSessionsCardProps = {
  onOpenSession?: (sessionId: string) => void;
  delay?: number;
};

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  gemini: 'Gemini',
  hermes: 'Hermes',
};

/** Live list of in-flight agent runs, kept fresh via polling + WS nudges. */
export default function RunningSessionsCard({ onOpenSession, delay = 0 }: RunningSessionsCardProps) {
  const { t } = useTranslation();
  const { subscribe } = useWebSocket();
  const [sessions, setSessions] = useState<RunningSession[] | null>(null);
  const now = useNow(1000);

  const load = useCallback(async () => {
    try {
      const payload = await apiClient.get<{ data?: { sessions?: RunningSession[] } }>('/api/providers/sessions/running');
      setSessions(Array.isArray(payload.data?.sessions) ? payload.data.sessions : []);
    } catch {
      // Keep last-known list on a failed poll.
      setSessions((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const stop = startVisibleInterval(() => void load(), 5_000);
    return stop;
  }, [load]);

  // Any chat/run activity nudges an immediate refresh so the card feels live.
  // The subscribe API fans out every frame; we filter to run lifecycle events
  // and throttle to one reload per second at most.
  useEffect(() => {
    if (!subscribe) return undefined;
    let last = 0;
    const unsubscribe = subscribe((event) => {
      const type = typeof event?.type === 'string' ? event.type : '';
      if (!/run|session|chat/i.test(type)) return;
      const nowMs = Date.now();
      if (nowMs - last < 1000) return;
      last = nowMs;
      void load();
    });
    return unsubscribe;
  }, [subscribe, load]);

  return (
    <DashCard delay={delay} className="p-4">
      <DashCardTitle
        title={t('dashboard.runningTitle', { defaultValue: '运行中会话' })}
        action={
          <span className="inline-flex items-center gap-1.5 text-[12px] text-success">
            <span className="dash-live-dot inline-block h-1.5 w-1.5 rounded-full bg-success" />
            Live
          </span>
        }
      />

      {sessions === null ? (
        <DashSkeleton rows={2} />
      ) : sessions.length === 0 ? (
        <DashEmpty
          message={t('dashboard.runningEmpty', { defaultValue: '当前没有运行中的 Agent' })}
          actionLabel={t('dashboard.runningEmptyCta', { defaultValue: '去对话发起一个' })}
          onAction={() => onOpenSession?.('')}
        />
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const elapsed = session.startedAt ? now - session.startedAt : 0;
            return (
              <button
                key={session.sessionId}
                type="button"
                onClick={() => onOpenSession?.(session.sessionId)}
                className="block w-full rounded-lg bg-secondary/60 p-3 text-left transition-colors hover:bg-secondary"
              >
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {PROVIDER_LABEL[session.provider] ?? session.provider}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                    {formatDuration(elapsed)}
                  </span>
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {session.statusText || t('dashboard.runningBusy', { defaultValue: '处理中…' })}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </DashCard>
  );
}
