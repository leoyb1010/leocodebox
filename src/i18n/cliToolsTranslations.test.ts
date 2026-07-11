import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const locales = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
const requiredKeys = [
  'title',
  'refresh',
  'versionCheck',
  'updateAvailable',
  'latest',
  'notRunnable',
  'notInstalled',
  'update',
  'install',
  'loadFailed',
  'actionFailed',
];

test('every supported locale includes CLI tool status translations', async () => {
  for (const locale of locales) {
    const file = path.resolve(`src/i18n/locales/${locale}/settings.json`);
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const key of requiredKeys) {
      assert.equal(
        typeof settings.agents?.cliTools?.[key],
        'string',
        `${locale} is missing settings.agents.cliTools.${key}`,
      );
    }
  }
});
