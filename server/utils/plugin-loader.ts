import fs from 'fs';
import path from 'path';
import os from 'os';

import { spawn } from 'cross-spawn';


export type PluginManifest = {
  name: string;
  displayName: string;
  entry: string;
  version?: string;
  description?: string;
  author?: string;
  icon?: string;
  type?: string;
  slot?: string;
  server?: string | null;
  permissions?: string[];
};
export type InstalledPlugin = {
  name: string; displayName: string; version: string; description: string; author: string; icon: string;
  type: string; slot: string; entry: string; server: string | null; permissions: string[]; enabled: boolean;
  dirName: string; repoUrl: string | null;
};
type PluginsConfig = Record<string, { enabled?: boolean; secrets?: Record<string, unknown> }>;
type ValidationResult = { valid: boolean; error?: string };
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error ?? ''); }

const PLUGINS_DIR = path.join(os.homedir(), '.leocodebox', 'plugins');
const PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.leocodebox', 'plugins.json');
const LEGACY_PLUGINS_DIR = path.join(os.homedir(), '.claude-code-ui', 'plugins');
const LEGACY_PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.claude-code-ui', 'plugins.json');

const REQUIRED_MANIFEST_FIELDS = ['name', 'displayName', 'entry'] as const;

/** Strip embedded credentials from a repo URL before exposing it to the client. */
function sanitizeRepoUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    // Not a parseable URL (e.g. SSH shorthand) — strip user:pass@ segment
    return raw.replace(/\/\/[^@/]+@/, '//');
  }
}
const ALLOWED_TYPES = ['react', 'module'];
const ALLOWED_SLOTS = ['tab'];

export function getPluginsDir(): string {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    if (fs.existsSync(LEGACY_PLUGINS_DIR)) {
      try {
        fs.cpSync(LEGACY_PLUGINS_DIR, PLUGINS_DIR, { recursive: true, force: false });
      } catch {
        // Legacy plugin migration is best-effort.
      }
    }
  }
  return PLUGINS_DIR;
}

export function getPluginsConfig(): PluginsConfig {
  try {
    if (fs.existsSync(PLUGINS_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PLUGINS_CONFIG_PATH, 'utf-8'));
    }
    if (fs.existsSync(LEGACY_PLUGINS_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(LEGACY_PLUGINS_CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // Corrupted config, start fresh
  }
  return {};
}

export function savePluginsConfig(config: PluginsConfig): void {
  const dir = path.dirname(PLUGINS_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PLUGINS_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function validateManifest(manifest: unknown): ValidationResult {
  const value = manifest as Partial<PluginManifest>;
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'Manifest must be a JSON object' };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!value[field] || typeof value[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  // Sanitize name — only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(value.name!)) {
    return { valid: false, error: 'Plugin name must only contain letters, numbers, hyphens, and underscores' };
  }

  if (value.type && !ALLOWED_TYPES.includes(value.type)) {
    return { valid: false, error: `Invalid plugin type: ${value.type}. Must be one of: ${ALLOWED_TYPES.join(', ')}` };
  }

  if (value.slot && !ALLOWED_SLOTS.includes(value.slot)) {
    return { valid: false, error: `Invalid plugin slot: ${value.slot}. Must be one of: ${ALLOWED_SLOTS.join(', ')}` };
  }

  // Validate entry is a relative path without traversal
  if (value.entry!.includes('..') || path.isAbsolute(value.entry!)) {
    return { valid: false, error: 'Entry must be a relative path without ".."' };
  }

  if (value.server !== undefined && value.server !== null) {
    if (typeof value.server !== 'string' || value.server.includes('..') || path.isAbsolute(value.server)) {
      return { valid: false, error: 'Server entry must be a relative path string without ".."' };
    }
  }

  if (value.permissions !== undefined) {
    if (!Array.isArray(value.permissions) || !value.permissions.every(p => typeof p === 'string')) {
      return { valid: false, error: 'Permissions must be an array of strings' };
    }
  }

  return { valid: true };
}

const BUILD_TIMEOUT_MS = 60_000;

/** Run `npm run build` if the plugin's package.json declares a build script. */
function runBuildIfNeeded(dir: string, packageJsonPath: string, onSuccess: () => void, onError: (error: Error) => void): void {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!pkg.scripts?.build) {
      return onSuccess();
    }
  } catch {
    return onSuccess(); // Unreadable package.json — skip build
  }

  const buildProcess = spawn('npm', ['run', 'build'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    buildProcess.removeAllListeners();
    buildProcess.kill();
    onError(new Error('npm run build timed out'));
  }, BUILD_TIMEOUT_MS);

  buildProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

  buildProcess.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) {
      return onError(new Error(`npm run build failed (exit code ${code}): ${stderr.trim()}`));
    }
    onSuccess();
  });

  buildProcess.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onError(new Error(`Failed to spawn build: ${errorMessage(err)}`));
  });
}

export function scanPlugins(): InstalledPlugin[] {
  const pluginsDir = getPluginsDir();
  const config = getPluginsConfig();
  const plugins: InstalledPlugin[] = [];

  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return plugins;
  }

  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip transient temp directories from in-progress installs
    if (entry.name.startsWith('.tmp-')) continue;

    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      const validation = validateManifest(manifest);
      if (!validation.valid) {
        console.warn(`[Plugins] Skipping ${entry.name}: ${validation.error}`);
        continue;
      }

      // Skip duplicate manifest names
      if (seenNames.has(manifest.name)) {
        console.warn(`[Plugins] Skipping ${entry.name}: duplicate plugin name "${manifest.name}"`);
        continue;
      }
      seenNames.add(manifest.name);

      // Try to read git remote URL
      let repoUrl = null;
      try {
        const gitConfigPath = path.join(pluginsDir, entry.name, '.git', 'config');
        if (fs.existsSync(gitConfigPath)) {
          const gitConfig = fs.readFileSync(gitConfigPath, 'utf-8');
          const match = gitConfig.match(/url\s*=\s*(.+)/);
          if (match) {
            repoUrl = match[1].trim().replace(/\.git$/, '');
            // Convert SSH URLs to HTTPS
            if (repoUrl.startsWith('git@')) {
              repoUrl = repoUrl.replace(/^git@([^:]+):/, 'https://$1/');
            }
            // Strip embedded credentials (e.g. https://user:pass@host/...)
            repoUrl = sanitizeRepoUrl(repoUrl);
          }
        }
      } catch { /* ignore */ }

      plugins.push({
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        author: manifest.author || '',
        icon: manifest.icon || 'Puzzle',
        type: manifest.type || 'module',
        slot: manifest.slot || 'tab',
        entry: manifest.entry,
        server: manifest.server || null,
        permissions: manifest.permissions || [],
        enabled: config[manifest.name]?.enabled !== false, // enabled by default
        dirName: entry.name,
        repoUrl,
      });
    } catch (err) {
      console.warn(`[Plugins] Failed to read manifest for ${entry.name}:`, errorMessage(err));
    }
  }

  return plugins;
}

export function getPluginDir(name: string): string | null {
  const plugins = scanPlugins();
  const plugin = plugins.find(p => p.name === name);
  if (!plugin) return null;
  return path.join(getPluginsDir(), plugin.dirName);
}

export function resolvePluginAssetPath(name: string, assetPath: string): string | null {
  const pluginDir = getPluginDir(name);
  if (!pluginDir) return null;

  const resolved = path.resolve(pluginDir, assetPath);

  // Prevent path traversal — canonicalize via realpath to defeat symlink bypasses
  if (!fs.existsSync(resolved)) return null;

  const realResolved = fs.realpathSync(resolved);
  const realPluginDir = fs.realpathSync(pluginDir);
  if (!realResolved.startsWith(realPluginDir + path.sep) && realResolved !== realPluginDir) {
    return null;
  }

  return realResolved;
}

export function installPluginFromGit(url: string): Promise<PluginManifest> {
  return new Promise<PluginManifest>((resolve, reject) => {
    if (typeof url !== 'string' || !url.trim()) {
      return reject(new Error('Invalid URL: must be a non-empty string'));
    }
    if (url.startsWith('-')) {
      return reject(new Error('Invalid URL: must not start with "-"'));
    }

    // Extract repo name from URL for directory name
    const urlClean = url.replace(/\.git$/, '').replace(/\/$/, '');
    const repoName = urlClean.split('/').pop();

    if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName)) {
      return reject(new Error('Could not determine a valid directory name from the URL'));
    }

    const pluginsDir = getPluginsDir();
    const targetDir = path.resolve(pluginsDir, repoName);

    // Ensure the resolved target directory stays within the plugins directory
    if (!targetDir.startsWith(pluginsDir + path.sep)) {
      return reject(new Error('Invalid plugin directory path'));
    }

    if (fs.existsSync(targetDir)) {
      return reject(new Error(`Plugin directory "${repoName}" already exists`));
    }

    // Clone into a temp directory so scanPlugins() never sees a partially-installed plugin
    const tempDir = fs.mkdtempSync(path.join(pluginsDir, `.tmp-${repoName}-`));

    const cleanupTemp = (): void => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    };

    const finalize = (manifest: PluginManifest): void => {
      try {
        fs.renameSync(tempDir, targetDir);
      } catch (err) {
        cleanupTemp();
        return reject(new Error(`Failed to move plugin into place: ${errorMessage(err)}`));
      }
      resolve(manifest);
    };

    const gitProcess = spawn('git', ['clone', '--depth', '1', '--', url, tempDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        cleanupTemp();
        return reject(new Error(`git clone failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Validate manifest exists
      const manifestPath = path.join(tempDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        cleanupTemp();
        return reject(new Error('Cloned repository does not contain a manifest.json'));
      }

      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      } catch {
        cleanupTemp();
        return reject(new Error('manifest.json is not valid JSON'));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        cleanupTemp();
        return reject(new Error(`Invalid manifest: ${validation.error}`));
      }

      // Reject if another installed plugin already uses this name
      const existing = scanPlugins().find(p => p.name === manifest.name);
      if (existing) {
        cleanupTemp();
        return reject(new Error(`A plugin named "${manifest.name}" is already installed (in "${existing.dirName}")`));
      }

      // Run npm install if package.json exists.
      // --ignore-scripts prevents postinstall hooks from executing arbitrary code.
      const packageJsonPath = path.join(tempDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const npmProcess = spawn('npm', ['install', '--ignore-scripts'], {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            cleanupTemp();
            return reject(new Error(`npm install for ${repoName} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(tempDir, packageJsonPath, () => finalize(manifest), (err) => { cleanupTemp(); reject(err); });
        });

        npmProcess.on('error', (err) => {
          cleanupTemp();
          reject(err);
        });
      } else {
        finalize(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      cleanupTemp();
      reject(new Error(`Failed to spawn git: ${errorMessage(err)}`));
    });
  });
}

export function updatePluginFromGit(name: string): Promise<PluginManifest> {
  return new Promise<PluginManifest>((resolve, reject) => {
    const pluginDir = getPluginDir(name);
    if (!pluginDir) {
      return reject(new Error(`Plugin "${name}" not found`));
    }

    // Only fast-forward to avoid silent divergence
    const gitProcess = spawn('git', ['pull', '--ff-only', '--'], {
      cwd: pluginDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`git pull failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Re-validate manifest after update
      const manifestPath = path.join(pluginDir, 'manifest.json');
      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      } catch {
        return reject(new Error('manifest.json is not valid JSON after update'));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        return reject(new Error(`Invalid manifest after update: ${validation.error}`));
      }

      // Re-run npm install if package.json exists
      const packageJsonPath = path.join(pluginDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const npmProcess = spawn('npm', ['install', '--ignore-scripts'], {
          cwd: pluginDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            return reject(new Error(`npm install for ${name} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(pluginDir, packageJsonPath, () => resolve(manifest), (err) => reject(err));
        });
        npmProcess.on('error', (err) => reject(err));
      } else {
        resolve(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${errorMessage(err)}`));
    });
  });
}

export async function uninstallPlugin(name: string): Promise<void> {
  const pluginDir = getPluginDir(name);
  if (!pluginDir) {
    throw new Error(`Plugin "${name}" not found`);
  }

  // On Windows, file handles may be released slightly after process exit.
  // Retry a few times with a short delay before giving up.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 500;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EBUSY' && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }

  // Remove from config
  const config = getPluginsConfig();
  delete config[name];
  savePluginsConfig(config);
}
