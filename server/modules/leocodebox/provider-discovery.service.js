import crypto from 'node:crypto';

import { providerModelCachePath } from './provider-switch.config.js';
import { normalizeEndpointUrls, normalizeWireApi } from './provider-store.service.js';
import { readJsonFile, safeText, writeJsonFile } from './provider-switch.storage.js';

const MODEL_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const modelDiscoveryCache = new Map();
const pendingModelDiscoveries = new Map();
let modelCacheMutationQueue = Promise.resolve();

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



export {
  benchmarkProviderModel,
  discoverProviderModels,
  parseBoundedInteger,
  testProviderConnectivity,
  testProviderEndpoints,
  validateProviderBaseUrl,
};
