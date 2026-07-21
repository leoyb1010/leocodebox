import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useDoctorReport } from '../../../hooks/useDoctorReport';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { resolveDoctorTone, type DoctorTone } from '../../app/doctorLight';

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

type DashboardHeroProps = {
  username: string;
  onRefresh: () => void;
};

/**
 * Full-width top strip: greeting + local account, environment health light,
 * and the current version with an update badge. Clicking the health light
 * opens the same doctor popover as the status bar (via the global event).
 */
export default function DashboardHero({ username, onRefresh }: DashboardHeroProps) {
  const { t } = useTranslation();
  const report = useDoctorReport();
  const { currentVersion, updateAvailable, latestVersion, checkForUpdates } = useVersionCheck();

  const summary = report?.summary;
  const tone = resolveDoctorTone(summary);
  const greeting = t(greetingKey(new Date().getHours()), { defaultValue: '你好' });

  const healthLabel = !summary
    ? t('workspaceShell.healthChecking', { defaultValue: '体检中' })
    : summary.fail > 0
      ? t('dashboard.healthSummary', { ok: summary.ok, warn: summary.warn, fail: summary.fail, defaultValue: `异常 ${summary.fail}` })
      : summary.warn > 0
        ? t('dashboard.healthSummary', { ok: summary.ok, warn: summary.warn, fail: 0, defaultValue: `注意 ${summary.warn}` })
        : t('dashboard.healthOkCount', { count: summary.ok, defaultValue: `就绪 ${summary.ok}` });

  return (
    <div className="dash-enter rounded-xl border border-border bg-card text-card-foreground shadow-elevation-1" style={{ ['--dash-delay' as string]: '0ms' }}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-medium text-foreground">
            {greeting}，{username}
          </h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {t('dashboard.localAccount', { defaultValue: '本地账号' })} · {t('dashboard.onboarded', { defaultValue: '已完成引导' })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'))}
            className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            title={healthLabel}
          >
            <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]} ${tone !== 'ok' ? 'animate-pulse' : ''}`} />
            <span>{healthLabel}</span>
          </button>

          <div className="flex items-center gap-2 rounded-lg bg-secondary/70 px-2.5 py-1">
            <span className="font-mono text-[13px] text-foreground">v{currentVersion}</span>
            {updateAvailable && latestVersion && (
              <button
                type="button"
                onClick={() => void checkForUpdates()}
                className="inline-flex items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-[11px] font-medium text-warning-foreground transition-transform hover:scale-[1.03]"
                title={t('dashboard.updateAvailable', { version: latestVersion, defaultValue: `v${latestVersion} 可用` })}
              >
                <ArrowUpCircle className="h-3 w-3" />
                v{latestVersion}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
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
