import { useEffect, useState } from 'react';

import { apiClient } from '../utils/apiClient';

type SwitchStatusProvider = {
  id: string;
  name: string;
  target: string;
  baseUrl?: string;
  endpointStats?: Record<string, { latencyMs?: number } | undefined>;
};

type SwitchStatusResponse = {
  success: boolean;
  activeByTarget?: Record<string, string>;
  providers?: SwitchStatusProvider[];
};

export type LeoapiActiveNode = {
  providerId: string;
  name: string;
  latencyMs: number | null;
};

/** Map of config target id (claude/codex/…) → currently applied Leoapi node. */
export type LeoapiActiveNodes = Record<string, LeoapiActiveNode>;

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Surfaces which Leoapi node each CLI target currently routes through, so the
 * workspace can show "via 节点名" instead of leaving switches invisible.
 * Empty map means every target is on its native configuration.
 */
export function useLeoapiStatus(): LeoapiActiveNodes {
  const [nodes, setNodes] = useState<LeoapiActiveNodes>({});

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const status = await apiClient.get<SwitchStatusResponse>('/api/leocodebox/switch/status');
        if (cancelled || !status?.success) return;
        const next: LeoapiActiveNodes = {};
        for (const [target, providerId] of Object.entries(status.activeByTarget || {})) {
          if (!providerId) continue;
          const provider = status.providers?.find((entry) => entry.id === providerId);
          if (!provider) continue;
          const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
          const stats = baseUrl ? provider.endpointStats?.[baseUrl] : undefined;
          next[target] = {
            providerId,
            name: provider.name,
            latencyMs: typeof stats?.latencyMs === 'number' ? stats.latencyMs : null,
          };
        }
        setNodes(next);
      } catch {
        // The badge is informational; a failed poll keeps the last known state.
      }
    };

    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return nodes;
}
