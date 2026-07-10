import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../utils/api';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

type BrowserUseSettings = {
  enabled: boolean;
};

type BrowserUseStatus = {
  enabled: boolean;
  available: boolean;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  installInProgress: boolean;
  message: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

function localizeRuntimeMessage(message?: string): string {
  switch (message) {
    case 'Install Playwright and Chromium to use browser sessions.':
      return '需要安装 Playwright 和 Chromium 才能使用浏览器会话。';
    case 'Playwright is installed, but Chromium is missing. Install the Chromium runtime to continue.':
      return '已安装 Playwright，但缺少 Chromium。请先安装 Chromium 运行环境。';
    case 'Browser runtime is not ready.':
      return '浏览器运行环境尚未就绪。';
    case 'Browser runtime is available.':
      return '浏览器运行环境已就绪。';
    default:
      return message || '安装浏览器运行环境后，本机智能体才能创建浏览器会话。';
  }
}

export default function BrowserUseSettingsTab() {
  const [settings, setSettings] = useState<BrowserUseSettings | null>(null);
  const [status, setStatus] = useState<BrowserUseStatus | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const settingsResponse = await authenticatedFetch('/api/browser-use/settings');
    const settingsData = await readJson<{ data: { settings: BrowserUseSettings } }>(settingsResponse);
    setSettings(settingsData.data.settings);
  }, []);

  const loadStatus = useCallback(async () => {
    const statusResponse = await authenticatedFetch('/api/browser-use/status');
    const statusData = await readJson<{ data: BrowserUseStatus }>(statusResponse);
    setStatus(statusData.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsSettingsLoading(true);
    setIsStatusLoading(true);

    void loadSettings()
      .catch((err) => setError(err instanceof Error ? err.message : '无法读取浏览器设置'))
      .finally(() => setIsSettingsLoading(false));

    void loadStatus()
      .catch((err) => setError(err instanceof Error ? err.message : '无法读取浏览器状态'))
      .finally(() => setIsStatusLoading(false));
  }, [loadSettings, loadStatus]);

  const updateSettings = async (nextSettings: Partial<BrowserUseSettings>) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/browser-use/settings', {
        method: 'PUT',
        body: JSON.stringify(nextSettings),
      });
      const data = await readJson<{ data: { settings: BrowserUseSettings } }>(response);
      setSettings(data.data.settings);
      window.dispatchEvent(new Event('browserUseSettingsChanged'));
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法保存浏览器设置');
    } finally {
      setIsStatusLoading(false);
      setIsSaving(false);
    }
  };

  const installBrowserBinaries = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/browser-use/runtime/install', { method: 'POST' });
      await readJson(response);
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法安装浏览器运行环境');
    } finally {
      setIsStatusLoading(false);
      setIsInstalling(false);
    }
  };

  const browserEnabled = settings?.enabled === true;
  const needsBrowserBinaries = Boolean(browserEnabled && status && (!status.playwrightInstalled || !status.chromiumInstalled));
  const runtimeLabel = (installed?: boolean) => {
    if (isStatusLoading && !status) {
      return '检查中';
    }
    return installed ? '已安装' : '未安装';
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title="浏览器"
        description="允许本机智能体创建受控的 Playwright 浏览器会话，并在浏览器页面中查看运行状态。"
      >
        <SettingsCard divided>
          <SettingsRow
            label="启用浏览器能力"
            description="启用后，支持的智能体可以创建浏览器会话；您可以查看和停止这些会话。"
          >
            {isSettingsLoading && !settings ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                checked={browserEnabled}
                onChange={(value) => void updateSettings({ enabled: value })}
                ariaLabel="启用浏览器能力"
                disabled={isSaving}
              />
            )}
          </SettingsRow>

          <div className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border px-2 py-1">
                Playwright: {runtimeLabel(status?.playwrightInstalled)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                Chromium: {runtimeLabel(status?.chromiumInstalled)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                状态：{isStatusLoading && !status ? '检查中' : status?.available ? '可用' : browserEnabled ? '需要安装' : '未启用'}
              </span>
            </div>

            {needsBrowserBinaries && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-foreground">需要浏览器运行环境</div>
                  <p className="text-sm text-muted-foreground">
                    {localizeRuntimeMessage(status?.message)}
                  </p>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => void installBrowserBinaries()}
                  disabled={isInstalling || status?.installInProgress}
                  className="flex-shrink-0"
                >
                  {isInstalling || status?.installInProgress ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {isInstalling || status?.installInProgress ? '安装中…' : '安装运行环境'}
                </Button>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
