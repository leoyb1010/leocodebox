import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalServerController } from './localServer.js';

test('LocalServerController accepts an explicit development auth token', () => {
  const previousToken = process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN;
  process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN = 'leocodebox-development-token';

  try {
    const controller = new LocalServerController({
      appRoot: process.cwd(),
      settingsPath: '/tmp/leocodebox-test-settings.json',
      appVersion: 'test',
    });
    assert.equal(controller.getLocalAuthToken(), 'leocodebox-development-token');
  } finally {
    if (previousToken === undefined) {
      delete process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN;
    } else {
      process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN = previousToken;
    }
  }
});
