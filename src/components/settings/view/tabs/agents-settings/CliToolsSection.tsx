import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiRequest } from '../../../../../utils/api';
import { cn } from '../../../../../lib/utils';

type CliToolStatus = {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  runnable: boolean;
  error: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  latestCheckedAt?: string | null;
  latestVersionSource?: string;
  installSource: string;
  executablePath: string | null;
  canInstall: boolean;
  canSelfUpdate: boolean;
  docsUrl?: string;
};

type CliStatusResponse = {
  success: boolean;
  tools: CliToolStatus[];
  checkedAt?: string;
};

type CliActionResponse = {
  success?: boolean;
  error?: string;
  changed?: boolean;
  currentVersion?: string | null;
};

/**
 * Live view of the locally installed agent CLIs: current version, whether a
 * newer version exists on the registry, and a one-click self-update button.
 */
export default function CliToolsSection() {
  const { t, i18n } = useTranslation('settings');
  const [tools, setTools] = useState<CliToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const load = useCallback(async (forceLatest = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest(`/api/leocodebox/cli/status${forceLatest ? '?refresh=1' : ''}`) as CliStatusResponse;
      if (data?.success && Array.isArray(data.tools)) {
        setTools(data.tools);
        setCheckedAt(data.checkedAt || new Date().toISOString());
      }
    } catch (error) {
      console.error('Failed to load CLI status:', error);
      setLoadError(error instanceof Error ? error.message : t('agents.cliTools.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(false);
  }, [load, t]);

  const runAction = useCallback(async (tool: CliToolStatus, action: 'install' | 'update') => {
    setUpdating(tool.id);
    setMessage(null);
    try {
      const data = await apiRequest(`/api/leocodebox/cli/${tool.id}/${action}`, {
        method: 'POST',
      }) as CliActionResponse;
      if (data?.success) {
        setMessage(action === 'install'
          ? t('agents.cliTools.installSuccess', { tool: tool.label, version: data.currentVersion || '' })
          : data.changed
            ? t('agents.cliTools.updateSuccess', { tool: tool.label, version: data.currentVersion ?? t('agents.cliTools.latestVersion') })
            : t('agents.cliTools.alreadyLatest', { tool: tool.label, version: data.currentVersion ?? tool.currentVersion ?? '' }));
      } else {
        setMessage(t('agents.cliTools.actionFailed', { tool: tool.label, action: t(`agents.cliTools.${action}`), error: data?.error ?? t('agents.cliTools.unknownError') }));
      }
    } catch (error) {
      setMessage(t('agents.cliTools.actionFailed', { tool: tool.label, action: t(`agents.cliTools.${action}`), error: error instanceof Error ? error.message : t('agents.cliTools.unknownError') }));
    } finally {
      setUpdating(null);
      void load(true);
    }
  }, [load, t]);

  return (
    <div className="border-b border-border/60 bg-muted/20 px-4 py-3 md:px-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('agents.cliTools.title')}</h3>
        <button
          onClick={() => void load(true)}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('agents.cliTools.refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          {t('agents.cliTools.refresh')}
        </button>
      </div>
      {checkedAt && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          {t('agents.cliTools.versionCheck', { time: new Date(checkedAt).toLocaleString(i18n.language) })} · {t('agents.cliTools.cacheHint')}
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tools.map((tool) => (
          <div
            key={tool.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{tool.label}</span>
                {tool.installed && tool.runnable ? (
                  tool.updateAvailable ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      <ArrowUpCircle className="h-3 w-3" />
                      {t('agents.cliTools.updateAvailable')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      {t('agents.cliTools.latest')}
                    </span>
                  )
                ) : tool.installed ? (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-700 dark:text-red-300">{t('agents.cliTools.notRunnable')}</span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('agents.cliTools.notInstalled')}</span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {tool.installed && tool.runnable ? (
                  <>
                    {t('agents.cliTools.currentVersion', { version: tool.currentVersion ?? t('agents.cliTools.unknownVersion'), source: tool.installSource || t('agents.cliTools.unknownSource') })}
                    {tool.updateAvailable && tool.latestVersion ? ` → ${t('agents.cliTools.latestVersionLabel', { version: tool.latestVersion })}` : ''}
                  </>
                ) : tool.installed ? (
                  <span title={tool.error ?? undefined}>{tool.error || t('agents.cliTools.commandDetectedFailed')}</span>
                ) : (
                  <span>{t('agents.cliTools.commandMissing', { command: tool.command })}</span>
                )}
              </div>
            </div>

            {tool.installed && tool.runnable && tool.updateAvailable && tool.canSelfUpdate && (
              <button
                onClick={() => void runAction(tool, 'update')}
                disabled={updating !== null}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {updating === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
                {t('agents.cliTools.update')}
              </button>
            )}
            {!tool.installed && tool.canInstall && (
              <button
                onClick={() => void runAction(tool, 'install')}
                disabled={updating !== null}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {updating === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
                {t('agents.cliTools.install')}
              </button>
            )}
            {!tool.installed && !tool.canInstall && tool.docsUrl && (
              <a
                href={tool.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
              >
                {t('agents.cliTools.installationGuide')}
              </a>
            )}
          </div>
        ))}
      </div>

      {loadError && <p role="alert" className="mt-2 text-xs text-destructive">{t('agents.cliTools.loadFailed')}: {loadError}</p>}
      {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
