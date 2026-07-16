import { readStore } from './provider-store.service.js';

/**
 * Env overlay that makes the active Leoapi provider authoritative for
 * sessions started by this app.
 *
 * Why: agent CLIs give process env vars precedence over their config files.
 * A machine where something else exported ANTHROPIC_ / OPENAI_ vars into the
 * login shell (another switcher like cc-switch, or manual rc exports) would
 * silently override everything Leoapi writes to settings.json / auth.json —
 * the switch would look applied but every session kept using the old values.
 *
 * Semantics: overlay ONLY when a Leoapi provider is active for the target.
 * With nothing active, the machine's own configuration (including shell
 * exports) stays in charge, which is exactly the "本机原配置" contract.
 */
export async function getActiveSwitchEnvOverlay(target: 'claude' | 'codex'): Promise<Record<string, string>> {
  try {
    const store = await readStore();
    const activeId = store.activeByTarget?.[target];
    if (!activeId) return {};
    const provider = store.providers.find((item) => item.id === activeId);
    if (!provider) return {};

    if (target === 'claude') {
      const overlay: Record<string, string> = {};
      if (provider.baseUrl) overlay.ANTHROPIC_BASE_URL = provider.baseUrl;
      if (provider.apiKey) {
        overlay.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
        overlay.ANTHROPIC_API_KEY = provider.apiKey;
      }
      if (provider.model) overlay.ANTHROPIC_MODEL = provider.model;
      const mapping = provider.modelMapping || {};
      const sonnet = mapping.sonnet || provider.model;
      const opus = mapping.opus || provider.model;
      const haiku = mapping.haiku || provider.model;
      if (sonnet) overlay.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
      if (opus) overlay.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
      if (haiku) overlay.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
      return overlay;
    }

    // codex reads endpoints from config.toml (which Leoapi writes), but an
    // inherited OPENAI_API_KEY from the shell would still win over auth.json.
    const overlay: Record<string, string> = {};
    if (provider.apiKey) overlay.OPENAI_API_KEY = provider.apiKey;
    return overlay;
  } catch {
    // A broken switch store must never block session startup.
    return {};
  }
}

/**
 * Every env var the active provider "owns" for a target. Used to clear stale
 * inherited values (e.g. exports left in the login shell by another switcher
 * like cc-switch) so ONLY the active provider's values reach the agent CLI.
 */
const MANAGED_SWITCH_ENV_KEYS: Record<'claude' | 'codex', readonly string[]> = {
  claude: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ],
  codex: ['OPENAI_API_KEY'],
};

/**
 * Make the active Leoapi provider AUTHORITATIVE in a child-process env.
 *
 * The overlay alone was not enough: agent CLIs give process env precedence over
 * their config files, and this app imports the ANTHROPIC_ and OPENAI_ agent vars
 * from the login shell (electron/runtimePath.js). So on a machine where cc-switch (or a
 * manual rc export) left a stale ANTHROPIC_BASE_URL/key in the login shell, that
 * value was inherited into the child env and — for any key the active provider
 * did not itself set — leaked through and beat everything Leoapi wrote. Changing
 * the endpoint in Leoapi then "did nothing": the CLI stayed locked to the old
 * exported value.
 *
 * Fix: when a provider is active, CLEAR every managed key first, then apply the
 * overlay — so the active provider fully replaces any inherited value (an empty
 * baseUrl correctly falls back to the official endpoint instead of a stale one).
 * With NO active provider, the child env is returned untouched, preserving the
 * "本机原配置" contract (the machine's own shell/config stays in charge).
 */
export async function applyActiveSwitchEnv<T extends Record<string, string | undefined>>(
  childEnv: T,
  target: 'claude' | 'codex',
): Promise<T> {
  const overlay = await getActiveSwitchEnvOverlay(target);
  if (Object.keys(overlay).length === 0) return childEnv;
  const next = { ...childEnv } as T;
  for (const key of MANAGED_SWITCH_ENV_KEYS[target]) delete next[key];
  return { ...next, ...overlay } as T;
}
