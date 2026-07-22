import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUpstreamHeaders, parseAnthropicUsage } from './gateway.service.js';
import { __resetGatewayMeter, gatewayMeterSnapshot, recordGatewayRequest } from './gateway-meter.js';

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
});
