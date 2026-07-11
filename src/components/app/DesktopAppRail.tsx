import {
  Activity,
  FolderKanban,
  GitBranch,
  MessageSquare,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';
import type { AppTab } from '../../types/app';

type DesktopAppRailProps = {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  onShowSettings: () => void;
  onShowLeoapi: () => void;
  onShowLocalLog: () => void;
};

const primaryItems = [
  { id: 'projects', label: '项目', icon: FolderKanban, tab: 'files' as AppTab },
  { id: 'chat', label: '对话', icon: MessageSquare, tab: 'chat' as AppTab },
  { id: 'git', label: '变更', icon: GitBranch, tab: 'git' as AppTab },
];

export default function DesktopAppRail({
  activeTab,
  onTabChange,
  onShowSettings,
  onShowLeoapi,
  onShowLocalLog,
}: DesktopAppRailProps) {
  return (
    <aside className="leocodebox-app-rail hidden h-full w-[58px] flex-shrink-0 flex-col items-center border-r border-border md:flex">
      <div className="flex h-14 w-full items-center justify-center border-b border-border/70">
        <img src="/logo-32.png" alt="leocodebox" className="h-7 w-7 rounded-md" />
      </div>

      <nav className="flex w-full flex-1 flex-col items-center gap-1 px-2 py-3" aria-label="工作区导航">
        {primaryItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.tab;
          return (
            <Tooltip key={item.id} content={item.label} position="right">
              <button
                type="button"
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onTabChange(item.tab)}
                className={cn('leocodebox-rail-button', isActive && 'is-active')}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.1 : 1.7} />
                <span>{item.label}</span>
              </button>
            </Tooltip>
          );
        })}

        <div className="my-2 h-px w-7 bg-border/70" />

        <Tooltip content="本地记录" position="right">
          <button type="button" aria-label="本地记录" onClick={onShowLocalLog} className="leocodebox-rail-button">
            <Activity className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span>记录</span>
          </button>
        </Tooltip>
        <Tooltip content="Leoapi" position="right">
          <button type="button" aria-label="Leoapi" onClick={onShowLeoapi} className="leocodebox-rail-button">
            <SlidersHorizontal className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span>Leoapi</span>
          </button>
        </Tooltip>
      </nav>

      <div className="flex w-full flex-col items-center gap-1 border-t border-border/70 px-2 py-3">
        <Tooltip content="设置" position="right">
          <button type="button" aria-label="设置" onClick={onShowSettings} className="leocodebox-rail-button">
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span>设置</span>
          </button>
        </Tooltip>
        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" title="本机服务正常" />
      </div>
    </aside>
  );
}
