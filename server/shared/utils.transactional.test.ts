import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeConfigTransactional, writeJsonConfig } from './utils.js';

const scratch = () => mkdtemp(path.join(os.tmpdir(), 'leocodebox-txn-'));

test('writes a new config file and reads back byte-exact', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'config.json');
  await writeConfigTransactional(file, '{"a":1}\n');
  assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
  await rm(dir, { recursive: true, force: true });
});

test('overwrites an existing config file', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'config.json');
  await writeFile(file, 'OLD', 'utf8');
  await writeConfigTransactional(file, 'NEW');
  assert.equal(await readFile(file, 'utf8'), 'NEW');
  await rm(dir, { recursive: true, force: true });
});

test('rolls back to the original content when verification fails', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'config.json');
  await writeFile(file, 'ORIGINAL', 'utf8');
  await assert.rejects(
    () => writeConfigTransactional(file, 'BROKEN', () => false),
    /verification failed/i,
  );
  // The bad write must not survive — the original config is intact.
  assert.equal(await readFile(file, 'utf8'), 'ORIGINAL');
  await rm(dir, { recursive: true, force: true });
});

test('rolls back to absent when a brand-new write fails verification', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'config.json');
  await assert.rejects(() => writeConfigTransactional(file, 'BROKEN', () => false));
  // No pre-existing file to restore → the partial write is removed entirely.
  assert.equal(existsSync(file), false);
  await rm(dir, { recursive: true, force: true });
});

test('writeJsonConfig serializes with two-space indent and trailing newline', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'config.json');
  await writeJsonConfig(file, { mcpServers: { demo: { type: 'stdio', command: 'x' } } });
  const raw = await readFile(file, 'utf8');
  assert.equal(raw, `${JSON.stringify({ mcpServers: { demo: { type: 'stdio', command: 'x' } } }, null, 2)}\n`);
  assert.deepEqual(JSON.parse(raw), { mcpServers: { demo: { type: 'stdio', command: 'x' } } });
  await rm(dir, { recursive: true, force: true });
});
