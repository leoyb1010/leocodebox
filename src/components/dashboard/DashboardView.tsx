import { useCallback } from 'react';

import { useDashboardData } from '../../hooks/useDashboardData';

import AgentGridCard from './cards/AgentGridCard';
import DashboardHero from './cards/DashboardHero';
import MissionSummaryCard from './cards/MissionSummaryCard';
import QuickActionsBar from './cards/QuickActionsBar';
import RunningSessionsCard from './cards/RunningSessionsCard';
import UsageCenterCard from './cards/UsageCenterCard';

type DashboardViewProps = {
  onNavigateToSession?: (sessionId: string) => void;
  onShowTab?: (tab: string) => void;
  onNewChat?: () => void;
};

/**
 * The dashboard landing view: a 3-column responsive grid. Left = agent grid,
 * middle = live sessions + missions, right = usage centre. Hero on top,
 * quick actions along the bottom. Every card staggers its entrance.
 */
export default function DashboardView({ onNavigateToSession, onShowTab, onNewChat }: DashboardViewProps) {
  const data = useDashboardData();

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      if (sessionId) {
        onNavigateToSession?.(sessionId);
      } else {
        onNewChat?.();
      }
    },
    [onNavigateToSession, onNewChat],
  );

  const handleOpenMissions = useCallback(() => onShowTab?.('missions'), [onShowTab]);
  const handleRunDoctor = useCallback(() => {
    window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'));
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1400px] space-y-3 p-4">
        <DashboardHero username={data.authUser.data?.username ?? 'local-user'} onRefresh={data.refresh} />

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          {/* Left: agent grid (spans 5 on large). */}
          <div className="lg:col-span-5">
            <AgentGridCard
              cliTools={data.cliTools.data}
              providerAuth={data.providerAuth.data}
              loading={data.cliTools.loading || data.providerAuth.loading}
              error={data.cliTools.error ?? data.providerAuth.error}
              onRefresh={data.refresh}
              delay={40}
            />
          </div>

          {/* Middle: live sessions + missions (spans 4). */}
          <div className="flex flex-col gap-3 lg:col-span-4">
            <RunningSessionsCard onOpenSession={handleOpenSession} delay={80} />
            <MissionSummaryCard
              missions={data.missions.data}
              loading={data.missions.loading}
              error={data.missions.error}
              onOpenMissions={handleOpenMissions}
              delay={120}
            />
          </div>

          {/* Right: usage centre (spans 3). */}
          <div className="lg:col-span-3">
            <UsageCenterCard
              usage={data.usage.data}
              quota={data.quota.data}
              quotaLoading={data.quota.loading}
              loading={data.usage.loading}
              error={data.usage.error}
              onRefresh={data.refresh}
              delay={160}
            />
          </div>
        </div>

        <QuickActionsBar onRunDoctor={handleRunDoctor} delay={200} />
      </div>
    </div>
  );
}
