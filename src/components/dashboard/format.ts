/**
 * Dashboard display formatting — Chinese units and CNY throughout.
 *
 * The backend stores cost in USD (usage_daily.cost_usd, claude-quota costUsd).
 * Everything the dashboard shows is converted to 人民币 at a fixed reference
 * rate; tokens and counts use 万 / 亿 instead of K / M.
 */

/** USD → CNY reference rate. Display-only; not a live forex feed. */
export const USD_TO_CNY = 7.2;

/** 1234567 → "123.5万" · 123456789 → "1.2亿" · 860 → "860" */
export function formatTokensCn(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${trimTrailingZero(n / 100_000_000)}亿`;
  if (abs >= 10_000) return `${trimTrailingZero(n / 10_000)}万`;
  return String(Math.round(n));
}

/** Compact variant for tight spaces (chart axes, dense rows). */
export function formatTokensCnShort(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${trimTrailingZero(n / 100_000_000)}亿`;
  if (abs >= 10_000) return `${trimTrailingZero(n / 10_000)}万`;
  return String(Math.round(n));
}

function trimTrailingZero(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** USD amount → CNY display, e.g. usdCny(4.37) → "¥31.5". */
export function usdToCny(usd: number): number {
  return usd * USD_TO_CNY;
}

/** Format a USD amount as 人民币: "¥31.5" (or "¥3,140.00" for large). */
export function formatCny(usd: number, { decimals }: { decimals?: number } = {}): string {
  const cny = usdToCny(usd);
  const d = decimals ?? (cny >= 100 ? 0 : cny >= 10 ? 1 : 2);
  return `¥${cny.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** Plain count with Chinese grouping: 12345 → "1.2万", small → locale string. */
export function formatCountCn(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 10_000) return formatTokensCn(n);
  return n.toLocaleString('zh-CN');
}
