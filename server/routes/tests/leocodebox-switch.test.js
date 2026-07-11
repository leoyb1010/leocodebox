import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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

  let activeStatus = await fetch(`${base}/switch/status`).then((response) => response.json());
  assert.equal(activeStatus.activeByTarget.codex, 'official');

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
  assert.equal(status.presets.length, 16);
  assert.deepEqual(
    status.presets.find((preset) => preset.id === 'xai'),
    {
      id: 'xai',
      name: 'xAI / Grok',
      vendor: 'xAI',
      target: 'codex',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: '',
      wireApi: 'chat',
      status: 'beta',
      docsUrl: 'https://console.x.ai/',
    },
  );

  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    theme: 'dark',
    env: { KEEP_ME: 'yes' },
  }));
  await post('/switch/providers', {
    id: 'claude-proxy',
    target: 'claude',
    name: 'Claude Proxy',
    baseUrl: 'https://claude.example.test',
    apiKey: 'claude-key',
    model: 'claude-sonnet-test',
    modelMapping: {
      sonnet: 'claude-sonnet-test',
      opus: 'claude-opus-test',
      haiku: 'claude-haiku-test',
    },
  });
  await post('/switch/providers/claude-proxy/apply', {});
  activeStatus = await fetch(`${base}/switch/status`).then((response) => response.json());
  assert.equal(activeStatus.activeByTarget.claude, 'claude-proxy');
  const claudeSettings = JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.theme, 'dark');
  assert.equal(claudeSettings.env.KEEP_ME, 'yes');
  assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, 'https://claude.example.test');
  assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, 'claude-key');
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-test');
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-test');
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-test');

  await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  await fs.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    plugin: ['keep-plugin'],
  }));
  await post('/switch/providers', {
    id: 'opencode-proxy',
    target: 'opencode',
    name: 'OpenCode Proxy',
    baseUrl: 'https://open.example.test/v1',
    apiKey: 'open-key',
    model: 'open-model',
  });
  await post('/switch/providers/opencode-proxy/apply', {});
  activeStatus = await fetch(`${base}/switch/status`).then((response) => response.json());
  assert.equal(activeStatus.activeByTarget.opencode, 'opencode-proxy');
  const opencodeConfig = JSON.parse(await fs.readFile(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(opencodeConfig.plugin, ['keep-plugin']);
  assert.equal(opencodeConfig.model, 'leocodebox_opencode-proxy/open-model');
  assert.equal(opencodeConfig.provider['leocodebox_opencode-proxy'].options.apiKey, 'open-key');

  assert.equal(activeStatus.nativeAvailableByTarget.opencode, true);
  await post('/switch/targets/opencode/restore-default', {});
  const restoredOpenCodeConfig = JSON.parse(await fs.readFile(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(restoredOpenCodeConfig, { plugin: ['keep-plugin'] });
  activeStatus = await fetch(`${base}/switch/status`).then((response) => response.json());
  assert.equal(activeStatus.activeByTarget.opencode, undefined);

  await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
  const originalGeminiEnv = [
    '# Preserve this comment',
    'export OTHER_TOKEN="hello world"',
    'lower_case=value',
    'KEEP_ME=yes # inline comment',
    '',
  ].join('\n');
  await fs.writeFile(path.join(home, '.gemini', '.env'), originalGeminiEnv);
  await post('/switch/providers', {
    id: 'gemini-proxy',
    target: 'gemini',
    name: 'Gemini Proxy',
    baseUrl: 'https://gemini.example.test',
    apiKey: 'gemini-key',
    model: 'gemini-test',
  });
  await post('/switch/providers/gemini-proxy/apply', {});
  const geminiEnv = await fs.readFile(path.join(home, '.gemini', '.env'), 'utf8');
  assert.match(geminiEnv, /^# Preserve this comment$/m);
  assert.match(geminiEnv, /^export OTHER_TOKEN="hello world"$/m);
  assert.match(geminiEnv, /^lower_case=value$/m);
  assert.match(geminiEnv, /^KEEP_ME=yes # inline comment$/m);
  assert.match(geminiEnv, /^GEMINI_API_KEY=gemini-key$/m);
  assert.match(geminiEnv, /^GEMINI_MODEL=gemini-test$/m);

  await post('/switch/providers', {
    id: 'gemini-clean',
    target: 'gemini',
    name: 'Gemini without overrides',
    baseUrl: '',
    apiKey: '',
    model: '',
  });
  await post('/switch/providers/gemini-clean/apply', {});
  const cleanedGeminiEnv = await fs.readFile(path.join(home, '.gemini', '.env'), 'utf8');
  assert.match(cleanedGeminiEnv, /^# Preserve this comment$/m);
  assert.match(cleanedGeminiEnv, /^export OTHER_TOKEN="hello world"$/m);
  assert.match(cleanedGeminiEnv, /^lower_case=value$/m);
  assert.match(cleanedGeminiEnv, /^KEEP_ME=yes # inline comment$/m);
  assert.doesNotMatch(
    cleanedGeminiEnv,
    /^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GEMINI_BASE_URL|GEMINI_MODEL)=/m,
  );

  process.env.CLAUDE_CONFIG_DIR = '~/custom-claude';
  process.env.CODEX_HOME = '~/custom-codex';
  process.env.XDG_CONFIG_HOME = '~/custom-xdg';
  t.after(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  await post('/switch/providers', {
    id: 'custom-path-claude',
    target: 'claude',
    name: 'Custom-path Claude',
    apiKey: 'custom-key',
  });
  await post('/switch/providers/custom-path-claude/apply', {});
  const customClaudeSettings = JSON.parse(
    await fs.readFile(path.join(home, 'custom-claude', 'settings.json'), 'utf8'),
  );
  assert.equal(customClaudeSettings.env.ANTHROPIC_API_KEY, 'custom-key');
  const customPathStatus = await fetch(`${base}/switch/status`).then((response) => response.json());
  assert.equal(customPathStatus.targets.claude.files[0].path, '~/custom-claude/settings.json');
  assert.equal(customPathStatus.targets.codex.files[0].path, '~/custom-codex/auth.json');
  assert.equal(customPathStatus.targets.opencode.files[0].path, '~/custom-xdg/opencode/opencode.json');

  const externalCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-external-codex-'));
  t.after(() => fs.rm(externalCodexHome, { recursive: true, force: true }));
  process.env.CODEX_HOME = externalCodexHome;
  const externalAuthPath = path.join(externalCodexHome, 'auth.json');
  const externalConfigPath = path.join(externalCodexHome, 'config.toml');
  await fs.writeFile(externalAuthPath, JSON.stringify({ OPENAI_API_KEY: 'before-restore' }));
  await fs.writeFile(externalConfigPath, 'approval_policy = "on-request"\n');
  await post('/switch/providers', {
    id: 'external-codex',
    target: 'codex',
    name: 'External Codex',
    apiKey: 'after-apply',
    model: 'external-model',
  });
  await post('/switch/providers/external-codex/apply', {});
  const externalBackups = await fetch(`${base}/switch/backups`).then((response) => response.json());
  const externalAuthBackup = externalBackups.backups.find((entry) => entry.targetPath === externalAuthPath);
  assert.ok(externalAuthBackup, 'external CODEX_HOME backup should retain its absolute destination');
  await fs.writeFile(externalAuthPath, JSON.stringify({ OPENAI_API_KEY: 'modified-after-apply' }));
  await post('/switch/backups/restore', { relativePath: externalAuthBackup.relativePath });
  assert.equal(JSON.parse(await fs.readFile(externalAuthPath, 'utf8')).OPENAI_API_KEY, 'before-restore');

  await fs.mkdir(path.join(home, '.hermes'), { recursive: true });
  await fs.writeFile(path.join(home, '.hermes', 'config.yaml'), 'telemetry: false\n');
  await post('/switch/providers', {
    id: 'hermes-proxy',
    target: 'hermes',
    name: 'Hermes Proxy',
    baseUrl: 'https://hermes.example.test/v1',
    apiKey: 'hermes-key',
    model: 'hermes-test',
  });
  await post('/switch/providers/hermes-proxy/apply', {});
  const hermesConfig = await fs.readFile(path.join(home, '.hermes', 'config.yaml'), 'utf8');
  assert.match(hermesConfig, /^telemetry: false$/m);
  assert.match(hermesConfig, /# BEGIN LEOCODEBOX SWITCH/);
  assert.match(hermesConfig, /api_key: "hermes-key"/);

  const backups = await fetch(`${base}/switch/backups`).then((response) => response.json());
  assert.ok(backups.backups.some((entry) => entry.relativePath.endsWith('.claude/settings.json')));

  if (process.platform !== 'win32') {
    const switchMode = (await fs.stat(path.join(home, '.leocodebox', 'switch'))).mode & 0o777;
    const storeMode = (await fs.stat(path.join(home, '.leocodebox', 'switch', 'providers.json'))).mode & 0o777;
    assert.equal(switchMode, 0o700);
    assert.equal(storeMode, 0o600);

    for (const backup of backups.backups) {
      const backupMode = (await fs.stat(path.join(home, '.leocodebox', 'switch', 'backups', backup.relativePath))).mode & 0o777;
      assert.equal(backupMode, 0o600);
    }
  }

  const traversalResponse = await fetch(`${base}/switch/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath: '../outside' }),
  });
  assert.equal(traversalResponse.status, 400);

  const receivedProbes = [];
  const probeServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      receivedProbes.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(request.url === '/v1/messages' ? 400 : 200, { 'Content-Type': 'application/json' });
      response.end(request.url === '/v1/models'
        ? JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] })
        : '{}');
    });
  });
  probeServer.listen(0, '127.0.0.1');
  await new Promise((resolve) => probeServer.once('listening', resolve));
  t.after(() => new Promise((resolve) => probeServer.close(resolve)));
  const probeAddress = probeServer.address();
  const probeBaseUrl = `http://127.0.0.1:${probeAddress.port}`;

  await post('/switch/providers', {
    id: 'claude-probe',
    target: 'claude',
    name: 'Claude Probe',
    baseUrl: probeBaseUrl,
    apiKey: 'probe-key',
    model: 'probe-model',
  });
  const claudeProbe = await post('/switch/providers/claude-probe/test', {});
  assert.equal(claudeProbe.reachable, true);
  assert.equal(claudeProbe.httpStatus, 400);
  assert.equal(claudeProbe.authStatus, 'accepted');
  assert.equal(receivedProbes[0].method, 'POST');
  assert.equal(receivedProbes[0].url, '/v1/messages');
  assert.equal(receivedProbes[0].headers['x-api-key'], 'probe-key');
  assert.equal(JSON.parse(receivedProbes[0].body).max_tokens, 1);

  await post('/switch/providers', {
    id: 'codex-probe',
    target: 'codex',
    name: 'Codex Probe',
    baseUrl: `${probeBaseUrl}/v1`,
    apiKey: 'codex-key',
  });
  const codexProbe = await post('/switch/providers/codex-probe/test', {});
  assert.equal(codexProbe.reachable, true);
  assert.equal(codexProbe.httpStatus, 200);
  assert.equal(codexProbe.authStatus, 'accepted');
  assert.equal(receivedProbes[1].method, 'GET');
  assert.equal(receivedProbes[1].url, '/v1/models');
  assert.equal(receivedProbes[1].headers.authorization, 'Bearer codex-key');

  const discoveredModels = await post('/switch/providers/codex-probe/models', { timeoutMs: 4000 });
  assert.deepEqual(discoveredModels.models, ['model-a', 'model-b']);
  assert.equal(discoveredModels.httpStatus, 200);

  const benchmark = await post('/switch/providers/codex-probe/benchmark', {
    model: 'model-a',
    attempts: 2,
    timeoutMs: 4000,
  });
  assert.equal(benchmark.successCount, 2);
  assert.equal(benchmark.results.length, 2);
  assert.ok(benchmark.averageLatencyMs >= 0);

  await post('/switch/providers', {
    id: 'codex-probe',
    endpoints: [`${probeBaseUrl}/v1`],
    autoSelectEndpoint: true,
    apiKey: '__KEEP__',
  });
  const endpointTest = await post('/switch/providers/codex-probe/endpoints/test', {
    timeoutMs: 4000,
    autoSelectEndpoint: true,
  });
  assert.equal(endpointTest.results.length, 1);
  assert.equal(endpointTest.results[0].usable, true);
  assert.equal(endpointTest.selectedBaseUrl, `${probeBaseUrl}/v1`);

  await fs.writeFile(externalAuthPath, JSON.stringify({ OPENAI_API_KEY: 'active-codex-key' }));
  await fs.writeFile(externalConfigPath, [
    'model = "active-codex-model"',
    'model_provider = "second"',
    '',
    '[model_providers.first]',
    'base_url = "https://wrong-codex.example/v1"',
    'wire_api = "responses"',
    '',
    '[model_providers.second]',
    'base_url = "https://active-codex.example/v1"',
    'wire_api = "chat"',
    '',
  ].join('\n'));
  const customOpenCodePath = path.join(home, 'custom-xdg', 'opencode', 'opencode.json');
  await fs.mkdir(path.dirname(customOpenCodePath), { recursive: true });
  await fs.writeFile(customOpenCodePath, JSON.stringify({
    model: 'second/active-opencode-model',
    provider: {
      first: { options: { baseURL: 'https://wrong-opencode.example/v1', apiKey: 'wrong-key' } },
      second: { options: { baseURL: 'https://active-opencode.example/v1', apiKey: 'active-key' } },
    },
  }));
  const importedCurrent = await post('/switch/import-current', {});
  assert.ok(importedCurrent.imported.some((provider) => provider.id === 'codex-current'));
  assert.ok(importedCurrent.imported.some((provider) => provider.id === 'opencode-current'));
  const importedStatus = await fetch(`${base}/switch/status`).then((response) => response.json());
  const importedCodex = importedStatus.providers.find((provider) => provider.id === 'codex-current');
  assert.equal(importedCodex.baseUrl, 'https://active-codex.example/v1');
  assert.equal(importedCodex.model, 'active-codex-model');
  assert.equal(importedCodex.wireApi, 'chat');
  const importedOpenCode = importedStatus.providers.find((provider) => provider.id === 'opencode-current');
  assert.equal(importedOpenCode.baseUrl, 'https://active-opencode.example/v1');
  assert.match(importedOpenCode.apiKey, /^acti.*-key$/);
  assert.equal(importedOpenCode.model, 'active-opencode-model');
});
