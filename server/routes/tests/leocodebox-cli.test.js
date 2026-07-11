import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectCliInstallSource,
  resolveCliUpdateCommand,
  withCliMutation,
} from '../leocodebox.js';

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
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = withCliMutation('opencode', async () => blocker);
  await assert.rejects(
    withCliMutation('opencode', async () => undefined),
    (error) => error instanceof Error && error.statusCode === 409,
  );
  const otherTool = withCliMutation('codex', async () => 'ok');
  assert.equal(await otherTool, 'ok');
  release('done');
  assert.equal(await first, 'done');
});
