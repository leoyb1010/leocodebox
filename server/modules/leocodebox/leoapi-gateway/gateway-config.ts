/**
 * Leoapi gateway (Leoapi 3.0, phase 1): an OPT-IN, default-OFF local proxy.
 *
 * When enabled, the active Leoapi provider's session env points the agent CLI's
 * base URL at this loopback gateway (with an opaque `lgw:<providerId>` token in
 * place of the real key), and the gateway forwards each request to that
 * provider's real upstream — a faithful byte-for-byte passthrough — while
 * tee-reading a copy to meter wire-level tokens. Off by default; a failed
 * gateway never touches a session that didn't opt in, and one toggle reverts to
 * today's spawn-time env behavior.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appConfigDb } from '../../database/index.js';

const ENABLED_KEY = 'leoapi_gateway_enabled';
export const GATEWAY_MOUNT = '/leoapi-gateway';
export const GATEWAY_TOKEN_PREFIX = 'lgw:';

/** Whether the opt-in gateway is enabled (default false). */
export function isGatewayEnabled(): boolean {
  return appConfigDb.get(ENABLED_KEY) === '1';
}

export function setGatewayEnabled(enabled: boolean): boolean {
  appConfigDb.set(ENABLED_KEY, enabled ? '1' : '0');
  return isGatewayEnabled();
}

/**
 * The loopback URL agent CLIs should target when the gateway is on. The port is
 * whatever this server bound to — read from the local-server marker the desktop
 * shell writes, falling back to SERVER_PORT / 3001 for standalone dev.
 */
export function gatewayBaseUrl(): string | null {
  const port = resolveServerPort();
  return port ? `http://127.0.0.1:${port}${GATEWAY_MOUNT}` : null;
}

function resolveServerPort(): number | null {
  const envPort = Number.parseInt(process.env.SERVER_PORT || '', 10);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  try {
    const marker = path.join(os.homedir(), '.leocodebox', 'local-server.json');
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { port?: number };
    if (parsed.port && Number.isInteger(parsed.port)) return parsed.port;
  } catch { /* fall through */ }
  return 3001;
}
