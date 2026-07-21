import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { apiClient } from '../../../utils/apiClient';

import { DashCard } from './dashShared';

type QuickActionsBarProps = {
  onRunDoctor: () => void;
  delay?: number;
};

/** Flat action strip along the bottom of the dashboard. */
export default function QuickActionsBar({ onRunDoctor, delay = 0 }: QuickActionsBarProps) {
  const { t } = useTranslation();
  const { checkForUpdates } = useVersionCheck();
  const [recycleCount, setRecycleCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await apiClient.get<{ success?: boolean; items?: unknown[]; sessions?: unknown[] }>('/api/leocodebox/recycle');
        if (cancelled) return;
        const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.sessions) ? payload.sessions : [];
        setRecycleCount(items.length);
      } catch {
        if (!cancelled) setRecycleCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const buttonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent/60';

  return (
    <DashCard delay={delay} className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onRunDoctor} className={buttonClass}>
          {t('dashboard.actionDoctor', { defaultValue: '运行 Doctor' })}
        </button>
        <button type="button" onClick={() => void checkForUpdates()} className={buttonClass}>
          {t('dashboard.actionCheckUpdate', { defaultValue: '检查更新' })}
        </button>
        <a href="/api/leocodebox/config-backups" target="_blank" rel="noreferrer" className={buttonClass}>
          {t('dashboard.actionBackup', { defaultValue: '配置备份' })}
        </a>
        <button type="button" className={buttonClass} title={t('dashboard.actionRecycle', { defaultValue: '回收站' })}>
          {t('dashboard.actionRecycle', { defaultValue: '回收站' })}
          {recycleCount !== null && recycleCount > 0 && (
            <span className="rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">{recycleCount}</span>
          )}
        </button>
      </div>
    </DashCard>
  );
}
