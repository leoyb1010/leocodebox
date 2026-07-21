import { ArrowUpCircle, CheckCircle2, Flame, RefreshCw, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAnimatedNumber } from '../../../hooks/useAnimatedNumber';
import { useDoctorReport } from '../../../hooks/useDoctorReport';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { resolveDoctorTone, type DoctorTone } from '../../app/doctorLight';
import { formatCny, formatTokensCn } from '../format';

const TONE_DOT: Record<DoctorTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-destructive',
};

function greetingKey(hour: number): string {
  if (hour < 6) return 'dashboard.greetingNight';
  if (hour < 12) return 'dashboard.greetingMorning';
  if (hour < 18) return 'dashboard.greetingAfternoon';
  return 'dashboard.greetingEvening';
}

type HeroMetrics = {
  sessionsToday: number;
  tokensToday: number;
  costTodayUsd: number;
  runningNow: number;
};

type DashboardHeroProps = {
  username: string;
  metrics: HeroMetrics;
  onRefresh: () => void;
};

function Metric({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${accent ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium tabular-nums leading-tight text-foreground">{value}</span>
        <span className="block text-[11px] leading-tight text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

/**
 * Rich top strip: greeting + account on the left, today's key metrics in the
 * middle, health/version/refresh on the right — over a soft gradient wash.
 */
export default function DashboardHero({ username, metrics, onRefresh }: DashboardHeroProps) {
  const { t } = useTranslation();
  const report = useDoctorReport();
  const { currentVersion, updateAvailable, latestVersion, checkForUpdates } = useVersionCheck();

  const summary = report?.summary;
  const tone = resolveDoctorTone(summary);
  const greeting = t(greetingKey(new Date().getHours()), { defaultValue: '你好' });

  const animatedSessions = useAnimatedNumber(metrics.sessionsToday);
  const animatedRunning = useAnimatedNumber(metrics.runningNow);

  const healthLabel = !summary
    ? t('workspaceShell.healthChecking', { defaultValue: '体检中' })
    : summary.fail > 0
      ? t('dashboard.healthSummary', { ok: summary.ok, warn: summary.warn, fail: summary.fail, defaultValue: `异常 ${summary.fail}` })
      : summary.warn > 0
        ? t('dashboard.healthSummary', { ok: summary.ok, warn: summary.warn, fail: 0, defaultValue: `注意 ${summary.warn}` })
        : t('dashboard.healthOkCount', { count: summary.ok, defaultValue: `就绪 ${summary.ok}` });

  return (
    <div className="dash-enter dash-hero rounded-xl border border-border bg-card text-card-foreground shadow-elevation-1" style={{ ['--dash-delay' as string]: '0ms' }}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
        {/* Greeting + account */}
        <div className="min-w-0 flex-shrink-0">
          <h1 className="truncate text-[17px] font-medium tracking-tight text-foreground">
            {greeting}，{username}
          </h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <CheckCircle2 className="h-3 w-3 text-success" />
            {t('dashboard.localAccount', { defaultValue: '本地账号已就绪' })}
          </p>
        </div>

        {/* Today's key metrics */}
        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2 border-border sm:border-l sm:pl-6">
          <Metric
            icon={<Zap className="h-4 w-4" />}
            label={t('dashboard.metricSessions', { defaultValue: '今日会话' })}
            value={String(Math.round(animatedSessions))}
          />
          <Metric
            icon={<Flame className="h-4 w-4" />}
            label={t('dashboard.metricTokens', { defaultValue: '今日 Tokens' })}
            value={formatTokensCn(metrics.tokensToday)}
          />
          <Metric
            icon={<span className="text-[13px] font-medium">¥</span>}
            label={t('dashboard.metricCost', { defaultValue: '今日成本' })}
            value={formatCny(metrics.costTodayUsd)}
          />
          {metrics.runningNow > 0 && (
            <Metric
              icon={<span className="dash-live-dot inline-block h-2 w-2 rounded-full bg-success" />}
              label={t('dashboard.metricRunning', { defaultValue: '正在运行' })}
              value={t('dashboard.metricRunningValue', { count: Math.round(animatedRunning), defaultValue: `${Math.round(animatedRunning)} 个` })}
              accent
            />
          )}
        </div>

        {/* Health + version + refresh */}
        <div className="flex flex-shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'))}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            title={healthLabel}
          >
            <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]} ${tone === 'ok' ? 'dash-dot-glow' : 'animate-pulse'}`} />
            <span>{healthLabel}</span>
          </button>

          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5">
            <span className="font-mono text-[12px] text-foreground">v{currentVersion}</span>
            {updateAvailable && latestVersion && (
              <button
                type="button"
                onClick={() => void checkForUpdates()}
                className="inline-flex items-center gap-0.5 rounded-full bg-warning px-1.5 py-0.5 text-[11px] font-medium text-warning-foreground transition-transform hover:scale-[1.03]"
                title={t('dashboard.updateAvailable', { version: latestVersion, defaultValue: `v${latestVersion} 可用` })}
              >
                <ArrowUpCircle className="h-3 w-3" />
                {latestVersion}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center justify-center rounded-lg border border-border bg-card p-1.5 text-muted-foreground transition-all hover:rotate-90 hover:bg-accent/60 hover:text-foreground"
            title={t('dashboard.refresh', { defaultValue: '刷新' })}
            aria-label={t('dashboard.refresh', { defaultValue: '刷新' })}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
