import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderStore } from '../provider-store.service.js';

import { buildUpstreamHeaders, parseAnthropicUsage, parseGatewayToken, selectUpstreamChain } from './gateway.service.js';
import { __resetGatewayMeter, gatewayMeterSnapshot, recordGatewayRequest } from './gateway-meter.js';

function fakeStore(): ProviderStore {
  return {
    providers: [
      { id: 'n1', target: 'claude', name: 'Node-1', baseUrl: 'https://a.example', apiKey: 'k1' },
      { id: 'n2', target: 'claude', name: 'Node-2', baseUrl: 'https://b.example', apiKey: 'k2' },
      { id: 'c1', target: 'codex', name: 'Codex-1', baseUrl: 'https://c.example', apiKey: 'k3' },
    ] as ProviderStore['providers'],
    activeByTarget: { claude: 'n1' },
    routingSlots: { claude: { background: { providerId: 'n2' } } },
    healthMonitor: { enabled: true, intervalMinutes: 5, autoFailoverTargets: [] },
  };
}

test('parses usage from a streaming Anthropic SSE response', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1200,"cache_read_input_tokens":800}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":345}}',
    '',
  ].join('\n');
  const usage = parseAnthropicUsage(sse);
  assert.equal(usage.model, 'claude-sonnet-4-5');
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.cacheReadTokens, 800);
  assert.equal(usage.outputTokens, 345);
});

test('parses usage from a non-streaming JSON response', () => {
  const json = JSON.stringify({ model: 'claude-opus-4-8', usage: { input_tokens: 50, output_tokens: 700 } });
  const usage = parseAnthropicUsage(json);
  assert.equal(usage.model, 'claude-opus-4-8');
  assert.equal(usage.inputTokens, 50);
  assert.equal(usage.outputTokens, 700);
});

test('malformed body meters as zero without throwing', () => {
  const usage = parseAnthropicUsage('data: {not json\n\ngarbage');
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.model, null);
});

test('upstream headers drop the gateway token/host and inject the real key', () => {
  const headers = buildUpstreamHeaders(
    { host: '127.0.0.1:3001', 'x-api-key': 'lgw:node-1', authorization: 'Bearer lgw:node-1', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    'sk-real-upstream-key',
  );
  assert.equal(headers['x-api-key'], 'sk-real-upstream-key');
  assert.equal(headers['authorization'], 'Bearer sk-real-upstream-key');
  assert.equal(headers['host'], undefined);
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

test('parseGatewayToken reads x-api-key and Bearer, rejects non-gateway tokens', () => {
  assert.equal(parseGatewayToken({ 'x-api-key': 'lgw:claude' }), 'claude');
  assert.equal(parseGatewayToken({ authorization: 'Bearer lgw:claude:background' }), 'claude:background');
  assert.equal(parseGatewayToken({ 'x-api-key': 'sk-real-key' }), null);
  assert.equal(parseGatewayToken({}), null);
});

test('target token resolves active node first, then same-target siblings (failover chain)', () => {
  const chain = selectUpstreamChain(fakeStore(), 'claude');
  assert.deepEqual(chain.map((u) => u.providerId), ['n1', 'n2']); // active n1, then sibling n2
  assert.equal(chain[0].baseUrl, 'https://a.example');
  assert.equal(chain[0].apiKey, 'k1');
});

test('slot token resolves the bound node first, then siblings', () => {
  const chain = selectUpstreamChain(fakeStore(), 'claude:background');
  assert.deepEqual(chain.map((u) => u.providerId), ['n2', 'n1']); // background→n2 primary, n1 sibling
});

test('pinned providerId token yields exactly that node (no failover)', () => {
  const chain = selectUpstreamChain(fakeStore(), 'n2');
  assert.deepEqual(chain.map((u) => u.providerId), ['n2']);
});

test('unknown token yields an empty chain', () => {
  assert.deepEqual(selectUpstreamChain(fakeStore(), 'nope'), []);
});

test('meter aggregates today totals and keeps a recent ring', () => {
  __resetGatewayMeter();
  recordGatewayRequest({ provider: 'Leoapi-A', model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 200, cacheReadTokens: 10, status: 200 });
  recordGatewayRequest({ provider: 'Leoapi-A', model: 'claude-sonnet-4-5', inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, status: 200 });
  const snap = gatewayMeterSnapshot();
  assert.equal(snap.today.requests, 2);
  assert.equal(snap.today.inputTokens, 400);
  assert.equal(snap.today.outputTokens, 250);
  assert.equal(snap.recent.length, 2);
  assert.ok(snap.today.costUsd >= 0);
  // Single node, no failures → calm routing signal.
  assert.equal(snap.routing.activeNodes, 1);
  assert.equal(snap.routing.retries, 0);
});

test('routing signal counts distinct nodes and failover attempts', () => {
  __resetGatewayMeter();
  // A retryable upstream error on node A (metered with a 5xx), then the retry
  // lands on node B and succeeds — routing should read 2 nodes, 1 failover.
  recordGatewayRequest({ provider: 'Node-A', model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, status: 503 });
  recordGatewayRequest({ provider: 'Node-B', model: 'claude-sonnet-4-5', inputTokens: 120, outputTokens: 80, cacheReadTokens: 0, status: 200 });
  const snap = gatewayMeterSnapshot();
  assert.equal(snap.routing.activeNodes, 2);
  assert.equal(snap.routing.retries, 1);
  assert.equal(snap.routing.window, 2);
});
