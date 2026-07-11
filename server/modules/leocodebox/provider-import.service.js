import fs from 'node:fs/promises';
import path from 'node:path';

import TOML from '@iarna/toml';

import { parseEnv } from './provider-apply.service.js';
import { homeDir, TARGETS, targetConfigPaths } from './provider-switch.config.js';
import {
  normalizeProvider,
  normalizeTarget,
  sanitizeIdPart,
  upsertProviderInStore,
} from './provider-store.service.js';
import { fileExists, readJsonFile, safeText } from './provider-switch.storage.js';

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



export { detectActiveByTarget, importCcSwitchProviders, importCurrentProviders };
