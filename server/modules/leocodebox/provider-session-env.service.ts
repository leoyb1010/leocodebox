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
