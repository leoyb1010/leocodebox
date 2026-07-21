import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ClaudeWindowUsage, ClaudeQuotaEstimate } from '../dashboardTypes';

type ClaudeQuotaRingsProps = {
  quota: ClaudeQuotaEstimate | null;
  loading: boolean;
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

function formatReset(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}

/** Composition bar: input / output / cache-creation as proportions of total. */
function CompositionBar({ win }: { win: ClaudeWindowUsage }) {
  const counted = Math.max(1, win.inputTokens + win.outputTokens + win.cacheCreationTokens);
  const inputPct = (win.inputTokens / counted) * 100;
  const outputPct = (win.outputTokens / counted) * 100;
  const cachePct = (win.cacheCreationTokens / counted) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="img"
      aria-label={`input ${Math.round(inputPct)}%, output ${Math.round(outputPct)}%, cache ${Math.round(cachePct)}%`}>
      <div className="flex h-full">
        <div className="dash-bar-fill h-full bg-info" style={{ width: `${inputPct}%` }} />
        <div className="dash-bar-fill h-full bg-success" style={{ width: `${outputPct}%` }} />
        <div className="dash-bar-fill h-full bg-primary/50" style={{ width: `${cachePct}%` }} />
      </div>
    </div>
  );
}

function WindowRow({ label, win, locale, t }: { label: string; win: ClaudeWindowUsage; locale: string; t: (k: string, o?: Record<string, unknown>) => string }) {
  return (
    <div className="rounded-lg bg-secondary/60 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('dashboard.windowReset', { time: formatReset(win.resetsAt, locale), defaultValue: `${formatReset(win.resetsAt, locale)} 重置` })}
        </span>
      </div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[16px] font-medium tabular-nums text-foreground">{formatTokens(win.countedTokens)}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('dashboard.windowMeta', { turns: win.turns, cost: win.costUsd.toFixed(2), defaultValue: `${win.turns} 轮 · ≈$${win.costUsd.toFixed(2)}` })}
        </span>
      </div>
      <CompositionBar win={win} />
    </div>
  );
}

/**
 * Real local Claude consumption per rolling window (5h + 7d), measured from
 * session logs. Shows tokens that count toward the rate limit, an
 * API-equivalent cost, turn count, and a token-composition bar — never an
 * invented quota percentage. Clearly labelled "本地实测".
 */
export default function ClaudeQuotaRings({ quota, loading }: ClaudeQuotaRingsProps) {
  const { t, i18n } = useTranslation();
  const [, forceTick] = useState(0);

  // Re-render once a minute so reset times stay honest.
  useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (loading) {
    return (
      <div className="space-y-2 border-y border-border py-3">
        <div className="h-14 animate-pulse rounded-lg bg-secondary/70" />
        <div className="h-14 animate-pulse rounded-lg bg-secondary/70" />
      </div>
    );
  }

  if (!quota) return null;

  return (
    <div className="border-y border-border py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium text-foreground">
          {t('dashboard.claudeWindowTitle', { defaultValue: 'Claude 窗口消耗' })}
        </span>
        <span className="text-[11px] text-muted-foreground/80">
          {t('dashboard.localMeasured', { defaultValue: '本地实测' })}
        </span>
      </div>
      <div className="space-y-2">
        <WindowRow
          label={t('dashboard.window5h', { defaultValue: '5 小时窗口' })}
          win={quota.fiveHour}
          locale={i18n.language}
          t={t}
        />
        <WindowRow
          label={t('dashboard.windowWeekly', { defaultValue: '近 7 日窗口' })}
          win={quota.weekly}
          locale={i18n.language}
          t={t}
        />
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
        {t('dashboard.windowNote', { defaultValue: '计入限额的 input+output tokens；不含缓存读取与其他设备。' })}
      </div>
    </div>
  );
}
