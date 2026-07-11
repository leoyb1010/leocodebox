import { Cpu, HardDrive, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';

type WorkspaceStatusBarProps = {
  selectedProject: Project | null;
  runningCount: number;
};

export default function WorkspaceStatusBar({ selectedProject, runningCount }: WorkspaceStatusBarProps) {
  const { t } = useTranslation();
  return (
    <footer className="leocodebox-status-bar hidden h-7 flex-shrink-0 items-center justify-between border-t border-border px-3 text-[10px] text-muted-foreground md:flex">
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {t('workspaceShell.serviceHealthy')}
        </span>
        {selectedProject && (
          <span className="max-w-[42vw] truncate font-mono" title={selectedProject.fullPath}>
            {selectedProject.fullPath}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1"><Cpu className="h-3 w-3" />{runningCount > 0 ? t('workspaceShell.tasksRunning', { count: runningCount }) : t('workspaceShell.agentIdle')}</span>
        <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{t('workspaceShell.localOnly')}</span>
        <span className="inline-flex items-center gap-1"><HardDrive className="h-3 w-3" />{t('workspaceShell.autoSave')}</span>
      </div>
    </footer>
  );
}
