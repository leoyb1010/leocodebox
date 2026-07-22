import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createAnthropicCallModel, parseModelResponse } from './kernel-client.js';
import { createReadOnlyTools } from './kernel-tools.js';
import { runKernelTask, type CallModel, type ModelTurn } from './kernel.js';

test('kernel runs a tool then finishes on end_turn, feeding the result back', async () => {
  const seen: unknown[][] = [];
  const callModel: CallModel = async (messages) => {
    seen.push(messages.map((m) => m.role) as unknown[]);
    if (messages.length === 1) {
      return { blocks: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }], stopReason: 'tool_use' };
    }
    return { blocks: [{ type: 'text', text: 'the file says hello' }], stopReason: 'end_turn' };
  };
  const run = await runKernelTask({
    prompt: 'what is in a.txt?',
    tools: [],
    callModel,
    executeTool: async (name, input) => ({ content: `contents of ${input.path}` }),
  });
  assert.equal(run.aborted, false);
  assert.equal(run.steps, 2);
  assert.equal(run.finalText, 'the file says hello');
  const kinds = run.events.map((e) => e.type);
  assert.deepEqual(kinds, ['tool_call', 'tool_result', 'assistant_text', 'done']);
  // On the 2nd model call the history is [user, assistant(tool_use), user(tool_result)].
  assert.deepEqual(seen[1], ['user', 'assistant', 'user']);
});

test('a throwing tool becomes an isError result, and the loop keeps going', async () => {
  let calls = 0;
  const callModel: CallModel = async () => {
    calls += 1;
    if (calls === 1) return { blocks: [{ type: 'tool_use', id: 'x', name: 'boom', input: {} }], stopReason: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' };
  };
  const run = await runKernelTask({
    prompt: 'go',
    tools: [],
    callModel,
    executeTool: async () => { throw new Error('kaboom'); },
  });
  const toolResult = run.events.find((e) => e.type === 'tool_result');
  assert.ok(toolResult && toolResult.type === 'tool_result' && toolResult.isError);
  assert.equal(run.finalText, 'recovered');
  assert.equal(run.aborted, false);
});

test('kernel aborts at the step cap when the model never stops', async () => {
  const callModel: CallModel = async () => ({ blocks: [{ type: 'tool_use', id: 'l', name: 'noop', input: {} }], stopReason: 'tool_use' });
  const run = await runKernelTask({ prompt: 'loop', tools: [], callModel, executeTool: async () => ({ content: 'ok' }), maxSteps: 3 });
  assert.equal(run.aborted, true);
  assert.equal(run.steps, 3);
  assert.equal(run.events.at(-1)?.type, 'aborted');
});

test('read-only tools read inside the root and refuse to escape it', async () => {
  const root = process.cwd(); // repo root during tests
  const { execute } = createReadOnlyTools(root);

  const pkg = await execute('read_file', { path: 'package.json' });
  assert.equal(pkg.isError, undefined);
  assert.match(pkg.content, /"name"/);

  const escape = await execute('read_file', { path: `..${path.sep}..${path.sep}..${path.sep}etc${path.sep}passwd` });
  assert.equal(escape.isError, true);
  assert.match(escape.content, /escapes the task root/);

  const listing = await execute('list_dir', { path: '.' });
  assert.match(listing.content, /package\.json/);

  const unknown = await execute('mystery', {});
  assert.equal(unknown.isError, true);
});

test('parseModelResponse maps text + tool_use blocks and stop_reason', () => {
  const turn: ModelTurn = parseModelResponse({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'tu9', name: 'list_dir', input: { path: '.' } },
      { type: 'thinking', thinking: 'ignored' },
    ],
  });
  assert.equal(turn.stopReason, 'tool_use');
  assert.equal(turn.blocks.length, 2);
  assert.deepEqual(turn.blocks[0], { type: 'text', text: 'let me look' });
  assert.deepEqual(turn.blocks[1], { type: 'tool_use', id: 'tu9', name: 'list_dir', input: { path: '.' } });
});

test('createAnthropicCallModel posts to /v1/messages and parses the reply', async () => {
  const original = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }) };
  }) as unknown as typeof fetch;
  try {
    const call = createAnthropicCallModel({ baseUrl: 'https://x.example/v1', apiKey: 'k', model: 'claude-sonnet-4-5', system: 'sys', tools: [] });
    const turn = await call([{ role: 'user', content: 'hello' }]);
    assert.equal(capturedUrl, 'https://x.example/v1/messages'); // baseUrl already ends in /v1
    assert.equal(capturedBody.model, 'claude-sonnet-4-5');
    assert.equal(capturedBody.system, 'sys');
    assert.deepEqual(turn.blocks, [{ type: 'text', text: 'hi' }]);
  } finally {
    globalThis.fetch = original;
  }
});
