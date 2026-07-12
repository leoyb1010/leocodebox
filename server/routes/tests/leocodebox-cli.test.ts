import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  CLI_TOOLS,
  clearCliLatestVersionCache,
  detectCliInstallSource,
  readCliLatestVersion,
  resolveCliUpdateCommand,
  withCliMutation,
  default as cliToolsRoutes,
} from '../../modules/leocodebox/cli-tools.routes.js';
import { compareSemver } from '../../modules/leocodebox/version-network.utils.js';

const opencode = {
  id: 'opencode',
  cmd: 'opencode',
  npmPackage: 'opencode-ai',
  updateArgs: null,
};

test('CLI install source detection uses strict known path segments', async () => {
  assert.equal((await detectCliInstallSource(opencode, async () => '/opt/homebrew/Cellar/opencode/1/bin/opencode')).source, 'homebrew');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.npm-global/lib/node_modules/opencode-ai/bin/opencode')).source, 'npm-global');
  assert.equal((await detectCliInstallSource(opencode, async () => '/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode')).source, 'npm-global');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.local/share/cursor-agent/versions/1/cursor-agent')).source, 'standalone');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.opencode/bin/opencode')).source, 'standalone');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.bun/bin/opencode')).source, 'bun');
  assert.equal((await detectCliInstallSource(CLI_TOOLS.grok, async () => '/Users/test/.grok/downloads/grok-0.2.93-macos-aarch64')).source, 'standalone');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.volta/bin/opencode')).source, 'volta');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/bin/npm/opencode')).source, 'unknown');
  assert.equal((await detectCliInstallSource(opencode, async () => null)).source, 'unknown');
});

test('all supported standalone agents expose their verified updater', async () => {
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.cursor, 'standalone'), { command: 'cursor-agent', args: ['update'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.opencode, 'standalone'), { command: 'opencode', args: ['upgrade'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.hermes, 'standalone'), { command: 'hermes', args: ['update'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.grok, 'standalone'), { command: 'grok', args: ['update'] });
});

test('Homebrew and Bun update commands preserve the detected installer', async () => {
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.claude, 'homebrew'), { command: 'brew', args: ['upgrade', '--cask', 'claude-code'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.gemini, 'homebrew'), { command: 'brew', args: ['upgrade', 'gemini-cli'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.codex, 'bun'), { command: 'bun', args: ['add', '--global', '@openai/codex@latest'] });
});

test('semantic version comparison handles prerelease precedence', () => {
  assert.equal(compareSemver('1.39.0', '1.39.0-beta.2'), 1);
  assert.equal(compareSemver('1.39.0-beta.10', '1.39.0-beta.2'), 8);
  assert.equal(compareSemver('v1.39.0', '1.38.9'), 1);
});

test('unknown CLI sources cannot trigger a shadow global update', async () => {
  assert.equal(await resolveCliUpdateCommand(opencode, 'unknown'), null);
  assert.deepEqual(await resolveCliUpdateCommand(opencode, 'npm-global'), {
    command: 'npm',
    args: ['install', '--global', 'opencode-ai@latest'],
  });
});

test('CLI mutations reject concurrent operations for the same tool', async () => {
  let release: ((value: string) => void) | undefined;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = withCliMutation('opencode', async () => blocker);
  await assert.rejects(
    withCliMutation('opencode', async () => undefined),
    (error) => error instanceof Error && 'statusCode' in error && error.statusCode === 409,
  );
  const otherTool = withCliMutation('codex', async () => 'ok');
  assert.equal(await otherTool, 'ok');
  release?.('done');
  assert.equal(await first, 'done');
});


test('CLI registry versions are cached for a day and can be force-refreshed', async () => {
  clearCliLatestVersionCache();
  let loads = 0;
  const loadLatest = async () => {
    loads += 1;
    return loads === 1 ? '1.2.3' : '1.2.4';
  };

  const fresh = await readCliLatestVersion(opencode, { now: 1000, loadLatest });
  const cached = await readCliLatestVersion(opencode, { now: 2000, loadLatest });
  const refreshed = await readCliLatestVersion(opencode, { force: true, now: 3000, loadLatest });

  assert.deepEqual(fresh, {
    version: '1.2.3',
    checkedAt: new Date(1000).toISOString(),
    source: 'registry',
  });
  assert.equal(cached.version, '1.2.3');
  assert.equal(cached.source, 'cache');
  assert.equal(refreshed.version, '1.2.4');
  assert.equal(refreshed.source, 'registry');
  assert.equal(loads, 2);
  clearCliLatestVersionCache();
});

test('CLI mutation routes enforce local mode and reject unsafe or unsupported ids', async (t) => {
  const previous = { local: process.env.LEOCODEBOX_LOCAL_ONLY, nodeEnv: process.env.NODE_ENV, home: process.env.LEOCODEBOX_TEST_HOME };
  delete process.env.LEOCODEBOX_LOCAL_ONLY;
  delete process.env.LEOCODEBOX_TEST_HOME;
  process.env.NODE_ENV = 'production';
  const app = express();
  app.use('/cli', cliToolsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    Object.assign(process.env, { LEOCODEBOX_LOCAL_ONLY: previous.local, NODE_ENV: previous.nodeEnv, LEOCODEBOX_TEST_HOME: previous.home });
    for (const key of Object.keys(previous) as Array<keyof typeof previous>) if (previous[key] === undefined) {
      const envKey = { local: 'LEOCODEBOX_LOCAL_ONLY', nodeEnv: 'NODE_ENV', home: 'LEOCODEBOX_TEST_HOME' }[key];
      delete process.env[envKey];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cli`;
  assert.equal((await fetch(`${base}/codex/update`, { method: 'POST' })).status, 403);

  process.env.LEOCODEBOX_LOCAL_ONLY = '1';
  assert.equal((await fetch(`${base}/__proto__/update`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/cursor/install`, { method: 'POST' })).status, 409);
});
