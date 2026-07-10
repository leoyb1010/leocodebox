import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';
import express from 'express';

test('provider switch preserves Codex top-level semantics and serializes concurrent saves', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-switch-test-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  process.env.LEOCODEBOX_LOCAL_ONLY = '1';

  const codexDir = path.join(home, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'old-key',
    tokens: { access_token: 'keep-token' },
  }));
  await fs.writeFile(path.join(codexDir, 'config.toml'), [
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '',
    '[features]',
    'web_search = true',
    '',
    '[profiles.leocodebox]',
    'model = "user-profile-model"',
    '',
  ].join('\n'));

  const { default: router } = await import('../leocodebox.js');
  const app = express();
  app.use(express.json());
  app.use('/api/leocodebox', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/leocodebox`;
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    return JSON.parse(responseText);
  };

  await post('/switch/providers', {
    id: 'official',
    target: 'codex',
    name: 'Official OAuth',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-5.5',
    wireApi: 'responses',
  });
  await post('/switch/providers/official/apply', {});

  const config = TOML.parse(await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8'));
  assert.equal(config.approval_policy, 'on-request');
  assert.equal(config.sandbox_mode, 'workspace-write');
  assert.deepEqual(config.features, { web_search: true });
  assert.equal(config.model, 'gpt-5.5');
  assert.equal(config.profiles.leocodebox.model, 'user-profile-model');

  const auth = JSON.parse(await fs.readFile(path.join(codexDir, 'auth.json'), 'utf8'));
  assert.equal(Object.hasOwn(auth, 'OPENAI_API_KEY'), false);
  assert.equal(auth.tokens.access_token, 'keep-token');

  await Promise.all(Array.from({ length: 20 }, (_, index) => post('/switch/providers', {
    id: `parallel-${index}`,
    target: 'claude',
    name: `Parallel ${index}`,
  })));
  const status = await fetch(`${base}/switch/status`).then((response) => response.json());
  assert.equal(status.providers.filter((provider) => provider.id.startsWith('parallel-')).length, 20);
});
