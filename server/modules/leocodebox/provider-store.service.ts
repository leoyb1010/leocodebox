import crypto from 'node:crypto';

import { providerStorePath, switchDir, TARGETS } from './provider-switch.config.js';
import { ensureDir, nowIso, readJsonFile, safeText, writeJsonFile } from './provider-switch.storage.js';


type WireApi = 'responses' | 'chat';
type ProviderEndpoint = string | { url?: unknown };
type ProviderModelMapping = { sonnet: string; opus: string; haiku: string };
export type SwitchProvider = {
  id: string;
  target: string;
  name: string;
  baseUrl: string;
  endpoints: string[];
  autoSelectEndpoint: boolean;
  endpointStats: Record<string, unknown>;
  apiKey: string;
  model: string;
  discoveredModels: string[];
  modelDiscovery: Record<string, unknown> | null;
  modelDiscoveryError: string;
  modelMapping: ProviderModelMapping;
  wireApi: WireApi;
  notes: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  source: string;
};
export type SwitchProviderInput = Partial<Omit<SwitchProvider, 'endpoints' | 'modelMapping'>> & {
  endpoints?: ProviderEndpoint[];
  modelMapping?: Partial<ProviderModelMapping>;
};
export type ProviderStore = { providers: SwitchProvider[]; activeByTarget: Record<string, string> };
type StatusError = Error & { statusCode?: number };

let switchMutationQueue: Promise<unknown> = Promise.resolve();

export function normalizeTarget(target: unknown): string | null {
  const normalized = safeText(target).toLowerCase();
  return TARGETS[normalized] ? normalized : null;
}

export function normalizeWireApi(wireApi: unknown): WireApi {
  return wireApi === 'responses' || wireApi === 'chat' ? wireApi : 'responses';
}

export function sanitizeIdPart(value: unknown): string {
  const cleaned = safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'provider';
}

function redactSecret(value: unknown): string {
  const text = safeText(value, 500);
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

export function sanitizeProvider(provider: SwitchProvider): Omit<SwitchProvider, 'apiKey'> & { apiKey: string; hasApiKey: boolean } {
  return { ...provider, apiKey: provider.apiKey ? redactSecret(provider.apiKey) : '', hasApiKey: Boolean(provider.apiKey) };
}

export function normalizeEndpointUrls(input: SwitchProviderInput, existing: SwitchProvider | null, baseUrl: string): string[] {
  const source = Array.isArray(input?.endpoints)
    ? input.endpoints
    : Array.isArray(existing?.endpoints) ? existing.endpoints : [];
  const urls: string[] = [];
  for (const endpoint of source) {
    const url = safeText(typeof endpoint === 'string' ? endpoint : endpoint?.url, 800).replace(/\/+$/, '');
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 20) break;
  }
  const normalizedBase = safeText(baseUrl, 800).replace(/\/+$/, '');
  if (normalizedBase && !urls.includes(normalizedBase)) urls.unshift(normalizedBase);
  return urls;
}

export function normalizeModelMapping(input: SwitchProviderInput, existing: SwitchProvider | null, fallbackModel: string): ProviderModelMapping {
  const source = input?.modelMapping && typeof input.modelMapping === 'object'
    ? input.modelMapping
    : existing?.modelMapping && typeof existing.modelMapping === 'object' ? existing.modelMapping : {};
  return {
    sonnet: safeText(source.sonnet || fallbackModel, 240),
    opus: safeText(source.opus || fallbackModel, 240),
    haiku: safeText(source.haiku || fallbackModel, 240),
  };
}

export function normalizeProvider(input: SwitchProviderInput, existing: SwitchProvider | null = null): SwitchProvider {
  const target = normalizeTarget(input?.target || existing?.target);
  if (!target) {
    const error: StatusError = new Error('Unsupported provider target.');
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
    autoSelectEndpoint: typeof input?.autoSelectEndpoint === 'boolean' ? input.autoSelectEndpoint : Boolean(existing?.autoSelectEndpoint),
    endpointStats: existing?.endpointStats && typeof existing.endpointStats === 'object' ? existing.endpointStats : {},
    apiKey: nextApiKey,
    model,
    discoveredModels: Array.isArray(existing?.discoveredModels)
      ? existing.discoveredModels.map((item) => safeText(item, 240)).filter(Boolean).slice(0, 300)
      : [],
    modelDiscovery: existing?.modelDiscovery && typeof existing.modelDiscovery === 'object' ? existing.modelDiscovery : null,
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

export function withSwitchMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = switchMutationQueue.then(operation, operation);
  switchMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function readStore(): Promise<ProviderStore> {
  await ensureDir(switchDir());
  const store = await readJsonFile<ProviderStore>(providerStorePath(), { providers: [], activeByTarget: {} });
  return {
    providers: Array.isArray(store.providers) ? store.providers : [],
    activeByTarget: store.activeByTarget && typeof store.activeByTarget === 'object' ? store.activeByTarget : {},
  };
}

export async function writeStore(store: ProviderStore): Promise<void> {
  await writeJsonFile(providerStorePath(), store);
}

export function upsertProviderInStore(store: ProviderStore, provider: SwitchProvider): void {
  const index = store.providers.findIndex((item) => item.id === provider.id);
  if (index === -1) store.providers.push(provider);
  else store.providers[index] = provider;
}
