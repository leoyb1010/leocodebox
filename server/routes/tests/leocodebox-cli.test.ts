import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearCliLatestVersionCache,
  detectCliInstallSource,
  readCliLatestVersion,
  resolveCliUpdateCommand,
  withCliMutation,
} from '../../modules/leocodebox/cli-tools.routes.js';

const opencode = {
  id: 'opencode',
  cmd: 'opencode',
  npmPackage: 'opencode-ai',
  updateArgs: null,
};

test('CLI install source detection uses strict known path segments', async () => {
  assert.equal((await detectCliInstallSource(opencode, async () => '/opt/homebrew/Cellar/opencode/1/bin/opencode')).source, 'homebrew');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.npm-global/lib/node_modules/opencode-ai/bin/opencode')).source, 'npm-global');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.volta/bin/opencode')).source, 'volta');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/bin/npm/opencode')).source, 'unknown');
  assert.equal((await detectCliInstallSource(opencode, async () => null)).source, 'unknown');
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
