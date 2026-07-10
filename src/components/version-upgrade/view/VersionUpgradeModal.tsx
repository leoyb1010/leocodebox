import { Download, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useVersionCheck } from '../../../hooks/useVersionCheck';

interface VersionUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function VersionUpgradeModal({ isOpen, onClose }: VersionUpgradeModalProps) {
  const {
    currentVersion,
    latestVersion,
    releaseInfo,
    desktopUpdate,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
  } = useVersionCheck();

  if (!isOpen) return null;

  const status = desktopUpdate?.status;
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-label="关闭更新窗口" />
      <div className="relative max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">leocodebox 应用更新</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              当前 v{currentVersion}{latestVersion ? `，最新 v${latestVersion}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        {releaseInfo?.body && (
          <div className="prose prose-sm mt-5 max-w-none rounded-md border border-border bg-muted/30 p-4 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{releaseInfo.body}</ReactMarkdown>
          </div>
        )}

        {status === 'downloading' && (
          <div className="mt-5">
            <div className="mb-2 flex justify-between text-xs text-muted-foreground">
              <span>正在后台下载</span><span>{desktopUpdate?.progress ?? 0}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${desktopUpdate?.progress ?? 0}%` }} />
            </div>
          </div>
        )}

        {status === 'authentication-required' && (
          <p className="mt-5 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            Private Release 需要更新凭据，请到“设置 → 关于”配置后再检查。
          </p>
        )}
        {desktopUpdate?.error && (
          <p className="mt-5 whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {desktopUpdate.error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-md border border-input px-4 text-sm hover:bg-accent">
            稍后
          </button>
          {status === 'available' && (
            <button type="button" onClick={() => void downloadUpdate()} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              <Download className="h-4 w-4" />后台下载
            </button>
          )}
          {status === 'downloaded' && (
            <button type="button" onClick={() => void installUpdate()} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              <RotateCcw className="h-4 w-4" />重启并安装
            </button>
          )}
          {(status === 'error' || status === 'up-to-date' || status === 'idle') && (
            <button
              type="button"
              disabled={busy || !desktopUpdate?.configured}
              onClick={() => void checkForUpdates()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              重新检查
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
