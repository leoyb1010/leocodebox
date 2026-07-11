import { Command, FolderSearch, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MainContentStateViewProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';

export default function MainContentStateView({ mode, isMobile, onMenuClick }: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="leocodebox-workspace-enter flex flex-1 items-center justify-center px-6">
          <div className="w-full max-w-2xl">
            <div className="mb-7 flex items-start gap-4">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                <FolderSearch className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
              </div>
            </div>

            <div className="divide-y divide-border border-y border-border text-sm">
              <div className="flex items-center gap-3 py-3.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">1</span>
                <span className="flex-1 text-foreground">从左侧选择最近项目</span>
                <span className="hidden text-xs text-muted-foreground sm:inline">聊天、文件与历史会自动恢复</span>
              </div>
              <div className="flex items-center gap-3 py-3.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">2</span>
                <span className="flex-1 text-foreground">选择本机 Agent 并输入任务</span>
                <Command className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex items-center gap-3 py-3.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">3</span>
                <span className="flex-1 text-foreground">变更、命令与记录始终留在本机</span>
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
              </div>
            </div>

            <p className="mt-5 text-xs text-muted-foreground">
              {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
