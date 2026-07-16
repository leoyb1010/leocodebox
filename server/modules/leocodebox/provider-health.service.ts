import { applyProviderTransactionally } from './provider-apply.service.js';
import { probeProviderHealth } from './provider-discovery.service.js';
import type { ProviderHealthProbe } from './provider-discovery.service.js';
import {
  readStore,
  upsertProviderInStore,
  withSwitchMutation,
  writeStore,
} from './provider-store.service.js';
import type { SwitchProvider } from './provider-store.service.js';
import { TARGETS } from './provider-switch.config.js';
import { nowIso } from './provider-switch.storage.js';

/**
 * Background health monitor for the active Leoapi provider of each target.
 *
 * Design constraints (deliberate, keep them):
 * - Probes are the cost-free GET model-list probe — a poll NEVER spends tokens
 *   or hits chat endpoints (see probeProviderHealth).
 * - Only the ACTIVE provider per writable target is probed; idle providers cost
 *   nothing until they are considered as failover candidates.
 * - Auto-failover is per-target opt-in (default off). Even when on, it only
 *   fires on the ok→degraded transition, applies through the same transactional
 *   apply path as a manual switch, and records what it did so the UI can offer
 *   a one-click undo (undo = plain re-apply of the previous provider).
 * - State lives in memory: a restart starts from a clean "unknown" slate, which
 *   is the honest reading — we have no fresh probe yet.
 */

export type TargetHealthStatus = 'ok' | 'degraded' | 'unknown';

export type TargetHealth = {
  target: string;
  providerId: string;
  providerName: string;
  status: TargetHealthStatus;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastHttpStatus: number | null;
  lastNote: string;
  lastCheckedAt: string;
  /** Set when this monitor auto-switched the target; cleared on next manual apply. */
  lastAutoFailover: { fromId: string; fromName: string; toId: string; toName: string; at: string } | null;
};

export type HealthSnapshot = {
  enabled: boolean;
  intervalMinutes: number;
  autoFailoverTargets: string[];
  lastRunAt: string | null;
  targets: Record<string, TargetHealth>;
};

/** Consecutive failed polls before a target flips to degraded (≈2 intervals). */
export const DEGRADE_THRESHOLD = 2;

type ProbeFn = (provider: SwitchProvider) => Promise<ProviderHealthProbe>;

const healthByTarget = new Map<string, TargetHealth>();
let lastRunAt: string | null = null;
let tickInFlight = false;
let schedulerTimer: NodeJS.Timeout | null = null;
let lastPollAt = 0;

function baseHealth(target: string, provider: SwitchProvider): TargetHealth {
  return {
    target,
    providerId: provider.id,
    providerName: provider.name,
    status: 'unknown',
    consecutiveFailures: 0,
    lastLatencyMs: null,
    lastHttpStatus: null,
    lastNote: '',
    lastCheckedAt: '',
    lastAutoFailover: null,
  };
}

/** Pick the first same-target sibling that passes a live probe. Sequential on purpose — candidates are probed one at a time, cheapest-first by stored latency. */
async function findHealthyFailoverCandidate(
  providers: SwitchProvider[],
  target: string,
  excludeId: string,
  probe: ProbeFn,
): Promise<SwitchProvider | null> {
  const candidates = providers
    .filter((provider) => provider.target === target && provider.id !== excludeId && provider.baseUrl)
    .sort((left, right) => {
      const leftStat = (left.endpointStats?.[left.baseUrl] as { latencyMs?: number } | undefined)?.latencyMs ?? Number.MAX_SAFE_INTEGER;
      const rightStat = (right.endpointStats?.[right.baseUrl] as { latencyMs?: number } | undefined)?.latencyMs ?? Number.MAX_SAFE_INTEGER;
      return leftStat - rightStat;
    });
  for (const candidate of candidates) {
    try {
      const result = await probe(candidate);
      if (result.ok) return candidate;
    } catch {
      // A throwing probe just disqualifies the candidate.
    }
  }
  return null;
}

async function autoFailover(target: string, from: SwitchProvider, probe: ProbeFn): Promise<TargetHealth['lastAutoFailover']> {
  return withSwitchMutation(async () => {
    const store = await readStore();
    // Re-check under the mutation lock: a manual switch may have raced us.
    if (store.activeByTarget[target] !== from.id) return null;
    const candidate = await findHealthyFailoverCandidate(store.providers, target, from.id, probe);
    if (!candidate) return null;
    await applyProviderTransactionally(candidate, async () => {
      store.activeByTarget[target] = candidate.id;
      candidate.lastAppliedAt = nowIso();
      candidate.updatedAt = nowIso();
      upsertProviderInStore(store, candidate);
      await writeStore(store);
    });
    return { fromId: from.id, fromName: from.name, toId: candidate.id, toName: candidate.name, at: nowIso() };
  });
}

/**
 * One polling round: probe the active provider of every writable target and
 * update the in-memory health map. Exported with an injectable probe so tests
 * can drive the state machine without network.
 */
export async function runHealthTick(probe: ProbeFn = probeProviderHealth): Promise<HealthSnapshot> {
  if (tickInFlight) return getHealthSnapshot();
  tickInFlight = true;
  try {
    const store = await readStore();
    lastRunAt = nowIso();
    const seenTargets = new Set<string>();

    for (const [target, providerId] of Object.entries(store.activeByTarget)) {
      if (!TARGETS[target]?.writable) continue;
      const provider = store.providers.find((item) => item.id === providerId);
      if (!provider || !provider.baseUrl) {
        healthByTarget.delete(target);
        continue;
      }
      seenTargets.add(target);

      const previous = healthByTarget.get(target);
      const entry: TargetHealth = previous && previous.providerId === provider.id
        ? { ...previous, providerName: provider.name }
        : baseHealth(target, provider);

      const result = await probe(provider);
      entry.lastLatencyMs = result.latencyMs;
      entry.lastHttpStatus = result.httpStatus;
      entry.lastNote = result.note;
      entry.lastCheckedAt = nowIso();

      if (result.ok) {
        entry.consecutiveFailures = 0;
        entry.status = 'ok';
      } else {
        entry.consecutiveFailures += 1;
        const wasDegraded = entry.status === 'degraded';
        entry.status = entry.consecutiveFailures >= DEGRADE_THRESHOLD ? 'degraded' : entry.status === 'ok' ? 'ok' : 'unknown';
        if (entry.status === 'degraded' && !wasDegraded
          && store.healthMonitor.autoFailoverTargets.includes(target)) {
          const failover = await autoFailover(target, provider, probe);
          if (failover) {
            const next = baseHealth(target, { ...provider, id: failover.toId, name: failover.toName } as SwitchProvider);
            next.status = 'ok';
            next.lastAutoFailover = failover;
            next.lastCheckedAt = nowIso();
            healthByTarget.set(target, next);
            continue;
          }
        }
      }
      healthByTarget.set(target, entry);
    }

    // Drop stale entries for targets that no longer have an active provider.
    for (const target of [...healthByTarget.keys()]) {
      if (!seenTargets.has(target)) healthByTarget.delete(target);
    }
    return getHealthSnapshot(store.healthMonitor);
  } finally {
    tickInFlight = false;
  }
}

export function getHealthSnapshot(settings?: { enabled: boolean; intervalMinutes: number; autoFailoverTargets: string[] }): HealthSnapshot {
  return {
    enabled: settings?.enabled ?? true,
    intervalMinutes: settings?.intervalMinutes ?? 5,
    autoFailoverTargets: settings?.autoFailoverTargets ?? [],
    lastRunAt,
    targets: Object.fromEntries(healthByTarget),
  };
}

/** Manual apply must clear the auto-failover breadcrumb — the user has taken over. */
export function clearAutoFailoverRecord(target: string): void {
  const entry = healthByTarget.get(target);
  if (entry?.lastAutoFailover) healthByTarget.set(target, { ...entry, lastAutoFailover: null });
}

/**
 * Start the background scheduler. A fixed 60s heartbeat checks whether a poll
 * is due per the persisted interval, so settings changes take effect without
 * timer juggling. unref() keeps the timer from blocking process exit.
 */
export function startHealthMonitor(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void (async () => {
      try {
        const store = await readStore();
        if (!store.healthMonitor.enabled) return;
        const dueMs = store.healthMonitor.intervalMinutes * 60_000;
        if (Date.now() - lastPollAt < dueMs) return;
        lastPollAt = Date.now();
        await runHealthTick();
      } catch (error) {
        console.warn('Leoapi health monitor tick failed:', error);
      }
    })();
  }, 60_000);
  schedulerTimer.unref();
}

export function stopHealthMonitor(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

/** Test hook: reset all in-memory monitor state. */
export function resetHealthStateForTests(): void {
  healthByTarget.clear();
  lastRunAt = null;
  lastPollAt = 0;
  tickInFlight = false;
}
