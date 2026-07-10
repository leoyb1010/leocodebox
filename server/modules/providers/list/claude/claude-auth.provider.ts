import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import {
  readCliInstallProbe,
  runProviderCliCommand,
  type CliCommandRunner,
  type CliInstallProbe,
} from '@/modules/providers/services/cli-version.util.js';
import { getClaudeConfigDir } from '@/shared/provider-runtime-paths.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export type ClaudeCliAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
};

export function parseClaudeCliAuthStatus(output: string): ClaudeCliAuthStatus | null {
  try {
    const value = readObjectRecord(JSON.parse(output));
    if (typeof value?.loggedIn !== 'boolean') return null;

    return {
      authenticated: value.loggedIn,
      email: readOptionalString(value.email) ?? readOptionalString(value.account) ?? null,
      method: value.loggedIn ? readOptionalString(value.authMethod) ?? null : null,
    };
  } catch {
    return null;
  }
}

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

export class ClaudeProviderAuth implements IProviderAuth {
  constructor(private readonly runCommand: CliCommandRunner = runProviderCliCommand) {}

  /**
   * Checks whether the Claude Code CLI is available on this host and reads its version.
   */
  private async probeInstall(): Promise<CliInstallProbe> {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      const result = await this.runCommand(cliPath, ['--version'], 5000);
      return readCliInstallProbe(result, 'claude');
    } catch (error) {
      return readCliInstallProbe({ error, status: null }, 'claude');
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const install = await this.probeInstall();
    const { installed, version } = install;

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    if (!install.runnable) {
      return {
        installed: true,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        version: null,
        error: `Claude Code CLI was found but could not run: ${install.error}`,
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      version,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(getClaudeConfigDir(), 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    const cliStatus = await this.checkCliAuthStatus();
    if (cliStatus) {
      return {
        ...cliStatus,
        error: cliStatus.authenticated ? undefined : missingCredentialsError,
      };
    }

    try {
      const credPath = path.join(getClaudeConfigDir(), '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }

  private async checkCliAuthStatus(): Promise<ClaudeCliAuthStatus | null> {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      const result = await this.runCommand(cliPath, ['auth', 'status'], 5000);
      if (result.error) return null;

      const stdout = String(result.stdout ?? '');
      const stderr = String(result.stderr ?? '');
      return parseClaudeCliAuthStatus(stdout.trim() || stderr.trim());
    } catch {
      return null;
    }
  }
}
