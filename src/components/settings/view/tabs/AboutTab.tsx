import { useState } from 'react';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { LEOCODEBOX_WORDMARK_FONT_FAMILY } from '../../../../constants/branding';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';

const OWNER_URL = 'https://github.com/leoyb1010';

function updateStatusText(state: DesktopUpdateState | null) {
  if (!window.leocodeboxDesktopUpdater) return '浏览器模式不支持桌面应用更新';
  switch (state?.status) {
    case 'authentication-required': return '需要配置 GitHub 更新凭据';
    case 'checking': return '正在检查更新...';
    case 'available': return `发现新版本 v${state.latestVersion}`;
    case 'downloading': return `正在下载${state.progress === null ? '' : ` ${state.progress}%`}`;
    case 'downloaded': return `v${state.latestVersion} 已下载，等待安装`;
    case 'installing': return '正在停止本地服务并安装更新...';
    case 'up-to-date': return '当前已是最新版本';
    case 'development-build': return '开发构建不执行自动更新';
    case 'error': return '更新检查失败';
    default: return state?.configured ? '已启用应用内更新' : '尚未配置应用内更新';
  }
}

export default function AboutTab() {
  const {
    currentVersion,
    desktopUpdate,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    setGithubToken,
  } = useVersionCheck();
  const [token, setToken] = useState('');
  const [actionError, setActionError] = useState('');
  const [savingToken, setSavingToken] = useState(false);

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveToken = async () => {
    if (!token.trim()) return;
    setSavingToken(true);
    await runAction(async () => {
      await setGithubToken(token);
      setToken('');
      await checkForUpdates();
    });
    setSavingToken(false);
  };

  const isBusy = desktopUpdate?.status === 'checking'
    || desktopUpdate?.status === 'downloading'
    || desktopUpdate?.status === 'installing';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="leocodebox" className="h-10 w-10" />
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: LEOCODEBOX_WORDMARK_FONT_FAMILY }}
            >
              leocodebox
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">本地多智能体开发工作台</p>
        </div>
      </div>

      <section className="border-y border-border/60 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">应用内更新</h3>
            <p aria-live="polite" className="mt-1 text-xs text-muted-foreground">{updateStatusText(desktopUpdate)}</p>
          </div>
          {desktopUpdate?.status === 'up-to-date' && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
        </div>

        {window.leocodeboxDesktopUpdater && desktopUpdate?.credentialRequired && !desktopUpdate.configured && (
          <div className="mt-4 space-y-2">
            <label className="text-xs font-medium text-foreground" htmlFor="github-update-token">
              GitHub 仓库只读令牌
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  id="github-update-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="需授予 leocodebox 仓库 Contents 只读权限"
                  autoComplete="off"
                  className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <button
                type="button"
                disabled={!token.trim() || savingToken}
                onClick={() => void saveToken()}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {savingToken ? '保存中' : '保存并检查'}
              </button>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              仓库为 Private，凭据会通过 macOS 钥匙串加密保存，不会进入项目、日志或安装包。
            </p>
          </div>
        )}

        {desktopUpdate?.progress !== null && desktopUpdate?.status === 'downloading' && (
          <div
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={desktopUpdate.progress}
            className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${desktopUpdate.progress}%` }} />
          </div>
        )}

        {(actionError || desktopUpdate?.error) && (
          <p role="alert" className="mt-3 whitespace-pre-wrap text-xs text-destructive">{actionError || desktopUpdate?.error}</p>
        )}

        {window.leocodeboxDesktopUpdater && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isBusy || !desktopUpdate?.configured}
              onClick={() => void runAction(checkForUpdates)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
            >
              {desktopUpdate?.status === 'checking'
                ? <LoaderCircle className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              检查更新
            </button>
            {desktopUpdate?.status === 'available' && (
              <button
                type="button"
                onClick={() => void runAction(downloadUpdate)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
              >
                <Download className="h-4 w-4" />下载更新
              </button>
            )}
            {desktopUpdate?.status === 'downloaded' && (
              <button
                type="button"
                onClick={() => void runAction(installUpdate)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
              >
                <RotateCcw className="h-4 w-4" />重启并安装
              </button>
            )}
            {desktopUpdate?.configured && desktopUpdate.credentialRequired && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void runAction(() => setGithubToken(''))}
                className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />移除更新凭据
              </button>
            )}
          </div>
        )}
      </section>

      <div className="text-sm text-muted-foreground">
        <p>所有 Agent CLI、会话、配置与凭据均在本机运行和保存，不依赖 leocodebox 云端账户。</p>
      </div>

      <a
        href={OWNER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        GitHub
        <ExternalLink className="h-3.5 w-3.5" />
      </a>

      <div className="flex gap-4 text-xs text-muted-foreground/70">
        <a href="/LICENSE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">LICENSE</a>
        <a href="/NOTICE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">NOTICE 与第三方声明</a>
      </div>
    </div>
  );
}
