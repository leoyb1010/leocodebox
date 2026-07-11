import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../types/app';

import {
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  removeSessionFromProject,
  upsertSessionIntoProject,
  type SessionUpsertedEvent,
} from './projectStateUtils';

const project = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'Project 1',
  isStarred: false,
  sessions: [],
  sessionMeta: { total: 0, hasMore: false },
  providerCounts: {},
  ...overrides,
});

test('upserting a new session prepends it and updates total/provider counts', () => {
  const next = upsertSessionIntoProject(project(), {
    kind: 'session_upserted',
    sessionId: 'app-session-1',
    providerSessionId: 'provider-session-1',
    provider: 'codex',
    session: { id: 'provider-session-1', summary: 'Hello' },
    project: null,
  } as SessionUpsertedEvent);

  assert.equal(next.sessions?.[0]?.id, 'app-session-1');
  assert.equal(next.sessions?.[0]?.__provider, 'codex');
  assert.equal(next.sessionMeta?.total, 1);
  assert.deepEqual(next.providerCounts, { codex: 1 });
});

test('upserting by a provider alias preserves a non-empty existing title', () => {
  const original = project({
    sessions: [{ id: 'provider-session-1', summary: 'Existing title', __provider: 'claude' }],
    sessionMeta: { total: 1, hasMore: false },
  });
  const next = upsertSessionIntoProject(original, {
    kind: 'session_upserted',
    sessionId: 'app-session-1',
    providerSessionId: 'provider-session-1',
    provider: 'claude',
    session: { id: 'app-session-1', summary: '' },
    project: null,
  } as SessionUpsertedEvent);

  assert.equal(next.sessions?.length, 1);
  assert.equal(next.sessions?.[0]?.id, 'app-session-1');
  assert.equal(next.sessions?.[0]?.summary, 'Existing title');
  assert.equal(next.sessionMeta?.total, 1);
});

test('expanded project pages survive refresh and additional pages deduplicate sessions', () => {
  const previous = project({
    sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    sessionMeta: { total: 4, hasMore: true },
  });
  const refreshed = project({
    sessions: [{ id: 's1' }],
    sessionMeta: { total: 4, hasMore: true },
  });

  const [merged] = mergeExpandedSessionPages([previous], [refreshed]);
  assert.deepEqual(merged.sessions?.map((session) => session.id), ['s1', 's2', 's3']);

  const paged = mergeProjectSessionPage(merged, {
    sessions: [{ id: 's3' }, { id: 's4' }],
    sessionMeta: { total: 4, hasMore: false },
  });
  assert.deepEqual(paged.sessions?.map((session) => session.id), ['s1', 's2', 's3', 's4']);
  assert.equal(paged.sessionMeta?.hasMore, false);
});

test('removing a session updates pagination metadata without changing misses', () => {
  const original = project({
    sessions: [{ id: 's1' }, { id: 's2' }],
    sessionMeta: { total: 3, hasMore: true },
  });
  assert.equal(removeSessionFromProject(original, 'missing'), original);

  const next = removeSessionFromProject(original, 's1');
  assert.deepEqual(next.sessions?.map((session) => session.id), ['s2']);
  assert.deepEqual(next.sessionMeta, { total: 2, hasMore: true });
});
