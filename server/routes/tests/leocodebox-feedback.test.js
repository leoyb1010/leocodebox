import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import feedbackUpdateRoutes from '../../modules/leocodebox/feedback-update.routes.js';

test('Leoapi feedback routes validate and persist local reports', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-feedback-test-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  const app = express();
  app.use(express.json());
  app.use('/api/leocodebox', feedbackUpdateRoutes);
  app.use((error, _req, res, _next) => res.status(500).json({ success: false, error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    delete process.env.LEOCODEBOX_TEST_HOME;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/leocodebox`;

  const invalid = await fetch(`${base}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Missing description' }),
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${base}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Local issue', description: 'Steps to reproduce', severity: 'high' }),
  }).then((response) => response.json());
  assert.equal(created.success, true);
  assert.ok(created.filePath.startsWith(path.join(home, '.leocodebox', 'feedback')));

  const listed = await fetch(`${base}/feedback`).then((response) => response.json());
  assert.equal(listed.success, true);
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].title, 'Local issue');
  assert.equal(listed.reports[0].severity, 'high');
});
