import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import {
  readCliInstallProbe,
  runProviderCliCommand,
  type CliCommandRunner,
} from '@/modules/providers/services/cli-version.util.js';

/**
 * grok stores credentials in ~/.grok/auth.json after `grok` login (browser
 * OAuth or device-auth). Presence of that file is the authoritative "logged in"
 * signal for headless use — the same file the CLI itself reads.
 */
export class GrokProviderAuth implements IProviderAuth {
  constructor(private readonly runCommand: CliCommandRunner = runProviderCliCommand) {}

  async getStatus(): Promise<ProviderAuthStatus> {
    let install;
    try {
      install = readCliInstallProbe(await this.runCommand('grok', ['--version'], 5000), 'grok');
    } catch (error) {
      install = readCliInstallProbe({ error, status: null }, 'grok');
    }

    if (!install.installed) {
      return { installed: false, provider: 'grok', authenticated: false, email: null, method: null, version: null, error: 'Grok Build CLI is not installed' };
    }
    if (!install.runnable) {
      return { installed: true, provider: 'grok', authenticated: false, email: null, method: null, version: null, error: `Grok Build CLI was found but could not run: ${install.error}` };
    }

    const authed = await this.hasCredentials();
    return {
      installed: true,
      provider: 'grok',
      authenticated: authed,
      email: authed ? 'Logged in' : null,
      method: authed ? 'cli' : null,
      version: install.version,
      error: authed ? undefined : 'Not logged in. Run `grok` once to authenticate.',
    };
  }

  private async hasCredentials(): Promise<boolean> {
    try {
      await access(path.join(os.homedir(), '.grok', 'auth.json'));
      return true;
    } catch {
      return false;
    }
  }
}
