import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { parseCliVersion } from '@/modules/providers/services/cli-version.util.js';

type CursorLoginStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export function parseCursorLoginStatus(output: string): CursorLoginStatus {
  const emailMatch = output.match(/Logged in as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (emailMatch?.[1]) {
    return { authenticated: true, email: emailMatch[1], method: 'cli' };
  }
  if (/Login successful|Logged in/i.test(output)) {
    return { authenticated: true, email: 'Logged in', method: 'cli' };
  }
  return { authenticated: false, email: null, method: null, error: 'Not logged in' };
}

export class CursorProviderAuth implements IProviderAuth {
  constructor(private readonly spawnSync: typeof spawn.sync = spawn.sync) {}

  private run(args: string[], timeout = 5000) {
    return this.spawnSync('cursor-agent', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
  }

  private probeInstall(): { installed: boolean; version: string | null } {
    try {
      const result = this.run(['--version']);
      const installed = !result.error && result.status === 0;
      return { installed, version: installed ? parseCliVersion(result.stdout || result.stderr) : null };
    } catch {
      return { installed: false, version: null };
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version } = this.probeInstall();
    if (!installed) {
      return {
        installed: false,
        provider: 'cursor',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: 'Cursor CLI is not installed',
      };
    }

    const login = this.checkCursorLogin();
    return {
      installed: true,
      provider: 'cursor',
      authenticated: login.authenticated,
      email: login.email,
      method: login.method,
      version,
      error: login.authenticated ? undefined : login.error || 'Not logged in',
    };
  }

  private checkCursorLogin(): CursorLoginStatus {
    try {
      const statusResult = this.run(['status']);
      const statusOutput = `${statusResult.stdout || ''}\n${statusResult.stderr || ''}`;
      if (statusResult.error || statusResult.status !== 0) {
        return { authenticated: false, email: null, method: null, error: statusOutput.trim() || 'Not logged in' };
      }

      const login = parseCursorLoginStatus(statusOutput);
      if (!login.authenticated) return login;

      // `cursor-agent status` can report a stale keychain entry as logged in.
      // Listing models performs the lightweight authenticated request used by real sessions.
      const capabilityResult = this.run(['--list-models'], 10_000);
      if (capabilityResult.error || capabilityResult.status !== 0) {
        return {
          authenticated: false,
          email: login.email,
          method: login.method,
          error: 'Cursor credentials are present but unusable. Run cursor-agent login again.',
        };
      }
      return login;
    } catch {
      return { authenticated: false, email: null, method: null, error: 'Cursor CLI authentication check failed' };
    }
  }
}
