import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { parseCliVersion } from '@/modules/providers/services/cli-version.util.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export type CodexCliAuthStatus = {
  authenticated: boolean;
  method: string | null;
};

export function parseCodexCliAuthStatus(output: string): CodexCliAuthStatus | null {
  const normalized = output.trim().toLowerCase();
  if (!normalized) return null;
  if (/not logged in|not authenticated|login required/.test(normalized)) {
    return { authenticated: false, method: null };
  }
  if (/logged in|authenticated as/.test(normalized)) {
    return {
      authenticated: true,
      method: normalized.includes('api key') ? 'api_key' : 'cli_login',
    };
  }
  return null;
}

export class CodexProviderAuth implements IProviderAuth {
  constructor(private readonly spawnSync: typeof spawn.sync = spawn.sync) {}

  /**
   * Checks whether Codex is available to the server runtime and reads its version.
   */
  private probeInstall(): { installed: boolean; version: string | null } {
    try {
      const result = this.spawnSync('codex', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const installed = !result.error && result.status === 0;
      return { installed, version: installed ? parseCliVersion(result.stdout || result.stderr) : null };
    } catch {
      return { installed: false, version: null };
    }
  }

  /**
   * Returns Codex SDK availability and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version } = this.probeInstall();
    if (!installed) {
      return {
        installed: false,
        provider: 'codex',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: 'Codex CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      version,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Codex auth.json and checks OAuth tokens or an API key fallback.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    if (process.env.OPENAI_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const cliStatus = this.checkCliAuthStatus();
    if (cliStatus) {
      if (!cliStatus.authenticated) {
        return { authenticated: false, email: null, method: null, error: 'Codex CLI is not logged in' };
      }

      const identity = await this.readCredentialIdentity();
      return {
        authenticated: true,
        email: identity.email,
        method: cliStatus.method ?? identity.method,
      };
    }

    return this.readCredentialIdentity();
  }

  private checkCliAuthStatus(): CodexCliAuthStatus | null {
    try {
      const result = this.spawnSync('codex', ['login', 'status'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      if (result.error) return null;

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      return parseCodexCliAuthStatus(`${stdout}\n${stderr}`);
    } catch {
      return null;
    }
  }

  private async readCredentialIdentity(): Promise<CodexCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);

      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      if (readOptionalString(auth.OPENAI_API_KEY)) {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid tokens found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Codex not configured' : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}
