import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import TOML from '@iarna/toml';
import express from 'express';

import {
  getClaudeConfigDir,
  getCodexHome,
  getGeminiHome,
  getHermesHome,
  getOpenCodeConfigDir,
} from '../../shared/provider-runtime-paths.js';
import { findAppRoot, getModuleDir } from '../../utils/runtime-paths.js';
import { PROVIDER_TEMPLATES } from '../../shared/provider-templates.js';

const router = express.Router();

const ROUTE_DIR = getModuleDir(import.meta.url);
const APP_ROOT = findAppRoot(ROUTE_DIR);
const MAX_TEXT_FIELD = 20_000;
const MODEL_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const modelDiscoveryCache = new Map();
const pendingModelDiscoveries = new Map();
const pendingCliMutations = new Map();
let switchMutationQueue = Promise.resolve();
let modelCacheMutationQueue = Promise.resolve();

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

function providerModelCachePath() {
  return path.join(switchDir(), 'model-discovery-cache.json');
}

function modelDiscoveryCacheKey(provider, rawBase) {
  const apiKeyFingerprint = crypto.createHash('sha256').update(String(provider.apiKey || '')).digest('hex').slice(0, 16);
  return crypto.createHash('sha256').update(JSON.stringify({
    target: provider.target,
    baseUrl: safeText(rawBase, 800).replace(/\/+$/, ''),
    wireApi: normalizeWireApi(provider.wireApi),
    apiKeyFingerprint,
  })).digest('hex');
}

function isValidModelDiscoveryCacheEntry(entry, now = Date.now()) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && Number.isFinite(entry.updatedAt)
    && Number.isFinite(entry.expiresAt)
    && entry.updatedAt > 0
    && entry.expiresAt > now
    && entry.result
    && Array.isArray(entry.result.models),
  );
}

function modelDiscoveryCacheInfo(entry, source) {
  return {
    source,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

async function loadModelDiscoveryDiskCache() {
  const value = await readJsonFile(providerModelCachePath(), { version: 2, entries: {} });
  if (value?.version !== 2 || !value.entries || typeof value.entries !== 'object') return {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(value.entries).filter(([, entry]) => isValidModelDiscoveryCacheEntry(entry, now)),
  );
}

function withModelCacheMutation(operation) {
  const result = modelCacheMutationQueue.then(operation, operation);
  modelCacheMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function persistModelDiscoveryCache() {
  await withModelCacheMutation(async () => {
    const now = Date.now();
    const diskEntries = await loadModelDiscoveryDiskCache();
    const mergedEntries = new Map(Object.entries(diskEntries));
    for (const [key, entry] of modelDiscoveryCache.entries()) {
      if (isValidModelDiscoveryCacheEntry(entry, now)) mergedEntries.set(key, entry);
      else mergedEntries.delete(key);
    }
    const entries = Object.fromEntries(
      [...mergedEntries.entries()].filter(([, entry]) => isValidModelDiscoveryCacheEntry(entry, now)),
    );
    await writeJsonFile(providerModelCachePath(), { version: 2, entries });
  });
}

function feedbackDir() {
  return path.join(homeDir(), '.leocodebox', 'feedback');
}

function providerStorePath() {
  return path.join(switchDir(), 'providers.json');
}

function targetConfigPaths(targetId) {
  if (targetId === 'claude') {
    return [path.join(getClaudeConfigDir(process.env, homeDir()), 'settings.json')];
  }
  if (targetId === 'codex') {
    const codexHome = getCodexHome(process.env, homeDir());
    return [path.join(codexHome, 'auth.json'), path.join(codexHome, 'config.toml')];
  }
  if (targetId === 'opencode') {
    return [path.join(getOpenCodeConfigDir(process.env, homeDir()), 'opencode.json')];
  }
  if (targetId === 'gemini') {
    return [path.join(getGeminiHome(process.env, homeDir()), '.env')];
  }
  if (targetId === 'hermes') {
    return [path.join(getHermesHome(process.env, homeDir()), 'config.yaml')];
  }
  return (TARGETS[targetId]?.configPaths || []).map(expandHome);
}

function displayConfigPath(filePath) {
  const home = path.resolve(homeDir());
  const resolved = path.resolve(filePath);
  return resolved === home || resolved.startsWith(`${home}${path.sep}`)
    ? `~${resolved.slice(home.length)}`
    : resolved;
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

function normalizeEndpointUrls(input, existing, baseUrl) {
  const source = Array.isArray(input?.endpoints)
    ? input.endpoints
    : Array.isArray(existing?.endpoints) ? existing.endpoints : [];
  const urls = [];
  for (const endpoint of source) {
    const url = safeText(typeof endpoint === 'string' ? endpoint : endpoint?.url, 800).replace(/\/+$/, '');
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 20) break;
  }
  const normalizedBase = safeText(baseUrl, 800).replace(/\/+$/, '');
  if (normalizedBase && !urls.includes(normalizedBase)) urls.unshift(normalizedBase);
  return urls;
}

function normalizeModelMapping(input, existing, fallbackModel) {
  const source = input?.modelMapping && typeof input.modelMapping === 'object'
    ? input.modelMapping
    : existing?.modelMapping && typeof existing.modelMapping === 'object' ? existing.modelMapping : {};
  return {
    sonnet: safeText(source.sonnet || fallbackModel, 240),
    opus: safeText(source.opus || fallbackModel, 240),
    haiku: safeText(source.haiku || fallbackModel, 240),
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

  const baseUrl = safeText(input?.baseUrl ?? existing?.baseUrl ?? '', 800).replace(/\/+$/, '');
  const model = safeText(input?.model ?? existing?.model ?? '', 200);
  return {
    id,
    target,
    name,
    baseUrl,
    endpoints: normalizeEndpointUrls(input, existing, baseUrl),
    autoSelectEndpoint: typeof input?.autoSelectEndpoint === 'boolean'
      ? input.autoSelectEndpoint
      : Boolean(existing?.autoSelectEndpoint),
    endpointStats: existing?.endpointStats && typeof existing.endpointStats === 'object'
      ? existing.endpointStats
      : {},
    apiKey: nextApiKey,
    model,
    discoveredModels: Array.isArray(existing?.discoveredModels)
      ? existing.discoveredModels.map((item) => safeText(item, 240)).filter(Boolean).slice(0, 300)
      : [],
    modelDiscovery: existing?.modelDiscovery && typeof existing.modelDiscovery === 'object'
      ? existing.modelDiscovery
      : null,
    modelDiscoveryError: safeText(existing?.modelDiscoveryError ?? '', 500),
    modelMapping: normalizeModelMapping(input, existing, model),
    wireApi: normalizeWireApi(input?.wireApi ?? existing?.wireApi),
    notes: safeText(input?.notes ?? existing?.notes ?? '', 2000),
    category: safeText(input?.category ?? existing?.category ?? 'custom', 80),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    source: 'leocodebox-switch',
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // chmod is best-effort on filesystems that support POSIX modes.
  }
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
  await ensureDir(switchDir());
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

function backupRelativePath(filePath) {
  const resolvedFilePath = path.resolve(filePath);
  const relativeToHome = path.relative(path.resolve(homeDir()), resolvedFilePath);
  const isInsideHome = relativeToHome
    && !relativeToHome.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeToHome);
  return isInsideHome
    ? relativeToHome
    : path.join('__external__', Buffer.from(resolvedFilePath).toString('base64url'));
}

async function backupFile(filePath) {
  if (!(await fileExists(filePath))) return null;
  const relative = backupRelativePath(filePath);
  const backupPath = path.join(
    switchDir(),
    'backups',
    new Date().toISOString().replace(/[:.]/g, '-'),
    relative || path.basename(filePath),
  );
  await ensureDir(path.dirname(backupPath));
  await fs.copyFile(filePath, backupPath);
  try {
    await fs.chmod(backupPath, 0o600);
  } catch {
    // chmod is best-effort on filesystems that support POSIX modes.
  }
  return backupPath;
}

function defaultSnapshotPath(target) {
  return path.join(switchDir(), 'defaults', `${target}.json`);
}

async function findEarliestBackup(filePath) {
  const root = path.join(switchDir(), 'backups');
  const relative = backupRelativePath(filePath);
  let folders = [];
  try {
    folders = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }

  for (const folder of folders) {
    const candidate = path.join(root, folder, relative);
    try {
      const [contents, stats] = await Promise.all([fs.readFile(candidate), fs.stat(candidate)]);
      return { filePath, exists: true, contents, mode: stats.mode & 0o777 };
    } catch {
      // Keep looking: older backup folders may not contain every target file.
    }
  }
  return null;
}

async function ensureDefaultSnapshot(target, store) {
  const snapshotPath = defaultSnapshotPath(target);
  if (await fileExists(snapshotPath)) return snapshotPath;

  const managedBeforeMigration = Boolean(store.activeByTarget?.[target]);
  const currentSnapshots = await captureFiles(targetConfigPaths(target));
  const snapshots = await Promise.all(currentSnapshots.map(async (snapshot) => {
    if (!managedBeforeMigration) return snapshot;
    return (await findEarliestBackup(snapshot.filePath)) || snapshot;
  }));
  const payload = {
    version: 1,
    target,
    createdAt: nowIso(),
    files: snapshots.map((snapshot) => ({
      path: snapshot.filePath,
      exists: snapshot.exists,
      mode: snapshot.mode || 0o600,
      contents: snapshot.exists ? snapshot.contents.toString('base64') : null,
    })),
  };
  await writeJsonFile(snapshotPath, payload);
  return snapshotPath;
}

async function readDefaultSnapshot(target) {
  const payload = await readJsonFile(defaultSnapshotPath(target), null);
  if (!payload || payload.target !== target || !Array.isArray(payload.files)) return null;
  const expectedPaths = new Set(targetConfigPaths(target).map((filePath) => path.resolve(filePath)));
  const snapshots = payload.files.map((file) => ({
    filePath: String(file.path || ''),
    exists: Boolean(file.exists),
    mode: Number(file.mode) || 0o600,
    contents: file.exists ? Buffer.from(String(file.contents || ''), 'base64') : undefined,
  })).filter((file) => file.filePath);
  const restoredPaths = new Set(snapshots.map((snapshot) => path.resolve(snapshot.filePath)));
  if (
    snapshots.length !== expectedPaths.size
    || restoredPaths.size !== expectedPaths.size
    || [...restoredPaths].some((filePath) => !expectedPaths.has(filePath))
  ) {
    return null;
  }
  return snapshots;
}

function resolveBackupDestination(relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[1] === '__external__') {
    if (parts.length !== 3) return null;
    try {
      const decoded = Buffer.from(parts[2], 'base64url').toString('utf8');
      return path.isAbsolute(decoded) ? path.resolve(decoded) : null;
    } catch {
      return null;
    }
  }
  return path.resolve(homeDir(), ...parts.slice(1));
}

function allowedConfigDestinations() {
  return new Set(
    Object.keys(TARGETS)
      .flatMap((targetId) => targetConfigPaths(targetId))
      .map((filePath) => path.resolve(filePath)),
  );
}

function configStatus() {
  return Object.fromEntries(Object.entries(TARGETS).map(([id, target]) => {
    const configPaths = targetConfigPaths(id);
    const files = configPaths.map((resolvedPath) => {
      return {
        path: displayConfigPath(resolvedPath),
        resolvedPath,
        exists: fsSync.existsSync(resolvedPath),
      };
    });
    return [id, { ...target, configPaths: configPaths.map(displayConfigPath), files }];
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
  const [settingsPath] = targetConfigPaths('claude');
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
  const mappedModels = {
    ANTHROPIC_MODEL: provider.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: provider.modelMapping?.sonnet || provider.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: provider.modelMapping?.opus || provider.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.modelMapping?.haiku || provider.model,
  };
  for (const [key, value] of Object.entries(mappedModels)) {
    if (value) env[key] = value;
    else delete env[key];
  }

  const nextSettings = {
    ...settings,
    env,
  };
  await writeJsonFile(settingsPath, nextSettings);
  return [settingsPath];
}

async function applyCodexProvider(provider) {
  const [authPath, configPath] = targetConfigPaths('codex');
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
    const error = new Error(`Codex 配置中已存在 model_providers.${providerKey}，请修改 Leoapi 接口名称后重试。`);
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
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function serializeEnvValue(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(text) ? text : JSON.stringify(text);
}

function updateManagedEnv(content, updates) {
  const source = String(content || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();
  const pending = new Map(Object.entries(updates));
  const output = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      output.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value != null && value !== '') {
      output.push(`${key}=${serializeEnvValue(value)}`);
    }
  }

  for (const [key, value] of pending) {
    if (value != null && value !== '') {
      output.push(`${key}=${serializeEnvValue(value)}`);
    }
  }
  return `${output.join(newline)}${output.length || hadTrailingNewline ? newline : ''}`;
}

async function applyGeminiProvider(provider) {
  const [envPath] = targetConfigPaths('gemini');
  await backupFile(envPath);
  let existing = '';
  try {
    existing = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const next = updateManagedEnv(existing, {
    GEMINI_API_KEY: provider.apiKey || null,
    GOOGLE_API_KEY: provider.apiKey || null,
    GOOGLE_GEMINI_BASE_URL: provider.baseUrl || null,
    GEMINI_MODEL: provider.model || null,
  });
  await atomicWrite(envPath, next);
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
  const [configPath] = targetConfigPaths('opencode');
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
  const [configPath] = targetConfigPaths('hermes');
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
  const filePaths = targetConfigPaths(provider.target);
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
    const [claudeSettingsPath] = targetConfigPaths('claude');
    const claudeSettings = await readJsonFile(claudeSettingsPath, null);
    const env = claudeSettings?.env;
    if (env && typeof env === 'object') {
      const provider = normalizeProvider({
        id: 'claude-current',
        target: 'claude',
        name: 'Claude Code 当前配置',
        baseUrl: env.ANTHROPIC_BASE_URL || '',
        apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        modelMapping: {
          sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL || '',
          opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '',
          haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL || '',
        },
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
    const [codexAuthPath, codexConfigPath] = targetConfigPaths('codex');
    const auth = await readJsonFile(codexAuthPath, {});
    let config = '';
    try {
      config = await fs.readFile(codexConfigPath, 'utf8');
    } catch {
      config = '';
    }
    const parsed = config ? TOML.parse(config) : {};
    const activeProviderId = typeof parsed.model_provider === 'string' ? parsed.model_provider : '';
    const configuredProviders = parsed.model_providers && typeof parsed.model_providers === 'object'
      ? parsed.model_providers
      : {};
    const providerConfig = activeProviderId && configuredProviders[activeProviderId]
      && typeof configuredProviders[activeProviderId] === 'object'
      ? configuredProviders[activeProviderId]
      : null;
    const baseUrl = typeof providerConfig?.base_url === 'string' ? providerConfig.base_url : '';
    const model = typeof parsed.model === 'string' ? parsed.model : '';
    const wireApi = providerConfig?.wire_api === 'chat' ? 'chat' : 'responses';
    if (auth.OPENAI_API_KEY || baseUrl || model) {
      const provider = normalizeProvider({
        id: 'codex-current',
        target: 'codex',
        name: 'Codex 当前配置',
        baseUrl,
        apiKey: auth.OPENAI_API_KEY || '',
        model,
        wireApi,
        category: 'imported',
      }, store.providers.find((item) => item.id === 'codex-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const [geminiEnvPath] = targetConfigPaths('gemini');
    const env = parseEnv(await fs.readFile(geminiEnvPath, 'utf8'));
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
    const [opencodeConfigPath] = targetConfigPaths('opencode');
    const opencode = await readJsonFile(opencodeConfigPath, {});
    const configuredProviders = opencode.provider && typeof opencode.provider === 'object' ? opencode.provider : {};
    const configuredModel = typeof opencode.model === 'string' ? opencode.model : '';
    const modelSeparator = configuredModel.indexOf('/');
    const activeProviderId = modelSeparator > 0 ? configuredModel.slice(0, modelSeparator) : '';
    const activeProviderConfig = activeProviderId && configuredProviders[activeProviderId]
      && typeof configuredProviders[activeProviderId] === 'object'
      ? configuredProviders[activeProviderId]
      : null;
    const [fallbackProviderId, fallbackProviderConfig] = Object.entries(configuredProviders)[0] || [];
    const providerId = activeProviderConfig ? activeProviderId : fallbackProviderId;
    const providerConfig = activeProviderConfig || fallbackProviderConfig;
    if (providerId && providerConfig && typeof providerConfig === 'object') {
      const modelFromConfig = activeProviderConfig && modelSeparator > 0
        ? configuredModel.slice(modelSeparator + 1)
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
    const [hermesConfigPath] = targetConfigPaths('hermes');
    const hermes = await fs.readFile(hermesConfigPath, 'utf8');
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

function chooseActiveProvider(providers, target, predicate, preferredId) {
  const matches = providers.filter((provider) => provider.target === target && predicate(provider));
  return matches.find((provider) => provider.id === preferredId)?.id || matches[0]?.id || null;
}

function matchesCurrentValues(provider, current) {
  return safeText(provider.baseUrl, 800) === safeText(current.baseUrl, 800)
    && safeText(provider.apiKey, 4000) === safeText(current.apiKey, 4000)
    && safeText(provider.model, 200) === safeText(current.model, 200);
}

async function detectActiveByTarget(providers, lastAppliedByTarget = {}) {
  const active = {};

  try {
    const [settingsPath] = targetConfigPaths('claude');
    const settings = await readJsonFile(settingsPath, null);
    if (settings?.env && typeof settings.env === 'object') {
      const current = {
        baseUrl: settings.env.ANTHROPIC_BASE_URL || '',
        apiKey: settings.env.ANTHROPIC_AUTH_TOKEN || settings.env.ANTHROPIC_API_KEY || '',
        model: settings.env.ANTHROPIC_MODEL || settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
      };
      const match = chooseActiveProvider(
        providers,
        'claude',
        (provider) => matchesCurrentValues(provider, current),
        lastAppliedByTarget.claude,
      );
      if (match) active.claude = match;
    }
  } catch {
    // A single unreadable tool config must not hide the other active targets.
  }

  try {
    const [authPath, configPath] = targetConfigPaths('codex');
    const [auth, config] = await Promise.all([
      readJsonFile(authPath, {}),
      fs.readFile(configPath, 'utf8').catch(() => ''),
    ]);
    let match = chooseActiveProvider(
      providers,
      'codex',
      (provider) => config.includes(`model_provider = "leocodebox_${sanitizeIdPart(provider.id)}"`),
      lastAppliedByTarget.codex,
    );
    if (!match && (auth.OPENAI_API_KEY || config)) {
      const current = {
        baseUrl: config.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || '',
        apiKey: auth.OPENAI_API_KEY || '',
        model: config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '',
      };
      match = chooseActiveProvider(
        providers,
        'codex',
        (provider) => matchesCurrentValues(provider, current),
        lastAppliedByTarget.codex,
      );
    }
    if (match) active.codex = match;
  } catch {
    // Best-effort detection.
  }

  try {
    const [geminiEnvPath] = targetConfigPaths('gemini');
    const env = parseEnv(await fs.readFile(geminiEnvPath, 'utf8'));
    const current = {
      baseUrl: env.GOOGLE_GEMINI_BASE_URL || '',
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
      model: env.GEMINI_MODEL || '',
    };
    const match = chooseActiveProvider(
      providers,
      'gemini',
      (provider) => matchesCurrentValues(provider, current),
      lastAppliedByTarget.gemini,
    );
    if (match) active.gemini = match;
  } catch {
    // Best-effort detection.
  }

  try {
    const [configPath] = targetConfigPaths('opencode');
    const config = await readJsonFile(configPath, {});
    const match = chooseActiveProvider(providers, 'opencode', (provider) => {
      const key = `leocodebox_${sanitizeIdPart(provider.id)}`;
      return Boolean(config.provider?.[key]) || String(config.model || '').startsWith(`${key}/`);
    }, lastAppliedByTarget.opencode);
    if (match) active.opencode = match;
  } catch {
    // Best-effort detection.
  }

  try {
    const [hermesConfigPath] = targetConfigPaths('hermes');
    const config = await fs.readFile(hermesConfigPath, 'utf8');
    const match = chooseActiveProvider(providers, 'hermes', (provider) => {
      const key = `leocodebox_${sanitizeIdPart(provider.id)}`;
      return config.includes(`provider: "${key}"`) || config.includes(`name: "${key}"`);
    }, lastAppliedByTarget.hermes);
    if (match) active.hermes = match;
  } catch {
    // Best-effort detection.
  }

  return active;
}

function upsertProviderInStore(store, provider) {
  const index = store.providers.findIndex((item) => item.id === provider.id);
  if (index === -1) {
    store.providers.push(provider);
  } else {
    store.providers[index] = provider;
  }
}

// Maps one legacy switch `providers` row (app_type + settings_config JSON)
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
  let modelMapping = null;

  if (target === 'claude') {
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || (typeof settings.model === 'string' ? settings.model : '');
    modelMapping = {
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || model,
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || model,
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || model,
    };
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
    ...(modelMapping ? { modelMapping } : {}),
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

function appendApiPath(baseUrl, suffix) {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(base) && suffix.startsWith('/v1/')) {
    return `${base}${suffix.slice(3)}`;
  }
  return `${base}${suffix}`;
}

function buildProviderProbe(provider, rawBase) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'leocodebox-connectivity-check',
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  if (provider.target === 'claude') {
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url: appendApiPath(rawBase, '/v1/messages'),
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model || 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
    };
  }

  if (provider.target === 'gemini' && /generativelanguage\.googleapis\.com/i.test(rawBase)) {
    const url = new URL(appendApiPath(rawBase, '/models'));
    if (provider.apiKey) url.searchParams.set('key', provider.apiKey);
    delete headers.Authorization;
    return { url: url.toString(), method: 'GET', headers };
  }

  const base = rawBase.replace(/\/(?:responses|chat\/completions|models)\/?$/i, '');
  return { url: appendApiPath(base, '/models'), method: 'GET', headers };
}

function providerProbeNote(response) {
  if (response.ok) return { authStatus: 'accepted', note: '端点可达且认证通过。' };
  if (response.status === 401 || response.status === 403) {
    return { authStatus: 'rejected', note: `端点可达（HTTP ${response.status}），但凭据被拒绝。` };
  }
  if (response.status === 429) {
    return { authStatus: 'accepted', note: '端点可达且凭据未被拒绝，但当前请求受到限流。' };
  }
  if ([400, 422].includes(response.status)) {
    return { authStatus: 'accepted', note: `端点可达且凭据未被拒绝（HTTP ${response.status}），请检查模型名称或请求参数。` };
  }
  if ([404, 405].includes(response.status)) {
    return { authStatus: 'unknown', note: `端点可达（HTTP ${response.status}），但接口路径或协议不匹配。` };
  }
  if (response.status >= 500) {
    return { authStatus: 'unknown', note: `端点可达，但上游服务异常（HTTP ${response.status}）。` };
  }
  return { authStatus: 'unknown', note: `端点可达（HTTP ${response.status}）。` };
}

// Protocol-aware reachability, credential and latency probe. It sends at most
// one token for Anthropic-compatible endpoints when the upstream accepts it.
async function testProviderConnectivity(provider) {
  const rawBase = safeText(provider.baseUrl, 800);
  if (!rawBase) {
    return { reachable: false, latencyMs: null, httpStatus: null, note: '未配置 Base URL，无法测试连通性。' };
  }

  const validatedBase = validateProviderBaseUrl(rawBase);
  const probe = buildProviderProbe(provider, validatedBase);

  const startedAt = Date.now();
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body,
      // Do not follow redirects: prevents a provider baseUrl from bouncing the
      // attached API key to a different host.
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - startedAt;
    const assessment = providerProbeNote(response);
    return {
      reachable: true,
      latencyMs,
      httpStatus: response.status,
      authStatus: assessment.authStatus,
      note: assessment.note,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      authStatus: 'unknown',
      note: error?.name === 'TimeoutError' ? '连接超时（8 秒）。' : `无法连接：${error?.message || '未知错误'}`,
    };
  }
}

function parseBoundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function validateProviderBaseUrl(rawBase) {
  let parsed;
  try {
    parsed = new URL(rawBase);
  } catch {
    const error = new Error('请求地址不是有效 URL。');
    error.statusCode = 400;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('请求地址仅支持 HTTP 或 HTTPS 协议。');
    error.statusCode = 400;
    throw error;
  }
  return parsed.toString().replace(/\/$/, '');
}

function buildModelListProbe(provider, rawBase) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'leocodebox-model-discovery',
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  if (provider.target === 'claude') {
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    return { url: appendApiPath(rawBase, '/v1/models'), headers };
  }

  if (provider.target === 'gemini' && /generativelanguage\.googleapis\.com/i.test(rawBase)) {
    const url = new URL(appendApiPath(rawBase, '/v1beta/models'));
    if (provider.apiKey) url.searchParams.set('key', provider.apiKey);
    delete headers.Authorization;
    return { url: url.toString(), headers };
  }

  const base = rawBase.replace(/\/(?:responses|chat\/completions|models)\/?$/i, '');
  return { url: appendApiPath(base, '/models'), headers };
}

function extractModelIds(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
  const models = [];
  for (const row of rows) {
    const rawId = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
    const id = safeText(rawId, 240).replace(/^models\//, '');
    if (id && !models.includes(id)) models.push(id);
    if (models.length >= 300) break;
  }
  return models.sort((left, right) => left.localeCompare(right));
}

async function discoverProviderModels(provider, options = {}) {
  const rawBase = safeText(options.baseUrl || provider.baseUrl, 800);
  if (!rawBase) {
    const error = new Error('请先填写请求地址。');
    error.statusCode = 400;
    throw error;
  }
  const validatedBase = validateProviderBaseUrl(rawBase);
  const cacheKey = modelDiscoveryCacheKey(provider, validatedBase);
  const now = Date.now();
  if (!options.bypassCache) {
    const memoryEntry = modelDiscoveryCache.get(cacheKey);
    if (memoryEntry?.expiresAt > now) {
      return { ...memoryEntry.result, cache: modelDiscoveryCacheInfo(memoryEntry, 'memory') };
    }
    const diskEntries = await loadModelDiscoveryDiskCache();
    const diskEntry = diskEntries[cacheKey];
    if (diskEntry?.expiresAt > now && Array.isArray(diskEntry.result?.models)) {
      modelDiscoveryCache.set(cacheKey, diskEntry);
      return { ...diskEntry.result, cache: modelDiscoveryCacheInfo(diskEntry, 'disk') };
    }
  }
  const pending = pendingModelDiscoveries.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const timeoutMs = parseBoundedInteger(options.timeoutMs, 8000, 1000, 30000);
    const probe = buildModelListProbe(provider, validatedBase);
    const startedAt = Date.now();
    const response = await fetch(probe.url, {
      method: 'GET',
      headers: probe.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = safeText(payload?.error?.message || payload?.message, 300);
      const error = new Error(message || `模型列表读取失败（HTTP ${response.status}）。`);
      error.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
      error.details = { latencyMs, httpStatus: response.status };
      throw error;
    }
    const result = {
      models: extractModelIds(payload),
      latencyMs,
      httpStatus: response.status,
      endpoint: validatedBase,
    };
    const entry = {
      updatedAt: Date.now(),
      expiresAt: Date.now() + MODEL_DISCOVERY_CACHE_TTL_MS,
      result,
    };
    modelDiscoveryCache.set(cacheKey, entry);
    try {
      await persistModelDiscoveryCache();
    } catch (error) {
      console.warn('Unable to persist model discovery cache:', error);
    }
    return { ...result, cache: modelDiscoveryCacheInfo(entry, 'fresh') };
  })().finally(() => pendingModelDiscoveries.delete(cacheKey));
  pendingModelDiscoveries.set(cacheKey, request);
  return request;
}

function buildModelBenchmarkProbe(provider, model) {
  const rawBase = safeText(provider.baseUrl, 800);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'leocodebox-model-benchmark',
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  if (provider.target === 'claude') {
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url: appendApiPath(rawBase, '/v1/messages'),
      headers,
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] },
    };
  }

  if (provider.target === 'gemini' && /generativelanguage\.googleapis\.com/i.test(rawBase)) {
    const url = new URL(appendApiPath(rawBase, `/v1beta/models/${encodeURIComponent(model)}:generateContent`));
    if (provider.apiKey) url.searchParams.set('key', provider.apiKey);
    delete headers.Authorization;
    return {
      url: url.toString(),
      headers,
      body: { contents: [{ parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 1 } },
    };
  }

  const base = rawBase.replace(/\/(?:responses|chat\/completions)\/?$/i, '');
  if (provider.wireApi === 'responses') {
    return {
      url: appendApiPath(base, '/responses'),
      headers,
      body: { model, input: 'Reply with OK.', max_output_tokens: 1 },
    };
  }
  return {
    url: appendApiPath(base, '/chat/completions'),
    headers,
    body: { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 },
  };
}

async function benchmarkProviderModel(provider, options = {}) {
  const model = safeText(options.model || provider.model, 240);
  if (!provider.baseUrl || !model) {
    const error = new Error('测速前需要填写请求地址和模型名称。');
    error.statusCode = 400;
    throw error;
  }
  validateProviderBaseUrl(provider.baseUrl);
  const attempts = parseBoundedInteger(options.attempts, 1, 1, 5);
  const timeoutMs = parseBoundedInteger(options.timeoutMs, 8000, 1000, 30000);
  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = buildModelBenchmarkProbe(provider, model);
    const startedAt = Date.now();
    try {
      const response = await fetch(probe.url, {
        method: 'POST',
        headers: probe.headers,
        body: JSON.stringify(probe.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - startedAt;
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      results.push({
        attempt,
        ok: response.ok,
        latencyMs,
        httpStatus: response.status,
        error: response.ok ? null : safeText(payload?.error?.message || payload?.message || `HTTP ${response.status}`, 300),
      });
    } catch (error) {
      results.push({
        attempt,
        ok: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: null,
        error: error?.name === 'TimeoutError' ? `超过 ${timeoutMs} ms` : safeText(error?.message || '连接失败', 300),
      });
    }
  }
  const successful = results.filter((result) => result.ok);
  const latencies = successful.map((result) => result.latencyMs);
  return {
    model,
    attempts,
    successCount: successful.length,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    minimumLatencyMs: latencies.length ? Math.min(...latencies) : null,
    maximumLatencyMs: latencies.length ? Math.max(...latencies) : null,
    results,
  };
}

async function testProviderEndpoints(provider, options = {}) {
  const endpoints = normalizeEndpointUrls(
    { endpoints: Array.isArray(options.endpoints) ? options.endpoints : provider.endpoints },
    provider,
    provider.baseUrl,
  );
  const timeoutMs = parseBoundedInteger(options.timeoutMs, 8000, 1000, 30000);
  const results = [];
  for (const endpoint of endpoints) {
    const validatedEndpoint = validateProviderBaseUrl(endpoint);
    const probe = buildModelListProbe(provider, validatedEndpoint);
    const startedAt = Date.now();
    try {
      const response = await fetch(probe.url, {
        method: 'GET',
        headers: probe.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const assessment = providerProbeNote(response);
      results.push({
        url: endpoint,
        reachable: true,
        usable: assessment.authStatus !== 'rejected' && response.status < 500 && ![404, 405].includes(response.status),
        latencyMs: Date.now() - startedAt,
        httpStatus: response.status,
        authStatus: assessment.authStatus,
        note: assessment.note,
      });
    } catch (error) {
      results.push({
        url: endpoint,
        reachable: false,
        usable: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: null,
        authStatus: 'unknown',
        note: error?.name === 'TimeoutError' ? `超过 ${timeoutMs} ms` : safeText(error?.message || '连接失败', 300),
      });
    }
  }
  return results;
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
  const repoPath = parseRepositoryUrl(pkg.repository) || 'leoyb1010/leocodebox';
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
  };

  try {
    const release = await fetchJson(`https://api.github.com/repos/${repoPath}/releases/latest`);
    result.own.latest = release.tag_name || release.name || null;
    result.own.url = release.html_url || result.own.url;
    result.own.updateAvailable = Boolean(currentVersion && result.own.latest && compareSemver(result.own.latest, currentVersion) > 0);
  } catch (error) {
    result.own.error = error.statusCode === 404
      ? 'Private release metadata is unavailable here. Check updates in Settings > About.'
      : error.message;
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
    install: { command: 'npm', args: ['install', '--global', '@anthropic-ai/claude-code'] },
    npmPackage: '@anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@openai/codex'] },
    npmPackage: '@openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    cmd: 'opencode',
    // Update selection is resolved from the executable's verified install source.
    updateArgs: null,
    install: { command: 'npm', args: ['install', '--global', 'opencode-ai'] },
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
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    cmd: 'gemini',
    updateArgs: null,
    install: { command: 'npm', args: ['install', '--global', '@google/gemini-cli'] },
    npmPackage: '@google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    cmd: 'hermes',
    updateArgs: null,
    npmPackage: null,
    docsUrl: 'https://hermes-agent.nousresearch.com',
  },
};

function parseCliVersionText(output) {
  if (!output) return null;
  const match = String(output).match(CLI_VERSION_TOKEN);
  return match ? match[1] : null;
}

export async function resolveExecutablePath(command) {
  const result = await runCliCommand('which', [command], 5000);
  if (!result.ok) return null;
  const executablePath = result.stdout.trim().split(/\r?\n/)[0];
  if (!executablePath) return null;
  try {
    return await fs.realpath(executablePath);
  } catch {
    return executablePath;
  }
}

export async function detectCliInstallSource(tool, resolvePath = resolveExecutablePath) {
  const executablePath = await resolvePath(tool.cmd);
  if (!executablePath) return { source: 'unknown', executablePath: null };
  const normalized = executablePath.replaceAll('\\', '/');
  if (/(^|\/)(Cellar|homebrew)(\/|$)/i.test(normalized)) {
    return { source: 'homebrew', executablePath };
  }
  if (/(^|\/)(pnpm|pnpm-global)(\/|$)/i.test(normalized)) {
    return { source: 'pnpm', executablePath };
  }
  if (/(^|\/)\.volta(\/|$)/i.test(normalized)) {
    return { source: 'volta', executablePath };
  }
  if (/(^|\/)(lib\/node_modules|\.npm-global|npm\/bin)(\/|$)/i.test(normalized)) {
    return { source: 'npm-global', executablePath };
  }
  if (normalized.includes('.app/Contents/')) {
    return { source: 'app-bundled', executablePath };
  }
  if (/(^|\/)\.local\/(bin|share\/claude)(\/|$)/i.test(normalized)) {
    return { source: 'standalone', executablePath };
  }
  return { source: 'unknown', executablePath };
}

export async function resolveCliUpdateCommand(tool, source) {
  if (source === 'npm-global' && tool.npmPackage) {
    return { command: 'npm', args: ['install', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'homebrew') {
    const formulaById = { opencode: 'opencode' };
    const formula = formulaById[tool.id];
    if (formula) return { command: 'brew', args: ['upgrade', formula] };
  }
  if (source === 'pnpm' && tool.npmPackage) {
    return { command: 'pnpm', args: ['add', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'volta' && tool.npmPackage) {
    return { command: 'volta', args: ['install', `${tool.npmPackage}@latest`] };
  }
  if (source === 'standalone' && Array.isArray(tool.updateArgs)) {
    return { command: tool.cmd, args: tool.updateArgs };
  }
  return null;
}

export async function withCliMutation(toolId, operation) {
  if (pendingCliMutations.has(toolId)) {
    const error = new Error(`CLI operation already in progress for ${toolId}.`);
    error.statusCode = 409;
    throw error;
  }
  const request = Promise.resolve().then(operation);
  pendingCliMutations.set(toolId, request);
  try {
    return await request;
  } finally {
    if (pendingCliMutations.get(toolId) === request) pendingCliMutations.delete(toolId);
  }
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
  const installed = probe.code !== 'ENOENT';
  const runnable = probe.ok;
  const currentVersion = runnable ? parseCliVersionText(probe.stdout || probe.stderr) : null;
  const latestVersion = checkLatest && runnable ? await readCliLatestVersion(tool) : null;
  const updateAvailable = Boolean(
    currentVersion && latestVersion && compareSemver(latestVersion, currentVersion) > 0,
  );
  const installInfo = installed
    ? await detectCliInstallSource(tool)
    : { source: 'not-installed', executablePath: null };
  const updateCommand = runnable ? await resolveCliUpdateCommand(tool, installInfo.source) : null;
  return {
    id: tool.id,
    label: tool.label,
    command: tool.cmd,
    installed,
    runnable,
    error: runnable ? null : (probe.stderr || probe.error || `${tool.cmd} could not run`).trim(),
    currentVersion,
    latestVersion,
    updateAvailable,
    installSource: installInfo.source,
    executablePath: installInfo.executablePath,
    canInstall: !installed && Boolean(tool.install),
    canSelfUpdate: runnable && Boolean(updateCommand),
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

router.post('/cli/:id/install', async (req, res, next) => {
  try {
    if (process.env.LEOCODEBOX_LOCAL_ONLY !== '1' && !process.env.LEOCODEBOX_TEST_HOME) {
      res.status(403).json({ success: false, error: 'CLI installs are available only in local-only mode.' });
      return;
    }
    const tool = CLI_TOOLS[String(req.params.id || '').toLowerCase()];
    if (!tool) {
      res.status(404).json({ success: false, error: 'Unknown CLI tool.' });
      return;
    }
    if (!tool.install) {
      res.status(409).json({ success: false, error: `${tool.label} 没有经过验证的一键安装方式。` });
      return;
    }
    const payload = await withCliMutation(tool.id, async () => {
      const before = await getCliToolStatus(tool, { checkLatest: false });
      if (before.installed) {
        const error = new Error(`${tool.label} 已安装。`);
        error.statusCode = 409;
        throw error;
      }
      const result = await runCliCommand(tool.install.command, tool.install.args, 300_000);
      const after = await getCliToolStatus(tool, { checkLatest: false });
      return {
        success: result.ok && after.installed,
        tool: tool.id,
        currentVersion: after.currentVersion,
        installSource: after.installSource,
        output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000),
        error: result.ok && after.installed ? null : (result.error || 'Install command failed.'),
      };
    });
    res.json(payload);
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
    const payload = await withCliMutation(tool.id, async () => {
      const before = await getCliToolStatus(tool, { checkLatest: false });
      if (!before.installed) {
        const error = new Error(`${tool.label} CLI is not installed.`);
        error.statusCode = 409;
        throw error;
      }
      const updateCommand = await resolveCliUpdateCommand(tool, before.installSource);
      if (!updateCommand) {
        const error = new Error(`${tool.label} 的安装来源为 ${before.installSource}，无法安全自动更新。`);
        error.statusCode = 409;
        throw error;
      }
      const result = await runCliCommand(updateCommand.command, updateCommand.args, 180_000);
      const after = await getCliToolStatus(tool, { checkLatest: false });
      return {
        success: result.ok,
        tool: tool.id,
        previousVersion: before.currentVersion,
        currentVersion: after.currentVersion,
        changed: before.currentVersion !== after.currentVersion,
        output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000),
        error: result.ok ? null : (result.error || 'Update command failed.'),
      };
    });
    res.json(payload);
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
    const activeByTarget = await detectActiveByTarget(store.providers, store.activeByTarget);
    await Promise.all(Object.keys(activeByTarget).map((target) => (
      TARGETS[target]?.writable ? ensureDefaultSnapshot(target, store) : Promise.resolve()
    )));
    const nativeAvailableByTarget = Object.fromEntries(await Promise.all(
      Object.values(TARGETS).map(async (target) => [
        target.id,
        target.writable && await fileExists(defaultSnapshotPath(target.id)),
      ]),
    ));
    res.json({
      success: true,
      targets: configStatus(),
      presets: PROVIDER_TEMPLATES,
      activeByTarget,
      nativeAvailableByTarget,
      lastAppliedByTarget: store.activeByTarget,
      providers: store.providers.map(sanitizeProvider),
      storePath: providerStorePath(),
    });
  } catch (error) {
    next(error);
  }
});

function validateProviderDestinations(provider) {
  if (provider.baseUrl) validateProviderBaseUrl(provider.baseUrl);
  for (const endpoint of normalizeEndpointUrls(provider, provider, provider.baseUrl)) {
    validateProviderBaseUrl(endpoint);
  }
}

function providerCredentialDestinationFingerprint(provider) {
  const endpoints = normalizeEndpointUrls(provider, provider, provider.baseUrl)
    .map((endpoint) => validateProviderBaseUrl(endpoint))
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    target: provider.target,
    baseUrl: provider.baseUrl ? validateProviderBaseUrl(provider.baseUrl) : '',
    wireApi: provider.wireApi,
    endpoints,
  })).digest('hex');
}

function providerDiscoveryConfigFingerprint(provider) {
  return crypto.createHash('sha256').update(JSON.stringify({
    target: provider.target,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    wireApi: provider.wireApi,
  })).digest('hex');
}

function scheduleProviderModelDiscovery(provider, timeoutMs) {
  const providerId = provider.id;
  const expectedFingerprint = providerDiscoveryConfigFingerprint(provider);
  void discoverProviderModels(provider, { bypassCache: true, timeoutMs }).then(async (discovery) => {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const latestProvider = store.providers.find((item) => item.id === providerId);
      if (!latestProvider || providerDiscoveryConfigFingerprint(latestProvider) !== expectedFingerprint) return;
      latestProvider.discoveredModels = discovery.models;
      latestProvider.modelDiscovery = {
        endpoint: discovery.endpoint,
        updatedAt: discovery.cache.updatedAt,
        expiresAt: discovery.cache.expiresAt,
      };
      latestProvider.modelDiscoveryError = '';
      if (!latestProvider.model && discovery.models[0]) {
        latestProvider.model = discovery.models[0];
        latestProvider.modelMapping = normalizeModelMapping({}, latestProvider, latestProvider.model);
      }
      latestProvider.updatedAt = nowIso();
      await writeStore(store);
    });
  }).catch(async (error) => {
    console.warn(`Provider model discovery failed for ${providerId}:`, error);
    await withSwitchMutation(async () => {
      const store = await readStore();
      const latestProvider = store.providers.find((item) => item.id === providerId);
      if (!latestProvider || providerDiscoveryConfigFingerprint(latestProvider) !== expectedFingerprint) return;
      latestProvider.modelDiscoveryError = safeText(error?.message || '未知错误', 500);
      latestProvider.updatedAt = nowIso();
      await writeStore(store);
    });
  });
}

router.post('/switch/providers', async (req, res, next) => {
  try {
    const provider = await withSwitchMutation(async () => {
      const store = await readStore();
      const existing = req.body?.id ? store.providers.find((item) => item.id === req.body.id) : null;
      const savedProvider = normalizeProvider(req.body, existing);
      validateProviderDestinations(savedProvider);
      if (existing?.apiKey && savedProvider.apiKey === existing.apiKey
        && providerCredentialDestinationFingerprint(savedProvider) !== providerCredentialDestinationFingerprint(existing)) {
        const error = new Error('修改请求地址、协议或端点时必须重新输入 API Key。');
        error.statusCode = 400;
        throw error;
      }
      upsertProviderInStore(store, savedProvider);
      await writeStore(store);
      return savedProvider;
    });

    const shouldDiscover = req.body?.autoDiscover === true && provider.baseUrl && provider.apiKey;
    res.json({
      success: true,
      provider: sanitizeProvider(provider),
      discovery: shouldDiscover ? 'pending' : null,
      warning: null,
    });
    if (shouldDiscover) scheduleProviderModelDiscovery(provider, req.body?.timeoutMs);
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

      await ensureDefaultSnapshot(provider.target, store);
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
        activeModel: provider.target === 'opencode' && provider.model
          ? `leocodebox_${sanitizeIdPart(provider.id)}/${provider.model}`
          : provider.model || null,
        changedFiles,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/targets/:target/restore-default', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const target = normalizeTarget(req.params.target);
      if (!target || !TARGETS[target].writable) {
        res.status(400).json({ success: false, error: 'This target does not support configuration restore.' });
        return;
      }
      const snapshots = await readDefaultSnapshot(target);
      if (!snapshots) {
        res.status(404).json({ success: false, error: '尚未保存本机原配置。首次启用自定义接口时会自动保存。' });
        return;
      }

      const current = await captureFiles(targetConfigPaths(target));
      try {
        for (const filePath of targetConfigPaths(target)) await backupFile(filePath);
        await restoreFiles(snapshots);
        const store = await readStore();
        delete store.activeByTarget[target];
        await writeStore(store);
        res.json({
          success: true,
          target,
          restoredFiles: snapshots.map((snapshot) => displayConfigPath(snapshot.filePath)),
          activeByTarget: store.activeByTarget,
        });
      } catch (error) {
        await restoreFiles(current);
        throw error;
      }
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
        res.status(404).json({ success: false, error: '未找到旧切换器数据库（~/.cc-switch/cc-switch.db）。' });
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

router.post('/switch/discover-models', async (req, res, next) => {
  try {
    let apiKey = req.body?.apiKey;
    if (!apiKey && req.body?.useStoredKey === true && req.body?.providerId) {
      const store = await readStore();
      const storedProvider = store.providers.find((item) => item.id === req.body.providerId);
      if (!storedProvider) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }
      const draftDestination = normalizeProvider({
        ...storedProvider,
        target: req.body?.target,
        baseUrl: req.body?.baseUrl,
        wireApi: req.body?.wireApi,
        apiKey: storedProvider.apiKey,
      }, storedProvider);
      if (providerCredentialDestinationFingerprint(draftDestination) !== providerCredentialDestinationFingerprint(storedProvider)) {
        res.status(400).json({ success: false, error: '修改请求地址或协议后必须重新输入 API Key。' });
        return;
      }
      apiKey = storedProvider.apiKey || '';
    }
    const provider = normalizeProvider({
      id: 'draft-model-discovery',
      name: 'Draft',
      target: req.body?.target,
      baseUrl: req.body?.baseUrl,
      apiKey,
      wireApi: req.body?.wireApi,
    });
    const result = await discoverProviderModels(provider, {
      baseUrl: req.body?.baseUrl,
      timeoutMs: req.body?.timeoutMs,
      bypassCache: req.body?.bypassCache === true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/models', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found.' });
      return;
    }
    const result = await discoverProviderModels(provider, {
      timeoutMs: req.body?.timeoutMs,
      bypassCache: true,
    });
    await withSwitchMutation(async () => {
      const latestStore = await readStore();
      const latestProvider = latestStore.providers.find((item) => item.id === req.params.id);
      if (!latestProvider) return;
      latestProvider.discoveredModels = result.models;
      latestProvider.modelDiscovery = {
        endpoint: result.endpoint,
        updatedAt: result.cache.updatedAt,
        expiresAt: result.cache.expiresAt,
      };
      latestProvider.modelDiscoveryError = '';
      latestProvider.updatedAt = nowIso();
      await writeStore(latestStore);
    });
    res.json({ success: true, provider: provider.id, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/benchmark', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found.' });
      return;
    }
    const result = await benchmarkProviderModel(provider, req.body || {});
    res.json({ success: true, provider: provider.id, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/endpoints/test', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const provider = store.providers.find((item) => item.id === req.params.id);
      if (!provider) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }
      const requestedEndpoints = Array.isArray(req.body?.endpoints)
        ? req.body.endpoints.map((endpoint) => safeText(typeof endpoint === 'string' ? endpoint : endpoint?.url, 800).replace(/\/+$/, '')).filter(Boolean)
        : provider.endpoints;
      const persistedEndpoints = new Set(normalizeEndpointUrls(provider, provider, provider.baseUrl));
      const untrustedEndpoint = requestedEndpoints.find((endpoint) => !persistedEndpoints.has(endpoint));
      if (untrustedEndpoint) {
        res.status(400).json({ success: false, error: '测试新端点前必须编辑 Provider 并重新输入 API Key。' });
        return;
      }
      if (requestedEndpoints?.length && !requestedEndpoints.includes(provider.baseUrl)) {
        provider.baseUrl = requestedEndpoints[0];
      }
      const endpoints = normalizeEndpointUrls({ endpoints: requestedEndpoints }, provider, provider.baseUrl);
      const results = await testProviderEndpoints(provider, { ...req.body, endpoints });
      const autoSelectEndpoint = typeof req.body?.autoSelectEndpoint === 'boolean'
        ? req.body.autoSelectEndpoint
        : Boolean(provider.autoSelectEndpoint);
      const fastest = results
        .filter((result) => result.usable)
        .sort((left, right) => left.latencyMs - right.latencyMs)[0] || null;
      provider.endpoints = endpoints;
      provider.autoSelectEndpoint = autoSelectEndpoint;
      provider.endpointStats = Object.fromEntries(results.map((result) => [result.url, {
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        authStatus: result.authStatus,
        usable: result.usable,
        testedAt: nowIso(),
      }]));
      if (autoSelectEndpoint && fastest) provider.baseUrl = fastest.url;
      provider.updatedAt = nowIso();
      await writeStore(store);
      res.json({
        success: true,
        provider: sanitizeProvider(provider),
        selectedBaseUrl: provider.baseUrl,
        results,
      });
    });
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
          const relativePath = path.relative(root, filePath);
          const targetPath = resolveBackupDestination(relativePath);
          backups.push({
            path: filePath,
            relativePath,
            targetPath: targetPath ? displayConfigPath(targetPath) : null,
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

      const destination = resolveBackupDestination(relativePath);
      if (!destination) {
        const error = new Error('Backup path does not include a restorable config path.');
        error.statusCode = 400;
        throw error;
      }
      if (!allowedConfigDestinations().has(destination)) {
        const error = new Error('Backup destination is not a recognized local Agent config path.');
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
