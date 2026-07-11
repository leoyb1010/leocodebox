import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRegistry } from '../provider.registry.js';

const expectedChatProviders = ['claude', 'codex', 'cursor', 'opencode'];

test('provider manifests expose supported and capability-only integrations', () => {
  const manifests = providerRegistry.listManifests();
  assert.deepEqual(
    manifests.filter((manifest) => manifest.capabilities.chat === 'supported').map(({ id }) => id),
    expectedChatProviders,
  );
  assert.equal(providerRegistry.resolveManifest('grok').capabilities.configSwitch, 'supported');
  assert.equal(providerRegistry.resolveManifest('grok').runtimeProvider, undefined);
  assert.equal(providerRegistry.resolveManifest('claude').runtimeProvider, 'claude');
  assert.equal(providerRegistry.resolveManifest('claude').configTarget, 'claude');
  assert.equal(providerRegistry.resolveManifest('claude').cliTool, 'claude');
  assert.equal(providerRegistry.resolveManifest('antigravity').capabilities.chat, 'unverified');
  assert.equal(providerRegistry.resolveManifest('openclaw').capabilities.chat, 'unverified');
});

test('provider templates are separate from runtime providers', () => {
  const templates = providerRegistry.listTemplates();
  assert.equal(new Set(templates.map(({ id }) => id)).size, templates.length);
  const xai = providerRegistry.resolveTemplate('xai');
  assert.equal(xai.status, 'beta');
  assert.equal(xai.target, 'codex');
  assert.equal(xai.defaultModel, '');
  assert.throws(() => providerRegistry.resolveProvider(xai.id), /Unsupported provider/);
});

test('capability-only integrations cannot resolve a chat provider', () => {
  for (const id of ['gemini', 'grok', 'antigravity', 'openclaw']) {
    assert.throws(
      () => providerRegistry.resolveProvider(id),
      (error) => error instanceof Error && /usable chat capability/.test(error.message),
    );
  }
});

test('unknown providers are rejected distinctly', () => {
  assert.throws(
    () => providerRegistry.resolveManifest('invented-provider'),
    (error) => error instanceof Error && /Unsupported provider/.test(error.message),
  );
});

test('registry methods remain safe when passed as callbacks', () => {
  const { resolveProvider, requireCapability, hasCapability } = providerRegistry;
  assert.equal(resolveProvider('opencode').id, 'opencode');
  assert.equal(requireCapability('opencode', 'models').id, 'opencode');
  assert.equal(hasCapability('opencode', 'models'), true);
});
