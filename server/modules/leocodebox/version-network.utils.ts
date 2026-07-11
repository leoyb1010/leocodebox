export function compareSemver(a: unknown, b: unknown): number {
  const left = String(a || '').replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || '').replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'leocodebox-local-update-check',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`) as Error & { statusCode?: number };
    error.statusCode = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}
