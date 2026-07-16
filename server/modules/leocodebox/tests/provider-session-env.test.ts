import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyActiveSwitchEnv, getActiveSwitchEnvOverlay } from '../provider-session-env.service.js';

type ProviderSeed = {
  id: string;
  target: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

async function withStore(
  providers: ProviderSeed[],
  activeByTarget: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const prev = process.env.LEOCODEBOX_TEST_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'leoapi-env-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  const switchDir = path.join(home, '.leocodebox', 'switch');
  await fs.mkdir(switchDir, { recursive: true });
  await fs.writeFile(
    path.join(switchDir, 'providers.json'),
    JSON.stringify({ providers, activeByTarget, healthMonitor: { enabled: false, intervalMinutes: 5, autoFailoverTargets: [] } }),
  );
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.LEOCODEBOX_TEST_HOME;
    else process.env.LEOCODEBOX_TEST_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
}

// The regression this guards: cc-switch (or a manual rc export) leaves a stale
// ANTHROPIC_BASE_URL in the login shell → the app imports it into the child env
// → for a key the active provider doesn't set, it leaked through and locked
// Claude to the old endpoint. applyActiveSwitchEnv must CLEAR it.
test('applyActiveSwitchEnv clears a stale inherited ANTHROPIC_BASE_URL the active provider does not set', async () => {
  await withStore(
    [{ id: 'p1', target: 'claude', baseUrl: '', apiKey: 'new-key' }],
    { claude: 'p1' },
    async () => {
      const childEnv: Record<string, string | undefined> = {
        PATH: '/usr/bin',
        ANTHROPIC_BASE_URL: 'https://old.cc-switch.example', // stale, inherited from shell
        ANTHROPIC_API_KEY: 'old-key',
        ANTHROPIC_AUTH_TOKEN: 'old-key',
      };
      const result = await applyActiveSwitchEnv(childEnv, 'claude');
      // provider has no baseUrl → the stale one must be GONE (falls back to official), not the old export
      assert.equal(result.ANTHROPIC_BASE_URL, undefined);
      // provider's key fully replaces the old
      assert.equal(result.ANTHROPIC_API_KEY, 'new-key');
      assert.equal(result.ANTHROPIC_AUTH_TOKEN, 'new-key');
      // unrelated env untouched
      assert.equal(result.PATH, '/usr/bin');
    },
  );
});

test('applyActiveSwitchEnv makes a fully-configured active provider fully authoritative', async () => {
  await withStore(
    [{ id: 'p1', target: 'claude', baseUrl: 'https://new.leoapi.example', apiKey: 'new-key' }],
    { claude: 'p1' },
    async () => {
      const childEnv: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'https://old.example', ANTHROPIC_API_KEY: 'old' };
      const result = await applyActiveSwitchEnv(childEnv, 'claude');
      assert.equal(result.ANTHROPIC_BASE_URL, 'https://new.leoapi.example');
      assert.equal(result.ANTHROPIC_API_KEY, 'new-key');
      assert.equal(result.ANTHROPIC_AUTH_TOKEN, 'new-key');
    },
  );
});

test('applyActiveSwitchEnv leaves the child env untouched when NO provider is active (本机原配置)', async () => {
  await withStore([{ id: 'p1', target: 'claude', baseUrl: 'x', apiKey: 'y' }], {}, async () => {
    const childEnv = { ANTHROPIC_BASE_URL: 'https://machine-own.example', ANTHROPIC_API_KEY: 'own-key' };
    const result = await applyActiveSwitchEnv(childEnv, 'claude');
    assert.deepEqual(result, childEnv); // stale/own values preserved — machine config stays in charge
  });
});

test('applyActiveSwitchEnv clears a stale inherited OPENAI_API_KEY for codex', async () => {
  await withStore([{ id: 'c1', target: 'codex', apiKey: 'new-openai' }], { codex: 'c1' }, async () => {
    const result = await applyActiveSwitchEnv({ OPENAI_API_KEY: 'old-openai', PATH: '/bin' }, 'codex');
    assert.equal(result.OPENAI_API_KEY, 'new-openai');
    assert.equal(result.PATH, '/bin');
  });
});

test('getActiveSwitchEnvOverlay returns empty overlay when the active id points nowhere', async () => {
  await withStore([{ id: 'p1', target: 'claude', baseUrl: 'x', apiKey: 'y' }], { claude: 'missing' }, async () => {
    assert.deepEqual(await getActiveSwitchEnvOverlay('claude'), {});
  });
});
