import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, apiRequest } from './api';

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  });
  return values;
}

test('apiRequest returns parsed JSON and persists refreshed authentication tokens', async () => {
  const values = installLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-refreshed-token': 'new-token',
    },
  });

  try {
    assert.deepEqual(await apiRequest('/api/test'), { success: true });
    assert.equal(values.get('auth-token'), 'new-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apiRequest converts server error payloads into structured ApiError instances', async () => {
  installLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Repository not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

  try {
    await assert.rejects(
      () => apiRequest('/api/git/status'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, 'Repository not found');
        assert.equal(error.status, 404);
        assert.deepEqual(error.payload, { error: 'Repository not found' });
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
