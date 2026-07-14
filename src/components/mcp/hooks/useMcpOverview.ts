import { useCallback, useEffect, useState } from 'react';

import { MCP_PROVIDER_NAMES } from '../constants';
import type { McpProvider, ProviderMcpServer } from '../types';
import { aggregateInstalledMcp, type McpOverviewRow } from '../utils/mcpFormatting';

import { fetchProviderScopeServers } from './useMcpServers';

const OVERVIEW_CACHE_TTL_MS = 30_000;
const PROVIDERS = Object.keys(MCP_PROVIDER_NAMES) as McpProvider[];

type OverviewCache = { rows: McpOverviewRow[]; errors: string[]; updatedAt: number };
let overviewCache: OverviewCache | null = null;

type McpOverviewState = {
  rows: McpOverviewRow[];
  loading: boolean;
  errors: string[];
  reload: () => void;
};

/**
 * Read-only aggregation of user-scope MCP servers across every supported CLI.
 * Each provider is queried independently (allSettled) so one unreadable CLI
 * config degrades to a soft error instead of blanking the whole panel. A short
 * module cache keeps repeated Agents-tab switches from refetching.
 */
export function useMcpOverview(active: boolean): McpOverviewState {
  const [rows, setRows] = useState<McpOverviewRow[]>(() => overviewCache?.rows ?? []);
  const [errors, setErrors] = useState<string[]>(() => overviewCache?.errors ?? []);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;

    if (reloadKey === 0 && overviewCache && Date.now() - overviewCache.updatedAt < OVERVIEW_CACHE_TTL_MS) {
      setRows(overviewCache.rows);
      setErrors(overviewCache.errors);
      return undefined;
    }

    setLoading(true);
    void Promise.allSettled(PROVIDERS.map((provider) => fetchProviderScopeServers(provider, 'user'))).then((settled) => {
      if (cancelled) return;
      const perProvider: Partial<Record<McpProvider, ProviderMcpServer[]>> = {};
      const nextErrors: string[] = [];
      settled.forEach((result, index) => {
        const provider = PROVIDERS[index];
        if (result.status === 'fulfilled') {
          perProvider[provider] = result.value;
        } else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          nextErrors.push(`${MCP_PROVIDER_NAMES[provider]}: ${message}`);
        }
      });
      const nextRows = aggregateInstalledMcp(perProvider);
      overviewCache = { rows: nextRows, errors: nextErrors, updatedAt: Date.now() };
      setRows(nextRows);
      setErrors(nextErrors);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [active, reloadKey]);

  const reload = useCallback(() => {
    overviewCache = null;
    setReloadKey((key) => key + 1);
  }, []);

  return { rows, loading, errors, reload };
}
