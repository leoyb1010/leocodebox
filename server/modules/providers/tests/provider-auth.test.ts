import assert from 'node:assert/strict';
import test from 'node:test';

import type spawn from 'cross-spawn';

import { resolveCursorPermissionArgs } from '../../../cursor-cli.js';

import {
  ClaudeProviderAuth,
  parseClaudeCliAuthStatus,
} from '../list/claude/claude-auth.provider.js';
import {
  CodexProviderAuth,
  parseCodexCliAuthStatus,
} from '../list/codex/codex-auth.provider.js';
import {
  CursorProviderAuth,
  parseCursorLoginStatus,
} from '../list/cursor/cursor-auth.provider.js';

type SpawnSync = typeof spawn.sync;

test('parses Claude CLI logged-in and logged-out JSON', () => {
  assert.deepEqual(
    parseClaudeCliAuthStatus('{"loggedIn":true,"authMethod":"oauth","email":"dev@example.com"}'),
    { authenticated: true, email: 'dev@example.com', method: 'oauth' },
  );
  assert.deepEqual(
    parseClaudeCliAuthStatus('{"loggedIn":false,"authMethod":"none"}'),
    { authenticated: false, email: null, method: null },
  );
  assert.equal(parseClaudeCliAuthStatus('not json'), null);
});

test('parses Codex CLI status without treating not logged in as logged in', () => {
  assert.deepEqual(parseCodexCliAuthStatus('Logged in using ChatGPT'), {
    authenticated: true,
    method: 'cli_login',
  });
  assert.deepEqual(parseCodexCliAuthStatus('Not logged in'), {
    authenticated: false,
    method: null,
  });
  assert.equal(parseCodexCliAuthStatus('Unknown status'), null);
});

test('reports Claude as not installed when the version command cannot start', async () => {
  const fakeSpawn = (() => ({ error: new Error('ENOENT'), status: null })) as unknown as SpawnSync;
  const status = await new ClaudeProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
});

test('reports Codex as not installed when the version command exits non-zero', async () => {
  const fakeSpawn = (() => ({ error: undefined, status: 127 })) as unknown as SpawnSync;
  const status = await new CodexProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
});

test('parses Cursor status but requires a real capability probe', () => {
  assert.equal(parseCursorLoginStatus('Login successful!\nLogged in').authenticated, true);
  assert.equal(parseCursorLoginStatus('Authentication required').authenticated, false);
});

test('reports Cursor as not installed when its version command cannot start', async () => {
  const fakeSpawn = (() => ({ error: new Error('ENOENT'), status: null })) as unknown as SpawnSync;
  const status = await new CursorProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
});

test('rejects stale Cursor login state when listing models fails', async () => {
  const responses = [
    { error: undefined, status: 0, stdout: '2026.06', stderr: '' },
    { error: undefined, status: 0, stdout: 'Login successful!\nLogged in', stderr: '' },
    { error: undefined, status: 1, stdout: '', stderr: 'Authentication required' },
  ];
  const fakeSpawn = (() => responses.shift()) as unknown as SpawnSync;
  const status = await new CursorProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.match(status.error || '', /unusable/);
});

test('maps every advertised Cursor permission mode to a real CLI control', () => {
  assert.deepEqual(resolveCursorPermissionArgs('default'), []);
  assert.deepEqual(resolveCursorPermissionArgs('plan'), ['--plan']);
  assert.deepEqual(resolveCursorPermissionArgs('acceptEdits'), ['--auto-review']);
  assert.deepEqual(resolveCursorPermissionArgs('bypassPermissions'), ['-f']);
});
