import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

import express from 'express';

import { mutationsAllowed, requireLocalOnly } from '../../shared/local-only.js';

import { compareSemver, fetchJson } from './version-network.utils.js';

const router = express.Router();

type CliInstallSource = 'unknown' | 'homebrew' | 'pnpm' | 'volta' | 'bun' | 'npm-global' | 'app-bundled' | 'standalone' | 'shim' | 'not-installed';
type CliTool = {
  id: string;
  label?: string;
  cmd: string;
  updateArgs: string[] | null;
  install?: { command: string; args: string[] };
  npmPackage: string | null;
  docsUrl?: string;
};
type CliCommandResult = { ok: boolean; code: string | number; stdout: string; stderr: string; error: string | null };
type CliLatestCacheEntry = { version: string | null; updatedAt: number };
type CliLatestResult = { version: string | null; checkedAt: string | null; source: string };
type CliLatestOptions = { force?: boolean; now?: number; loadLatest?: (packageName: string) => Promise<string | null> };
type StatusError = Error & { statusCode?: number };

function nowIso(): string {
  return new Date().toISOString();
}

const pendingCliMutations = new Map<string, Promise<unknown>>();
const cliLatestVersionCache = new Map<string, CliLatestCacheEntry>();
const CLI_LATEST_VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Agent CLI tooling: live version + one-click self-update
// ---------------------------------------------------------------------------

const CLI_VERSION_TOKEN = /(?:^|\s|v)(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)(?=\s|$|\))/m;

export const CLI_TOOLS: Record<string, CliTool> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@anthropic-ai/claude-code'] },
    npmPackage: '@anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@openai/codex'] },
    npmPackage: '@openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    cmd: 'opencode',
    // Update selection is resolved from the executable's verified install source.
    updateArgs: ['upgrade'],
    install: { command: 'npm', args: ['install', '--global', 'opencode-ai'] },
    npmPackage: 'opencode-ai',
    docsUrl: 'https://opencode.ai',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor-agent',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://cursor.com',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    cmd: 'gemini',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@google/gemini-cli'] },
    npmPackage: '@google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    cmd: 'hermes',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://hermes-agent.nousresearch.com',
  },
  grok: {
    id: 'grok',
    label: 'Grok Build',
    cmd: 'grok',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://grok.com/build',
  },
};

function parseCliVersionText(output: unknown): string | null {
  if (!output) return null;
  const match = String(output).match(CLI_VERSION_TOKEN);
  return match ? match[1] : null;
}

export async function resolveExecutablePath(command: string, platform = process.platform): Promise<string | null> {
  const result = await runCliCommand(platform === 'win32' ? 'where' : 'which', [command], 5000);
  if (!result.ok) return null;
  const executablePath = result.stdout.trim().split(/\r?\n/)[0];
  if (!executablePath) return null;
  try {
    return await fs.realpath(executablePath);
  } catch {
    return executablePath;
  }
}

export async function detectCliInstallSource(tool: CliTool, resolvePath: (command: string) => Promise<string | null> = resolveExecutablePath): Promise<{ source: CliInstallSource; executablePath: string | null }> {
  const executablePath = await resolvePath(tool.cmd);
  if (!executablePath) return { source: 'unknown', executablePath: null };
  const normalized = executablePath.replaceAll('\\', '/');
  // npm installed by Homebrew's Node still lives under lib/node_modules.
  if (/(^|\/)(lib\/node_modules|\.npm-global|npm\/bin)(\/|$)/i.test(normalized)) {
    return { source: 'npm-global', executablePath };
  }
  if (/(^|\/)(pnpm|pnpm-global)(\/|$)/i.test(normalized)) {
    return { source: 'pnpm', executablePath };
  }
  if (/(^|\/)\.volta(\/|$)/i.test(normalized)) {
    return { source: 'volta', executablePath };
  }
  if (/(^|\/)\.bun(\/|$)/i.test(normalized)) {
    return { source: 'bun', executablePath };
  }
  if (/(^|\/)(Cellar|Caskroom)(\/|$)/i.test(normalized)) {
    return { source: 'homebrew', executablePath };
  }
  if (normalized.includes('.app/Contents/')) {
    return { source: 'app-bundled', executablePath };
  }
  if (/(^|\/)(\.local\/(bin|share\/[^/]+)|\.opencode\/bin|\.grok\/(bin|downloads))(\/|$)/i.test(normalized)) {
    return { source: 'standalone', executablePath };
  }
  if (/(^|\/)(\.asdf|\.local\/share\/mise|mise)\/shims(\/|$)/i.test(normalized)) {
    return { source: 'shim', executablePath };
  }
  return { source: 'unknown', executablePath };
}

export async function resolveCliUpdateCommand(tool: CliTool, source: CliInstallSource): Promise<{ command: string; args: string[] } | null> {
  if (source === 'npm-global' && tool.npmPackage) {
    return { command: 'npm', args: ['install', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'homebrew') {
    const formulaById: Record<string, { name: string; cask?: boolean }> = {
      opencode: { name: 'opencode' }, gemini: { name: 'gemini-cli' }, codex: { name: 'codex' }, claude: { name: 'claude-code', cask: true },
    };
    const formula = formulaById[tool.id];
    if (formula) return { command: 'brew', args: ['upgrade', ...(formula.cask ? ['--cask'] : []), formula.name] };
  }
  if (source === 'pnpm' && tool.npmPackage) {
    return { command: 'pnpm', args: ['add', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'volta' && tool.npmPackage) {
    return { command: 'volta', args: ['install', `${tool.npmPackage}@latest`] };
  }
  if (source === 'bun' && tool.npmPackage) {
    return { command: 'bun', args: ['add', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'standalone' && Array.isArray(tool.updateArgs)) {
    return { command: tool.cmd, args: tool.updateArgs };
  }
  return null;
}

export async function withCliMutation<T>(toolId: string, operation: () => Promise<T> | T): Promise<T> {
  if (pendingCliMutations.has(toolId)) {
    const error: StatusError = new Error(`CLI operation already in progress for ${toolId}.`);
    error.statusCode = 409;
    throw error;
  }
  const request = Promise.resolve().then(operation);
  pendingCliMutations.set(toolId, request);
  try {
    return await request;
  } finally {
    if (pendingCliMutations.get(toolId) === request) pendingCliMutations.delete(toolId);
  }
}

export function runCliCommand(cmd: string, args: string[], timeoutMs = 10_000): Promise<CliCommandResult> {
  return new Promise<CliCommandResult>((resolve) => {
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null,
      });
    });
  });
}

export async function readCliLatestVersion(tool: CliTool, {
  force = false,
  now = Date.now(),
  loadLatest = async (packageName: string) => {
    const encoded = packageName.replace('@', '%40').replace('/', '%2F');
    const registry = String(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
    const info = await fetchJson(`${registry}/${encoded}/latest`) as { version?: string };
    return info.version || null;
  },
} = {}) {
  if (!tool.npmPackage) return { version: null, checkedAt: null, source: 'unsupported' };
  const cached = cliLatestVersionCache.get(tool.id);
  if (!force && cached && now - cached.updatedAt < CLI_LATEST_VERSION_CACHE_TTL_MS) {
    return { version: cached.version, checkedAt: new Date(cached.updatedAt).toISOString(), source: 'cache' };
  }
  try {
    const version = await loadLatest(tool.npmPackage);
    cliLatestVersionCache.set(tool.id, { version, updatedAt: now });
    return { version, checkedAt: new Date(now).toISOString(), source: 'registry' };
  } catch {
    return cached
      ? { version: cached.version, checkedAt: new Date(cached.updatedAt).toISOString(), source: 'stale-cache' }
      : { version: null, checkedAt: new Date(now).toISOString(), source: 'unavailable' };
  }
}

export function clearCliLatestVersionCache(): void {
  cliLatestVersionCache.clear();
}

async function getCliToolStatus(tool: CliTool, { checkLatest = true, forceLatest = false }: { checkLatest?: boolean; forceLatest?: boolean } = {}) {
  const probe = await runCliCommand(tool.cmd, ['--version'], 5000);
  const installed = probe.code !== 'ENOENT';
  const runnable = probe.ok;
  const currentVersion = runnable ? parseCliVersionText(probe.stdout || probe.stderr) : null;
  const latest = checkLatest && runnable
    ? await readCliLatestVersion(tool, { force: forceLatest })
    : { version: null, checkedAt: null, source: 'skipped' };
  const latestVersion = latest.version;
  const updateAvailable = Boolean(
    currentVersion && latestVersion && compareSemver(latestVersion, currentVersion) > 0,
  );
  const installInfo: { source: CliInstallSource; executablePath: string | null } = installed
    ? await detectCliInstallSource(tool)
    : { source: 'not-installed', executablePath: null };
  const updateCommand = runnable ? await resolveCliUpdateCommand(tool, installInfo.source) : null;
  const allowMutations = mutationsAllowed();
  const manualHint = updateCommand
    ? [updateCommand.command, ...updateCommand.args].join(' ')
    : tool.npmPackage ? `npm install --global ${tool.npmPackage}@latest` : null;
  return {
    id: tool.id,
    label: tool.label,
    command: tool.cmd,
    installed,
    runnable,
    error: runnable ? null : (probe.stderr || probe.error || `${tool.cmd} could not run`).trim(),
    currentVersion,
    latestVersion,
    latestCheckedAt: latest.checkedAt,
    latestVersionSource: latest.source,
    updateAvailable,
    installSource: installInfo.source,
    executablePath: installInfo.executablePath,
    canInstall: !installed && Boolean(tool.install),
    canSelfUpdate: runnable && Boolean(updateCommand),
    mutationsAllowed: allowMutations,
    manualHint,
    docsUrl: tool.docsUrl,
  };
}

router.get('/status', async (req, res, next) => {
  try {
    const forceLatest = req.query?.refresh === '1';
    const tools = await Promise.all(
      Object.values(CLI_TOOLS).map((tool) => getCliToolStatus(tool, { forceLatest })),
    );
    res.json({
      success: true,
      checkedAt: nowIso(),
      mutationsAllowed: mutationsAllowed(),
      tools,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/install', requireLocalOnly, async (req, res, next) => {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const tool = Object.hasOwn(CLI_TOOLS, id) ? CLI_TOOLS[id] : null;
    if (!tool) {
      res.status(404).json({ success: false, error: 'Unknown CLI tool.' });
      return;
    }
    if (!tool.install) {
      res.status(409).json({ success: false, error: `${tool.label} 没有经过验证的一键安装方式。` });
      return;
    }
    const install = tool.install;
    const payload = await withCliMutation(tool.id, async () => {
      const before = await getCliToolStatus(tool, { checkLatest: false });
      if (before.installed) {
        const error: StatusError = new Error(`${tool.label} 已安装。`);
        error.statusCode = 409;
        throw error;
      }
      const result = await runCliCommand(install.command, install.args, 300_000);
      const after = await getCliToolStatus(tool, { checkLatest: false });
      return {
        success: result.ok && after.installed,
        tool: tool.id,
        currentVersion: after.currentVersion,
        installSource: after.installSource,
        output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000),
        error: result.ok && after.installed ? null : (result.error || 'Install command failed.'),
      };
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/update', requireLocalOnly, async (req, res, next) => {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const tool = Object.hasOwn(CLI_TOOLS, id) ? CLI_TOOLS[id] : null;
    if (!tool) {
      res.status(404).json({ success: false, error: 'Unknown CLI tool.' });
      return;
    }
    const payload = await withCliMutation(tool.id, async () => {
      const before = await getCliToolStatus(tool, { checkLatest: false });
      if (!before.installed) {
        const error: StatusError = new Error(`${tool.label} CLI is not installed.`);
        error.statusCode = 409;
        throw error;
      }
      const updateCommand = await resolveCliUpdateCommand(tool, before.installSource as CliInstallSource);
      if (!updateCommand) {
        const error: StatusError = new Error(`${tool.label} 的安装来源为 ${before.installSource}，无法安全自动更新。`);
        error.statusCode = 409;
        throw error;
      }
      const result = await runCliCommand(updateCommand.command, updateCommand.args, 300_000);
      const after = await getCliToolStatus(tool, { checkLatest: false });
      return {
        success: result.ok,
        tool: tool.id,
        previousVersion: before.currentVersion,
        currentVersion: after.currentVersion,
        changed: before.currentVersion !== after.currentVersion,
        output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000),
        error: result.ok ? null : (result.error || 'Update command failed.'),
      };
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});


export default router;
