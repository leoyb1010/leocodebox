import { getConnection } from '@/modules/database/index.js';


const DEFAULT_PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  haiku: { input: 0.8, output: 4 },
  'gpt-5': { input: 2, output: 8 },
  'gpt-4': { input: 5, output: 15 },
  grok: { input: 5, output: 15 },
};

function modelPrice(provider: string, model?: string | null) {
  const configured = process.env.LEOCODEBOX_MODEL_PRICES_JSON;
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as Record<string, { input: number; output: number }>;
      const key = Object.keys(parsed).find((candidate) => String(model || provider).toLowerCase().includes(candidate.toLowerCase()));
      if (key) return parsed[key];
    } catch { /* use built-ins */ }
  }
  const key = Object.keys(DEFAULT_PRICES_PER_MILLION).find((candidate) => String(model || provider).toLowerCase().includes(candidate));
  return (key && DEFAULT_PRICES_PER_MILLION[key]) || { input: 0, output: 0 };
}

export function estimateUsageCostUsd(provider: string, model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const price = modelPrice(provider, model);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export type UsageRecord = {
  projectPath?: string | null;
  provider: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
};

export type UsageSummary = {
  day: string;
  provider: string;
  model: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
};

export const usageDb = {
  record(record: UsageRecord): void {
    const db = getConnection();
    const day = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO usage_daily
        (day, project_path, provider, model, session_count, input_tokens, output_tokens, cache_tokens, cost_usd, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(day, project_path, provider, model) DO UPDATE SET
        session_count = usage_daily.session_count + 1,
        input_tokens = usage_daily.input_tokens + excluded.input_tokens,
        output_tokens = usage_daily.output_tokens + excluded.output_tokens,
        cache_tokens = usage_daily.cache_tokens + excluded.cache_tokens,
        cost_usd = usage_daily.cost_usd + excluded.cost_usd,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      day,
      record.projectPath ?? null,
      record.provider,
      record.model ?? null,
      Math.max(0, Math.floor(record.inputTokens ?? 0)),
      Math.max(0, Math.floor(record.outputTokens ?? 0)),
      Math.max(0, Math.floor(record.cacheTokens ?? 0)),
      Math.max(0, Number(record.costUsd ?? 0)),
    );
  },

  summary(options: { from?: string; to?: string; projectPath?: string; provider?: string } = {}): UsageSummary[] {
    const clauses = ['1 = 1'];
    const params: unknown[] = [];
    if (options.from) { clauses.push('day >= ?'); params.push(options.from); }
    if (options.to) { clauses.push('day <= ?'); params.push(options.to); }
    if (options.projectPath) { clauses.push('project_path = ?'); params.push(options.projectPath); }
    if (options.provider) { clauses.push('provider = ?'); params.push(options.provider); }
    return getConnection().prepare(`
      SELECT day, provider, model, session_count AS sessionCount,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             cache_tokens AS cacheTokens, cost_usd AS costUsd
      FROM usage_daily WHERE ${clauses.join(' AND ')}
      ORDER BY day DESC, cost_usd DESC
    `).all(...params) as UsageSummary[];
  },
};
