import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

import { authenticatedFetch } from '../../../../../utils/api';
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
  installSource: string;
  executablePath: string | null;
  canInstall: boolean;
  canSelfUpdate: boolean;
  docsUrl?: string;
};

type CliStatusResponse = {
  success: boolean;
  tools: CliToolStatus[];
};

/**
 * Live view of the locally installed agent CLIs: current version, whether a
 * newer version exists on the registry, and a one-click self-update button.
 */
export default function CliToolsSection() {
  const [tools, setTools] = useState<CliToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await authenticatedFetch('/api/leocodebox/cli/status');
      const data = (await response.json()) as CliStatusResponse;
      if (data?.success && Array.isArray(data.tools)) {
        setTools(data.tools);
      }
    } catch (error) {
      console.error('Failed to load CLI status:', error);
      setLoadError(error instanceof Error ? error.message : '无法读取本机智能体状态');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(async (tool: CliToolStatus, action: 'install' | 'update') => {
    setUpdating(tool.id);
    setMessage(null);
    try {
      const response = await authenticatedFetch(`/api/leocodebox/cli/${tool.id}/${action}`, {
        method: 'POST',
      });
      const data = await response.json();
      if (data?.success) {
        setMessage(action === 'install'
          ? `${tool.label} 已安装${data.currentVersion ? ` (${data.currentVersion})` : ''}。`
          : data.changed
            ? `${tool.label} 已更新到 ${data.currentVersion ?? '最新版本'}。`
            : `${tool.label} 已是最新版本 (${data.currentVersion ?? tool.currentVersion ?? ''})。`);
      } else {
        setMessage(`${tool.label} ${action === 'install' ? '安装' : '更新'}失败：${data?.error ?? '未知错误'}`);
      }
    } catch (error) {
      setMessage(`${tool.label} ${action === 'install' ? '安装' : '更新'}失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setUpdating(null);
      void load();
    }
  }, [load]);

  return (
    <div className="border-b border-border/60 bg-muted/20 px-4 py-3 md:px-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">本机智能体</h3>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="刷新"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          刷新
        </button>
      </div>

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
                      有新版本
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      最新
                    </span>
                  )
                ) : tool.installed ? (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-700 dark:text-red-300">不可运行</span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">未安装</span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {tool.installed && tool.runnable ? (
                  <>
                    当前 {tool.currentVersion ?? '未知'} · {tool.installSource || '来源未知'}
                    {tool.updateAvailable && tool.latestVersion ? ` → 最新 ${tool.latestVersion}` : ''}
                  </>
                ) : tool.installed ? (
                  <span title={tool.error ?? undefined}>{tool.error || '已检测到命令，但版本检查失败'}</span>
                ) : (
                  <span>未找到本机命令 {tool.command}</span>
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
                更新
              </button>
            )}
            {!tool.installed && tool.canInstall && (
              <button
                onClick={() => void runAction(tool, 'install')}
                disabled={updating !== null}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {updating === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
                安装
              </button>
            )}
            {!tool.installed && !tool.canInstall && tool.docsUrl && (
              <a
                href={tool.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
              >
                安装说明
              </a>
            )}
          </div>
        ))}
      </div>

      {loadError && <p role="alert" className="mt-2 text-xs text-destructive">无法读取本机智能体状态：{loadError}</p>}
      {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
