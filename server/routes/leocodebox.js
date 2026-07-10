import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import TOML from '@iarna/toml';
import express from 'express';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const router = express.Router();

const ROUTE_DIR = getModuleDir(import.meta.url);
const APP_ROOT = findAppRoot(ROUTE_DIR);
const CC_SWITCH_REFERENCE_VERSION = '3.16.5';
const MAX_TEXT_FIELD = 20_000;
let switchMutationQueue = Promise.resolve();

const TARGETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    writable: true,
    configPaths: ['~/.claude/settings.json'],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    writable: true,
    configPaths: ['~/.codex/auth.json', '~/.codex/config.toml'],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    writable: true,
    configPaths: ['~/.config/opencode/opencode.json'],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    writable: false,
    configPaths: ['~/Library/Application Support/Cursor/User/settings.json'],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    writable: true,
    configPaths: ['~/.gemini/.env'],
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    writable: true,
    configPaths: ['~/.hermes/config.yaml'],
  },
};

const PRESETS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    target: 'claude',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    wireApi: 'chat',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    target: 'codex',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-codex',
    wireApi: 'responses',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    target: 'codex',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-5-codex',
    wireApi: 'chat',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    target: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-pro',
    wireApi: 'chat',
  },
  {
    id: 'opencode-compatible',
    name: 'OpenCode Compatible',
    target: 'opencode',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-5-codex',
    wireApi: 'chat',
  },
  {
    id: 'hermes-compatible',
    name: 'Hermes Compatible',
    target: 'hermes',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'anthropic/claude-sonnet-4-5',
    wireApi: 'chat',
  },
];

function homeDir() {
  return process.env.LEOCODEBOX_TEST_HOME || os.homedir();
}

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return homeDir();
  if (input.startsWith('~/')) return path.join(homeDir(), input.slice(2));
  return input;
}

function switchDir() {
  return path.join(homeDir(), '.leocodebox', 'switch');
}

function feedbackDir() {
  return path.join(homeDir(), '.leocodebox', 'feedback');
}

function providerStorePath() {
  return path.join(switchDir(), 'providers.json');
}

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, max = MAX_TEXT_FIELD) {
  return String(value == null ? '' : value).slice(0, max).trim();
}

function normalizeTarget(target) {
  const normalized = safeText(target).toLowerCase();
  return TARGETS[normalized] ? normalized : null;
}

function normalizeWireApi(wireApi) {
  return wireApi === 'responses' || wireApi === 'chat' ? wireApi : 'responses';
}

function sanitizeIdPart(value) {
  const cleaned = safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'provider';
}

function redactSecret(value) {
  const text = safeText(value, 500);
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function sanitizeProvider(provider) {
  return {
    ...provider,
    apiKey: provider.apiKey ? redactSecret(provider.apiKey) : '',
    hasApiKey: Boolean(provider.apiKey),
  };
}

function normalizeProvider(input, existing = null) {
  const target = normalizeTarget(input?.target || existing?.target);
  if (!target) {
    const error = new Error('Unsupported provider target.');
    error.statusCode = 400;
    throw error;
  }

  const name = safeText(input?.name || existing?.name || TARGETS[target].label, 120);
  const id = safeText(input?.id || existing?.id || `${target}-${crypto.randomUUID()}`, 90);
  const currentApiKey = existing?.apiKey || '';
  const nextApiKey = input?.apiKey === '__KEEP__' ? currentApiKey : safeText(input?.apiKey ?? currentApiKey, 4000);

  return {
    id,
    target,
    name,
    baseUrl: safeText(input?.baseUrl ?? existing?.baseUrl ?? '', 800),
    apiKey: nextApiKey,
    model: safeText(input?.model ?? existing?.model ?? '', 200),
    wireApi: normalizeWireApi(input?.wireApi ?? existing?.wireApi),
    notes: safeText(input?.notes ?? existing?.notes ?? '', 2000),
    category: safeText(input?.category ?? existing?.category ?? 'custom', 80),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    source: 'leocodebox-switch',
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(filePath, contents, mode = 0o600) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, contents, { mode });
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // chmod is best-effort on filesystems that support POSIX modes.
  }
}

function withSwitchMutation(operation) {
  const result = switchMutationQueue.then(operation, operation);
  switchMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function captureFiles(filePaths) {
  return Promise.all(filePaths.map(async (filePath) => {
    try {
      const [contents, stats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
      return { filePath, exists: true, contents, mode: stats.mode & 0o777 };
    } catch (error) {
      if (error?.code === 'ENOENT') return { filePath, exists: false };
      throw error;
    }
  }));
}

async function restoreFiles(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.exists) {
      await atomicWrite(snapshot.filePath, snapshot.contents, snapshot.mode || 0o600);
    } else {
      await fs.rm(snapshot.filePath, { force: true, recursive: false });
    }
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, value, mode = 0o600) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function readStore() {
  const store = await readJsonFile(providerStorePath(), { providers: [], activeByTarget: {} });
  return {
    providers: Array.isArray(store.providers) ? store.providers : [],
    activeByTarget: store.activeByTarget && typeof store.activeByTarget === 'object' ? store.activeByTarget : {},
  };
}

async function writeStore(store) {
  await writeJsonFile(providerStorePath(), store);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupFile(filePath) {
  if (!(await fileExists(filePath))) return null;
  const relative = path.relative(homeDir(), filePath).replace(/\.\./g, '_').replace(/^\/+/, '');
  const backupPath = path.join(
    switchDir(),
    'backups',
    new Date().toISOString().replace(/[:.]/g, '-'),
    relative || path.basename(filePath),
  );
  await ensureDir(path.dirname(backupPath));
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

function configStatus() {
  return Object.fromEntries(Object.entries(TARGETS).map(([id, target]) => {
    const files = target.configPaths.map((displayPath) => {
      const resolvedPath = expandHome(displayPath);
      return {
        path: displayPath,
        resolvedPath,
        exists: fsSync.existsSync(resolvedPath),
      };
    });
    return [id, { ...target, files }];
  }));
}

function managedTomlBlocks(provider, includeProfile = true) {
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  const model = provider.model || 'gpt-5-codex';
  const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
  const wireApi = normalizeWireApi(provider.wireApi);
  const tomlString = (value) => JSON.stringify(String(value));

  const topLevel = [
    '# BEGIN LEOCODEBOX SWITCH TOP LEVEL',
    '# Managed by leocodebox local provider switch. Edits inside this block may be replaced.',
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(providerKey)}`,
    '# END LEOCODEBOX SWITCH TOP LEVEL',
    '',
  ].join('\n');

  const tables = [
    '# BEGIN LEOCODEBOX SWITCH TABLES',
    '# Managed by leocodebox local provider switch. Edits inside this block may be replaced.',
    '',
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(provider.name || providerKey)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    `wire_api = ${tomlString(wireApi)}`,
    '',
    ...(includeProfile ? [
      '[profiles.leocodebox]',
      `model_provider = ${tomlString(providerKey)}`,
      `model = ${tomlString(model)}`,
    ] : []),
    '# END LEOCODEBOX SWITCH TABLES',
    '',
  ].join('\n');
  return { topLevel, tables };
}

function removeManagedTomlBlock(config) {
  return String(config || '')
    .replace(/\n?# BEGIN LEOCODEBOX SWITCH TOP LEVEL[\s\S]*?# END LEOCODEBOX SWITCH TOP LEVEL\n?/g, '\n')
    .replace(/\n?# BEGIN LEOCODEBOX SWITCH TABLES[\s\S]*?# END LEOCODEBOX SWITCH TABLES\n?/g, '\n')
    .replace(/\n?# BEGIN LEOCODEBOX SWITCH[\s\S]*?# END LEOCODEBOX SWITCH\n?/g, '\n')
    .trimEnd();
}

function removeManagedTopLevelKeys(config) {
  const lines = String(config || '').split(/\r?\n/);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const preambleEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const preamble = lines.slice(0, preambleEnd).filter((line) => !/^\s*(model|model_provider)\s*=/.test(line));
  return [...preamble, ...lines.slice(preambleEnd)].join('\n').trimEnd();
}

async function applyClaudeProvider(provider) {
  const settingsPath = expandHome('~/.claude/settings.json');
  await backupFile(settingsPath);
  const settings = await readJsonFile(settingsPath, {});
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};

  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
  else delete env.ANTHROPIC_BASE_URL;
  if (provider.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
    env.ANTHROPIC_API_KEY = provider.apiKey;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }
  if (provider.model) {
    env.ANTHROPIC_MODEL = provider.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model;
  } else {
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  }

  const nextSettings = {
    ...settings,
    env,
  };
  await writeJsonFile(settingsPath, nextSettings);
  return [settingsPath];
}

async function applyCodexProvider(provider) {
  const authPath = expandHome('~/.codex/auth.json');
  const configPath = expandHome('~/.codex/config.toml');
  await backupFile(authPath);
  await backupFile(configPath);

  const auth = await readJsonFile(authPath, {});
  if (provider.apiKey) {
    auth.OPENAI_API_KEY = provider.apiKey;
  } else {
    delete auth.OPENAI_API_KEY;
  }
  await writeJsonFile(authPath, auth);

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const unmanaged = removeManagedTopLevelKeys(removeManagedTomlBlock(existing));
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  const providerTablePattern = new RegExp(`^\\s*\\[model_providers\\.${providerKey}\\]\\s*$`, 'm');
  if (providerTablePattern.test(unmanaged)) {
    const error = new Error(`Codex config already defines model_providers.${providerKey}; rename the CC Switch provider before applying it.`);
    error.statusCode = 409;
    throw error;
  }
  const hasExistingLeocodeboxProfile = /^\s*\[profiles\.leocodebox\]\s*$/m.test(unmanaged);
  const managed = managedTomlBlocks(provider, !hasExistingLeocodeboxProfile);
  const nextConfig = `${managed.topLevel}${unmanaged ? `\n${unmanaged.trimStart()}\n` : '\n'}\n${managed.tables}`;
  TOML.parse(nextConfig);
  await atomicWrite(configPath, nextConfig);
  return [authPath, configPath];
}

function parseEnv(content) {
  const env = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (/^[A-Z0-9_]+$/.test(key)) env[key] = rest.join('=');
  }
  return env;
}

function serializeEnv(env) {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${String(env[key] ?? '')}`)
    .join('\n') + '\n';
}

async function applyGeminiProvider(provider) {
  const envPath = expandHome('~/.gemini/.env');
  await backupFile(envPath);
  let env = {};
  try {
    env = parseEnv(await fs.readFile(envPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (provider.apiKey) {
    env.GEMINI_API_KEY = provider.apiKey;
    env.GOOGLE_API_KEY = provider.apiKey;
  }
  if (provider.baseUrl) env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl;
  if (provider.model) env.GEMINI_MODEL = provider.model;

  await atomicWrite(envPath, serializeEnv(env));
  return [envPath];
}

function opencodeProviderFragment(provider) {
  const model = provider.model || 'gpt-5-codex';
  const options = {};
  if (provider.baseUrl) options.baseURL = provider.baseUrl;
  if (provider.apiKey) options.apiKey = provider.apiKey;

  return {
    npm: provider.category === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    name: provider.name,
    options,
    models: {
      [model]: { name: model },
    },
  };
}

async function applyOpenCodeProvider(provider) {
  const configPath = expandHome('~/.config/opencode/opencode.json');
  await backupFile(configPath);
  const config = await readJsonFile(configPath, {
    $schema: 'https://opencode.ai/config.json',
  });
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  if (!config.provider || typeof config.provider !== 'object' || Array.isArray(config.provider)) {
    config.provider = {};
  }
  config.provider[providerKey] = opencodeProviderFragment(provider);
  if (provider.model) {
    config.model = `${providerKey}/${provider.model}`;
  }
  await writeJsonFile(configPath, config);
  return [configPath];
}

function yamlString(value) {
  return JSON.stringify(String(value || ''));
}

function managedHermesBlock(provider) {
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  const model = provider.model || 'anthropic/claude-sonnet-4-5';
  const baseUrl = provider.baseUrl || 'https://api.example.com/v1';
  return [
    '# BEGIN LEOCODEBOX SWITCH',
    '# Managed by leocodebox local provider switch. Edits inside this block may be replaced.',
    'model:',
    `  default: ${yamlString(model)}`,
    `  provider: ${yamlString(providerKey)}`,
    `  base_url: ${yamlString(baseUrl)}`,
    'custom_providers:',
    `  - name: ${yamlString(providerKey)}`,
    `    base_url: ${yamlString(baseUrl)}`,
    `    api_key: ${yamlString(provider.apiKey || '')}`,
    `    model: ${yamlString(model)}`,
    '# END LEOCODEBOX SWITCH',
    '',
  ].join('\n');
}

function removeManagedHermesBlock(config) {
  return String(config || '').replace(/\n?# BEGIN LEOCODEBOX SWITCH[\s\S]*?# END LEOCODEBOX SWITCH\n?/g, '\n').trimEnd();
}

async function applyHermesProvider(provider) {
  const configPath = expandHome('~/.hermes/config.yaml');
  await backupFile(configPath);
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const unmanaged = removeManagedHermesBlock(existing);
  const nextConfig = `${unmanaged ? `${unmanaged}\n\n` : ''}${managedHermesBlock(provider)}`;
  await atomicWrite(configPath, nextConfig);
  return [configPath];
}

async function applyProvider(provider) {
  if (!TARGETS[provider.target]?.writable) {
    const error = new Error(`${TARGETS[provider.target]?.label || provider.target} is listed but does not yet have a safe writer in leocodebox.`);
    error.statusCode = 501;
    throw error;
  }
  if (provider.target === 'claude') return applyClaudeProvider(provider);
  if (provider.target === 'codex') return applyCodexProvider(provider);
  if (provider.target === 'gemini') return applyGeminiProvider(provider);
  if (provider.target === 'opencode') return applyOpenCodeProvider(provider);
  if (provider.target === 'hermes') return applyHermesProvider(provider);
  const error = new Error('Unsupported provider target.');
  error.statusCode = 400;
  throw error;
}

async function applyProviderTransactionally(provider, commit) {
  const filePaths = TARGETS[provider.target].configPaths.map(expandHome);
  const snapshots = await captureFiles(filePaths);
  try {
    const changedFiles = await applyProvider(provider);
    if (commit) await commit(changedFiles);
    return changedFiles;
  } catch (error) {
    try {
      await restoreFiles(snapshots);
    } catch (restoreError) {
      error.message = `${error.message} Rollback also failed: ${restoreError.message}`;
    }
    throw error;
  }
}

async function importCurrentProviders(store) {
  const imported = [];

  try {
    const claudeSettings = await readJsonFile(expandHome('~/.claude/settings.json'), null);
    const env = claudeSettings?.env;
    if (env && typeof env === 'object') {
      const provider = normalizeProvider({
        id: 'claude-current',
        target: 'claude',
        name: 'Claude Code 当前配置',
        baseUrl: env.ANTHROPIC_BASE_URL || '',
        apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'claude-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const auth = await readJsonFile(expandHome('~/.codex/auth.json'), {});
    let config = '';
    try {
      config = await fs.readFile(expandHome('~/.codex/config.toml'), 'utf8');
    } catch {
      config = '';
    }
    const baseUrl = config.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    const model = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    if (auth.OPENAI_API_KEY || baseUrl || model) {
      const provider = normalizeProvider({
        id: 'codex-current',
        target: 'codex',
        name: 'Codex 当前配置',
        baseUrl,
        apiKey: auth.OPENAI_API_KEY || '',
        model,
        wireApi: 'responses',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'codex-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const env = parseEnv(await fs.readFile(expandHome('~/.gemini/.env'), 'utf8'));
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GEMINI_BASE_URL || env.GEMINI_MODEL) {
      const provider = normalizeProvider({
        id: 'gemini-current',
        target: 'gemini',
        name: 'Gemini 当前配置',
        baseUrl: env.GOOGLE_GEMINI_BASE_URL || '',
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
        model: env.GEMINI_MODEL || '',
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'gemini-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const opencode = await readJsonFile(expandHome('~/.config/opencode/opencode.json'), {});
    const configuredProviders = opencode.provider && typeof opencode.provider === 'object' ? opencode.provider : {};
    const [providerId, providerConfig] = Object.entries(configuredProviders)[0] || [];
    if (providerId && providerConfig && typeof providerConfig === 'object') {
      const modelFromConfig = typeof opencode.model === 'string' && opencode.model.includes('/')
        ? opencode.model.split('/').slice(1).join('/')
        : Object.keys(providerConfig.models || {})[0] || '';
      const provider = normalizeProvider({
        id: 'opencode-current',
        target: 'opencode',
        name: `OpenCode 当前配置 (${providerId})`,
        baseUrl: providerConfig.options?.baseURL || '',
        apiKey: providerConfig.options?.apiKey || '',
        model: modelFromConfig,
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'opencode-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const hermes = await fs.readFile(expandHome('~/.hermes/config.yaml'), 'utf8');
    const baseUrl = hermes.match(/^\s*base_url:\s*["']?([^"'\n]+)["']?/m)?.[1] || '';
    const apiKey = hermes.match(/^\s*api_key:\s*["']?([^"'\n]+)["']?/m)?.[1] || '';
    const model = hermes.match(/^\s*(?:default|model):\s*["']?([^"'\n]+)["']?/m)?.[1] || '';
    if (baseUrl || apiKey || model) {
      const provider = normalizeProvider({
        id: 'hermes-current',
        target: 'hermes',
        name: 'Hermes 当前配置',
        baseUrl,
        apiKey,
        model,
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'hermes-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  return imported;
}

function upsertProviderInStore(store, provider) {
  const index = store.providers.findIndex((item) => item.id === provider.id);
  if (index === -1) {
    store.providers.push(provider);
  } else {
    store.providers[index] = provider;
  }
}

// Maps one native CC Switch `providers` row (app_type + settings_config JSON)
// onto the leocodebox provider shape. Returns null for app types leocodebox
// cannot yet write, so they are reported as skipped rather than mis-imported.
function mapCcSwitchRow(row) {
  const target = normalizeTarget(row.app_type);
  if (!target) return null;

  let settings = {};
  try {
    settings = JSON.parse(row.settings_config || '{}');
  } catch {
    settings = {};
  }
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};

  let baseUrl = '';
  let apiKey = '';
  let model = '';

  if (target === 'claude') {
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || (typeof settings.model === 'string' ? settings.model : '');
  } else if (target === 'codex') {
    const auth = settings.auth && typeof settings.auth === 'object' ? settings.auth : {};
    apiKey = auth.OPENAI_API_KEY || '';
    const configText = typeof settings.config === 'string' ? settings.config : '';
    baseUrl = configText.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    model = configText.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  } else if (target === 'gemini') {
    baseUrl = env.GOOGLE_GEMINI_BASE_URL || '';
    apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
    model = env.GOOGLE_GEMINI_MODEL || env.GEMINI_MODEL || '';
  } else {
    return null;
  }

  return {
    target,
    name: safeText(row.name || TARGETS[target].label, 120),
    baseUrl,
    apiKey,
    model,
    wireApi: target === 'codex' ? 'responses' : 'chat',
    isCurrent: row.is_current === 1 || row.is_current === true,
    notes: safeText(row.notes || '', 2000),
  };
}

async function importCcSwitchProviders(store) {
  const dbPath = path.join(homeDir(), '.cc-switch', 'cc-switch.db');
  if (!(await fileExists(dbPath))) {
    return { dbFound: false, imported: [], skipped: [] };
  }

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows = [];
  try {
    rows = db.prepare('SELECT id, app_type, name, settings_config, notes, is_current FROM providers').all();
  } finally {
    db.close();
  }

  const imported = [];
  const skipped = [];
  for (const row of rows) {
    const mapped = mapCcSwitchRow(row);
    if (!mapped) {
      skipped.push({ id: row.id, appType: row.app_type, reason: 'unsupported-target' });
      continue;
    }
    if (!mapped.apiKey && !mapped.baseUrl) {
      skipped.push({ id: row.id, appType: row.app_type, reason: 'no-credentials' });
      continue;
    }
    const id = `ccsw-${sanitizeIdPart(row.app_type)}-${sanitizeIdPart(row.id)}`;
    const provider = normalizeProvider(
      { ...mapped, id, category: 'imported-ccswitch' },
      store.providers.find((item) => item.id === id),
    );
    upsertProviderInStore(store, provider);
    // Do NOT set activeByTarget on import: "active" in leocodebox means the
    // provider's config was actually written to disk via apply. Import only
    // records the provider; the user applies it explicitly.
    imported.push(provider);
  }

  return { dbFound: true, imported, skipped };
}

// Lightweight reachability + latency probe against a provider's base URL.
// Reports HTTP status and round-trip time — an honest connectivity signal
// without over-claiming quota/billing checks the endpoint may not expose.
async function testProviderConnectivity(provider) {
  const rawBase = safeText(provider.baseUrl, 800);
  if (!rawBase) {
    return { reachable: false, latencyMs: null, httpStatus: null, note: '未配置 Base URL，无法测试连通性。' };
  }

  let target = rawBase.replace(/\/+$/, '');
  if (/\/(v1|responses|chat|models)$/i.test(target) === false && /\/v1$/i.test(target) === false) {
    target = `${target}/models`;
  } else if (/\/v1$/i.test(target)) {
    target = `${target}/models`;
  }

  const headers = { 'User-Agent': 'leocodebox-connectivity-check' };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
    headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers,
      // Do not follow redirects: prevents a provider baseUrl from bouncing the
      // attached API key to a different host.
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - startedAt;
    // Any HTTP response (even 401/403) proves the endpoint is reachable.
    return {
      reachable: true,
      latencyMs,
      httpStatus: response.status,
      note: response.ok
        ? '端点可达且认证通过。'
        : `端点可达（HTTP ${response.status}）。${response.status === 401 || response.status === 403 ? '凭据可能无效或需要不同的认证头。' : ''}`,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      note: error?.name === 'TimeoutError' ? '连接超时（8 秒）。' : `无法连接：${error?.message || '未知错误'}`,
    };
  }
}

function parseRepositoryUrl(repo) {
  const value = typeof repo === 'string' ? repo : repo?.url;
  if (!value) return null;
  const match = value.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] || 0) - (pb[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'leocodebox-local-update-check',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

async function readPackageJson() {
  try {
    return JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function checkUpdates() {
  const pkg = await readPackageJson();
  const currentVersion = pkg.version || null;
  const repoPath = parseRepositoryUrl(pkg.repository) || 'leoyuan/leocodebox';
  const result = {
    checkedAt: nowIso(),
    current: {
      name: pkg.name || 'leocodebox',
      version: currentVersion,
    },
    own: {
      repository: repoPath,
      latest: null,
      updateAvailable: false,
      url: `https://github.com/${repoPath}/releases`,
      error: null,
    },
    upstream: {
      package: '@cloudcli-ai/cloudcli',
      latest: null,
      updateAvailable: false,
      url: 'https://www.npmjs.com/package/@cloudcli-ai/cloudcli',
      error: null,
    },
    ccSwitch: {
      repository: 'farion1231/cc-switch',
      referenceVersion: CC_SWITCH_REFERENCE_VERSION,
      latest: null,
      updateAvailable: false,
      url: 'https://github.com/farion1231/cc-switch',
      error: null,
    },
  };

  try {
    const release = await fetchJson(`https://api.github.com/repos/${repoPath}/releases/latest`);
    result.own.latest = release.tag_name || release.name || null;
    result.own.url = release.html_url || result.own.url;
    result.own.updateAvailable = Boolean(currentVersion && result.own.latest && compareSemver(result.own.latest, currentVersion) > 0);
  } catch (error) {
    if (error.statusCode === 404) {
      result.own.latest = currentVersion;
      result.own.error = null;
    } else {
      result.own.error = error.message;
    }
  }

  try {
    const npmInfo = await fetchJson('https://registry.npmjs.org/%40cloudcli-ai%2Fcloudcli/latest');
    result.upstream.latest = npmInfo.version || null;
    result.upstream.updateAvailable = Boolean(currentVersion && result.upstream.latest && compareSemver(result.upstream.latest, currentVersion) > 0);
  } catch (error) {
    result.upstream.error = error.message;
  }

  try {
    const ccPkg = await fetchJson('https://raw.githubusercontent.com/farion1231/cc-switch/main/package.json');
    result.ccSwitch.latest = ccPkg.version || null;
    result.ccSwitch.updateAvailable = Boolean(result.ccSwitch.latest && compareSemver(result.ccSwitch.latest, CC_SWITCH_REFERENCE_VERSION) > 0);
  } catch (error) {
    result.ccSwitch.error = error.message;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agent CLI tooling: live version + one-click self-update
// ---------------------------------------------------------------------------

const CLI_VERSION_TOKEN = /(?<![\d.])(\d+\.\d+[A-Za-z0-9.+_-]*)/;

const CLI_TOOLS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    updateArgs: ['update'],
    npmPackage: '@anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    updateArgs: ['update'],
    npmPackage: '@openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    // `opencode upgrade` alone launches an interactive TUI that blocks headless;
    // pinning the install method makes it run non-interactively.
    label: 'OpenCode',
    cmd: 'opencode',
    updateArgs: ['upgrade', '-m', 'npm'],
    npmPackage: 'opencode-ai',
    docsUrl: 'https://opencode.ai',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor-agent',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://cursor.com',
  },
};

function parseCliVersionText(output) {
  if (!output) return null;
  const match = String(output).match(CLI_VERSION_TOKEN);
  return match ? match[1] : null;
}

function runCliCommand(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null,
      });
    });
  });
}

async function readCliLatestVersion(tool) {
  if (!tool.npmPackage) return null;
  const encoded = tool.npmPackage.replace('@', '%40').replace('/', '%2F');
  try {
    const info = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`);
    return info?.version || null;
  } catch {
    return null;
  }
}

async function getCliToolStatus(tool, { checkLatest = true } = {}) {
  const probe = await runCliCommand(tool.cmd, ['--version'], 5000);
  const installed = probe.ok;
  const currentVersion = installed ? parseCliVersionText(probe.stdout || probe.stderr) : null;
  const latestVersion = checkLatest && installed ? await readCliLatestVersion(tool) : null;
  const updateAvailable = Boolean(
    currentVersion && latestVersion && compareSemver(latestVersion, currentVersion) > 0,
  );
  return {
    id: tool.id,
    label: tool.label,
    command: tool.cmd,
    installed,
    currentVersion,
    latestVersion,
    updateAvailable,
    canSelfUpdate: true,
    docsUrl: tool.docsUrl,
  };
}

router.get('/cli/status', async (_req, res, next) => {
  try {
    const tools = await Promise.all(
      Object.values(CLI_TOOLS).map((tool) => getCliToolStatus(tool)),
    );
    res.json({ success: true, checkedAt: nowIso(), tools });
  } catch (error) {
    next(error);
  }
});

router.post('/cli/:id/update', async (req, res, next) => {
  try {
    if (process.env.LEOCODEBOX_LOCAL_ONLY !== '1' && !process.env.LEOCODEBOX_TEST_HOME) {
      res.status(403).json({ success: false, error: 'CLI updates are available only in local-only mode.' });
      return;
    }
    const tool = CLI_TOOLS[String(req.params.id || '').toLowerCase()];
    if (!tool) {
      res.status(404).json({ success: false, error: 'Unknown CLI tool.' });
      return;
    }
    const before = await getCliToolStatus(tool, { checkLatest: false });
    if (!before.installed) {
      res.status(409).json({ success: false, error: `${tool.label} CLI is not installed.` });
      return;
    }
    const result = await runCliCommand(tool.cmd, tool.updateArgs, 180_000);
    const after = await getCliToolStatus(tool, { checkLatest: false });
    res.json({
      success: result.ok,
      tool: tool.id,
      previousVersion: before.currentVersion,
      currentVersion: after.currentVersion,
      changed: before.currentVersion !== after.currentVersion,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000),
      error: result.ok ? null : (result.error || 'Update command failed.'),
    });
  } catch (error) {
    next(error);
  }
});

router.use('/switch', (req, res, next) => {
  if (process.env.LEOCODEBOX_LOCAL_ONLY === '1' || process.env.LEOCODEBOX_TEST_HOME) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Provider switching is available only in local-only mode.' });
});

router.get('/switch/status', async (_req, res, next) => {
  try {
    const store = await readStore();
    res.json({
      success: true,
      targets: configStatus(),
      presets: PRESETS,
      activeByTarget: store.activeByTarget,
      providers: store.providers.map(sanitizeProvider),
      storePath: providerStorePath(),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const existing = req.body?.id ? store.providers.find((provider) => provider.id === req.body.id) : null;
      const provider = normalizeProvider(req.body, existing);
      upsertProviderInStore(store, provider);
      await writeStore(store);
      res.json({ success: true, provider: sanitizeProvider(provider) });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/apply', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const provider = store.providers.find((item) => item.id === req.params.id);
      if (!provider) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }

      const changedFiles = await applyProviderTransactionally(provider, async () => {
        store.activeByTarget[provider.target] = provider.id;
        provider.lastAppliedAt = nowIso();
        provider.updatedAt = nowIso();
        await writeStore(store);
      });

      res.json({
        success: true,
        provider: sanitizeProvider(provider),
        activeByTarget: store.activeByTarget,
        changedFiles,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/import-current', async (_req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const imported = await importCurrentProviders(store);
      await writeStore(store);
      res.json({
        success: true,
        imported: imported.map(sanitizeProvider),
        providers: store.providers.map(sanitizeProvider),
        activeByTarget: store.activeByTarget,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/import-cc-switch', async (_req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const result = await importCcSwitchProviders(store);
      if (!result.dbFound) {
        res.status(404).json({ success: false, error: '未找到原生 CC Switch 数据库 (~/.cc-switch/cc-switch.db)。' });
        return;
      }
      await writeStore(store);
      res.json({
        success: true,
        imported: result.imported.map(sanitizeProvider),
        skipped: result.skipped,
        providers: store.providers.map(sanitizeProvider),
        activeByTarget: store.activeByTarget,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/switch/providers/:id', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const index = store.providers.findIndex((item) => item.id === req.params.id);
      if (index === -1) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }
      const [removed] = store.providers.splice(index, 1);
      for (const [target, activeId] of Object.entries(store.activeByTarget)) {
        if (activeId === removed.id) delete store.activeByTarget[target];
      }
      await writeStore(store);
      res.json({
        success: true,
        removed: sanitizeProvider(removed),
        providers: store.providers.map(sanitizeProvider),
        activeByTarget: store.activeByTarget,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/test', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found.' });
      return;
    }
    const result = await testProviderConnectivity(provider);
    res.json({ success: true, provider: provider.id, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/switch/backups', async (_req, res, next) => {
  try {
    const root = path.join(switchDir(), 'backups');
    const backups = [];
    async function walk(dir) {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(filePath);
        } else {
          backups.push({
            path: filePath,
            relativePath: path.relative(root, filePath),
          });
        }
      }
    }
    await walk(root);
    backups.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
    res.json({ success: true, backups });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/backups/restore', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const root = path.resolve(switchDir(), 'backups');
      const relativePath = String(req.body?.relativePath || '').trim();
      const backupPath = path.resolve(root, relativePath);
      if (!relativePath || !backupPath.startsWith(`${root}${path.sep}`)) {
        const error = new Error('Invalid backup path.');
        error.statusCode = 400;
        throw error;
      }

      const parts = relativePath.split(/[\\/]+/).filter(Boolean);
      if (parts.length < 2) {
        const error = new Error('Backup path does not include a restorable config path.');
        error.statusCode = 400;
        throw error;
      }
      const destination = path.resolve(homeDir(), ...parts.slice(1));
      const home = path.resolve(homeDir());
      if (!destination.startsWith(`${home}${path.sep}`)) {
        const error = new Error('Backup destination escapes the local home directory.');
        error.statusCode = 400;
        throw error;
      }

      const contents = await fs.readFile(backupPath);
      await backupFile(destination);
      await atomicWrite(destination, contents, 0o600);
      res.json({ success: true, restoredPath: destination });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/feedback', async (req, res, next) => {
  try {
    const payload = {
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      role: safeText(req.body?.role, 80),
      severity: safeText(req.body?.severity, 40),
      area: safeText(req.body?.area, 120),
      title: safeText(req.body?.title, 200),
      description: safeText(req.body?.description),
      steps: safeText(req.body?.steps),
      expected: safeText(req.body?.expected),
      actual: safeText(req.body?.actual),
      pageUrl: safeText(req.body?.pageUrl, 1000),
      userAgent: safeText(req.body?.userAgent, 1000),
      appVersion: safeText(req.body?.appVersion, 80),
      language: safeText(req.body?.language, 40),
    };

    if (!payload.title || !payload.description) {
      res.status(400).json({ success: false, error: 'Title and description are required.' });
      return;
    }

    await ensureDir(feedbackDir());
    const fileName = `${payload.createdAt.replace(/[:.]/g, '-')}-${payload.id}.json`;
    const filePath = path.join(feedbackDir(), fileName);
    await writeJsonFile(filePath, payload);
    res.json({ success: true, id: payload.id, filePath });
  } catch (error) {
    next(error);
  }
});

router.get('/feedback', async (_req, res, next) => {
  try {
    let files = [];
    try {
      files = await fs.readdir(feedbackDir());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const reports = [];
    for (const fileName of files.filter((file) => file.endsWith('.json')).sort().reverse().slice(0, 100)) {
      try {
        const report = await readJsonFile(path.join(feedbackDir(), fileName), null);
        if (report) reports.push({ ...report, fileName });
      } catch {
        // Skip malformed local report files.
      }
    }
    res.json({ success: true, reports, directory: feedbackDir() });
  } catch (error) {
    next(error);
  }
});

router.get('/updates/check', async (_req, res, next) => {
  try {
    res.json({ success: true, updates: await checkUpdates() });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'leocodebox local route failed.',
  });
});

export default router;
