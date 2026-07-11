export function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] || 0) - (pb[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'leocodebox-local-update-check',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}
