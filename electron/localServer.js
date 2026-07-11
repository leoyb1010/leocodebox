import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ServerInstaller } from './serverInstaller.js';
import {
  getAgentCliDiagnostics,
  getDesktopRuntimePath,
  readLoginShellEnvironment,
} from './runtimePath.js';

const DEFAULT_PORT = Number.parseInt(
  process.env.LEOCODEBOX_DESKTOP_DEFAULT_PORT || process.env.CLOUDCLI_DESKTOP_DEFAULT_PORT || '38473',
  10,
) || 38473;
const HOST = '127.0.0.1';
const DISPLAY_HOST = 'localhost';
const LOCAL_ONLY_ENV_VALUE = '1';
const HEALTH_TIMEOUT_MS = 1000;
const SERVER_START_TIMEOUT_MS = 30000;
const MAX_STARTUP_LOG_LINES = 300;
const SERVER_MARKER_PATH = path.join(os.homedir(), '.leocodebox', 'local-server.json');
const LOCAL_SERVER_URL_ENV_KEYS = [
  'LEOCODEBOX_DESKTOP_LOCAL_SERVER_URL',
  'LEOCODEBOX_LOCAL_SERVER_URL',
  'CLOUDCLI_DESKTOP_LOCAL_SERVER_URL',
  'CLOUDCLI_LOCAL_SERVER_URL',
  'ELECTRON_LOCAL_SERVER_URL',
];
const LOCAL_SERVER_PORT_ENV_KEYS = [
  'LEOCODEBOX_DESKTOP_LOCAL_SERVER_PORT',
  'LEOCODEBOX_SERVER_PORT',
  'CLOUDCLI_DESKTOP_LOCAL_SERVER_PORT',
  'CLOUDCLI_SERVER_PORT',
  'SERVER_PORT',
  'PORT',
];

function requestJson(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: JSON.parse(body),
          });
        } catch {
          resolve({ ok: false, json: null });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, json: null });
    });
    req.on('error', () => resolve({ ok: false, json: null }));
  });
}

async function isLeocodeboxServer(baseUrl) {
  const response = await requestJson(`${baseUrl}/health`);
  return response.ok
    && response.json?.status === 'ok'
    && typeof response.json?.installMode === 'string';
}

function isPortAvailable(port, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
      server.close(() => resolve(port));
    });
    server.listen(0, HOST);
  });
}

async function chooseServerPort(host) {
  if (await isPortAvailable(DEFAULT_PORT, host)) {
    return DEFAULT_PORT;
  }

  return getFreePort();
}

function getNodeRuntime() {
  if (process.env.ELECTRON_NODE_PATH) {
    return { command: process.env.ELECTRON_NODE_PATH, env: {}, label: 'ELECTRON_NODE_PATH' };
  }

  if (process.versions.electron) {
    return {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: `Electron ${process.versions.electron} Node ${process.versions.node}`,
    };
  }

  if (process.env.npm_node_execpath) {
    return { command: process.env.npm_node_execpath, env: {}, label: 'npm_node_execpath' };
  }

  return { command: 'node', env: {}, label: 'PATH node' };
}

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function addCandidateUrl(urls, rawUrl) {
  if (!rawUrl) return;
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    parsed.hash = '';
    parsed.search = '';
    const normalized = stripTrailingSlash(parsed.toString());
    if (!urls.includes(normalized)) urls.push(normalized);
  } catch {
    // Ignore invalid user-provided discovery values.
  }
}

function addCandidatePort(urls, rawPort) {
  const port = Number.parseInt(String(rawPort || ''), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  addCandidateUrl(urls, `http://${HOST}:${port}`);
}

function getPortFromUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function getDisplayUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === HOST) {
      parsed.hostname = DISPLAY_HOST;
    }
    return stripTrailingSlash(parsed.toString());
  } catch {
    return baseUrl;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readServerBundleConfig(appRoot) {
  try {
    const raw = await fs.readFile(path.join(appRoot, 'electron', 'server-bundle-config.json'), 'utf8');
    const config = JSON.parse(raw);
    return {
      releaseTag: typeof config.releaseTag === 'string' && config.releaseTag.trim()
        ? config.releaseTag.trim()
        : '',
    };
  } catch {
    return { releaseTag: '' };
  }
}

function getServerCwd(appRoot, serverEntry) {
  const normalizedEntry = path.resolve(serverEntry);
  const bundledEntry = path.resolve(appRoot, 'dist-server', 'server', 'index.js');
  if (normalizedEntry === bundledEntry) {
    return appRoot;
  }

  // Installed server entries are laid out as <root>/dist-server/server/index.js.
  return path.resolve(path.dirname(normalizedEntry), '..', '..');
}

async function readServerMarkerUrl() {
  try {
    const raw = await fs.readFile(SERVER_MARKER_PATH, 'utf8');
    const marker = JSON.parse(raw);
    return marker.url || (marker.port ? `http://${marker.host || HOST}:${marker.port}` : null);
  } catch {
    return null;
  }
}

async function getExistingServerCandidateUrls(defaultUrl) {
  const urls = [];

  for (const key of LOCAL_SERVER_URL_ENV_KEYS) {
    addCandidateUrl(urls, process.env[key]);
  }

  addCandidateUrl(urls, await readServerMarkerUrl());

  for (const key of LOCAL_SERVER_PORT_ENV_KEYS) {
    addCandidatePort(urls, process.env[key]);
  }

  addCandidateUrl(urls, defaultUrl);
  return urls;
}

async function waitForLeocodeboxServer(baseUrl, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isLeocodeboxServer(baseUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

export class LocalServerController {
  constructor({ appRoot, settingsPath, isPackaged = false, appVersion, onChange }) {
    this.appRoot = appRoot;
    this.settingsPath = settingsPath;
    this.isPackaged = isPackaged;
    this.appVersion = appVersion;
    this.onChange = onChange;
    this.localServerUrl = null;
    this.localServerPort = null;
    this.ownedServerProcess = null;
    // Single-flight guard so concurrent startup requests reuse one in-flight
    // resolution instead of each spawning (and orphaning) a bundled server.
    this.startupPromise = null;
    this.localAuthToken = process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN
      || process.env.CLOUDCLI_DESKTOP_LOCAL_AUTH_TOKEN
      || randomBytes(32).toString('base64url');
    this.startupLogs = [];
    this.desktopSettings = {
      keepLocalServerRunning: false,
      exposeLocalServerOnNetwork: false,
      themeMode: 'system',
    };
  }

  getSettings() {
    return this.desktopSettings;
  }

  getLocalServerUrl() {
    return this.localServerUrl;
  }

  getLocalServerPort() {
    return this.localServerPort;
  }

  getLocalAuthToken() {
    return this.localAuthToken;
  }

  getHealthCheckUrl() {
    if (!this.localServerPort) return this.localServerUrl;
    return `http://${HOST}:${this.localServerPort}`;
  }

  appendStartupLog(line) {
    const text = String(line || '').trimEnd();
    if (!text) return;
    const timestamp = new Date().toLocaleTimeString();
    this.startupLogs.push(`[${timestamp}] ${text}`);
    if (this.startupLogs.length > MAX_STARTUP_LOG_LINES) {
      this.startupLogs.splice(0, this.startupLogs.length - MAX_STARTUP_LOG_LINES);
    }
    this.onChange?.();
  }

  getStartupLogs() {
    return [...this.startupLogs];
  }

  getPendingTarget() {
    return {
	      kind: 'local',
	      name: '本地 leocodebox',
	      url: this.localServerUrl || `http://${DISPLAY_HOST}:${this.localServerPort || DEFAULT_PORT}`,
    };
  }

  getLanAddress() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
    return null;
  }

  getShareableWebUrl() {
    if (!this.localServerUrl || !this.localServerPort) return null;
    return this.getLocalServerUrl();
  }

  getServerBindHost() {
    return HOST;
  }

  async loadDesktopSettings() {
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      const stored = JSON.parse(raw);
      this.desktopSettings = {
        keepLocalServerRunning: false,
        exposeLocalServerOnNetwork: false,
        themeMode: stored.themeMode === 'light' || stored.themeMode === 'dark' ? stored.themeMode : 'system',
      };
    } catch {
      this.desktopSettings = {
        keepLocalServerRunning: false,
        exposeLocalServerOnNetwork: false,
        themeMode: 'system',
      };
    }
  }

  async saveDesktopSettings(nextSettings = this.desktopSettings) {
    this.desktopSettings = {
      keepLocalServerRunning: false,
      exposeLocalServerOnNetwork: false,
      themeMode: nextSettings.themeMode === 'light' || nextSettings.themeMode === 'dark' ? nextSettings.themeMode : 'system',
    };
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.desktopSettings, null, 2), 'utf8');
    this.onChange?.();
  }

  async updateDesktopSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(this.desktopSettings, key)) {
      throw new Error(`Unknown desktop setting: ${key}`);
    }

    const nextValue = key === 'themeMode' ? value : false;
    await this.saveDesktopSettings({ ...this.desktopSettings, [key]: nextValue });

    return {
      desktopSettings: this.desktopSettings,
      requiresRestartNotice: false,
    };
  }

  /** Resolves the local server entry, installing the matching runtime if needed. */
  async resolveServerEntry() {
    if (process.env.ELECTRON_SERVER_ENTRY) {
      return process.env.ELECTRON_SERVER_ENTRY;
    }

    const bundledEntry = path.join(this.appRoot, 'dist-server', 'server', 'index.js');
    if (process.env.CLOUDCLI_USE_INSTALLED_SERVER !== '1' && await pathExists(bundledEntry)) {
      return bundledEntry;
    }

    throw new Error('Bundled local server is missing. leocodebox does not download a remote server in local-only mode.');

  }

  startBundledServer(port, serverEntry) {
    const bindHost = this.getServerBindHost();
    const runtime = getNodeRuntime();
    const serverCwd = getServerCwd(this.appRoot, serverEntry);
    const loginShellEnvironment = readLoginShellEnvironment();
    const runtimeEnvironment = { ...process.env, ...loginShellEnvironment };
    const desktopPath = getDesktopRuntimePath({
      env: runtimeEnvironment,
      loginShellPath: loginShellEnvironment.PATH || '',
    });
    const agentCliDiagnostics = getAgentCliDiagnostics(desktopPath);
    const childEnvironment = {
      ...runtimeEnvironment,
      ...runtime.env,
      HOST: bindHost,
      SERVER_PORT: String(port),
      NODE_ENV: 'production',
      LEOCODEBOX_LOCAL_ONLY: LOCAL_ONLY_ENV_VALUE,
      CLOUDCLI_DESKTOP_LOCAL_ONLY: LOCAL_ONLY_ENV_VALUE,
      LEOCODEBOX_LOCAL_AUTH_TOKEN: this.localAuthToken,
      CLOUDCLI_DESKTOP_LOCAL_AUTH_TOKEN: this.localAuthToken,
      LEOCODEBOX_DESKTOP_PARENT_PID: String(process.pid),
      PATH: desktopPath,
      ...(agentCliDiagnostics.claude ? { CLAUDE_CLI_PATH: agentCliDiagnostics.claude } : {}),
      ...(agentCliDiagnostics.codex ? { CODEX_CLI_PATH: agentCliDiagnostics.codex } : {}),
    };
    // A private-release updater token belongs only to the Electron main process.
    delete childEnvironment.GH_TOKEN;
    delete childEnvironment.GITHUB_TOKEN;

    const command = `${runtime.command} ${serverEntry}`;
    this.appendStartupLog(`$ ${command}`);
    this.appendStartupLog(`runtime: ${runtime.label}`);
    this.appendStartupLog(`cwd: ${serverCwd}`);
    this.appendStartupLog(`HOST=${bindHost} SERVER_PORT=${port} NODE_ENV=production LEOCODEBOX_LOCAL_ONLY=${LOCAL_ONLY_ENV_VALUE}`);
    this.appendStartupLog(`agent CLIs: ${Object.entries(agentCliDiagnostics)
      .map(([commandName, executablePath]) => `${commandName}=${executablePath || 'not found'}`)
      .join(', ')}`);

    this.ownedServerProcess = spawn(runtime.command, [serverEntry], {
      cwd: serverCwd,
      detached: true,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const childProcess = this.ownedServerProcess;

    childProcess.once('error', (error) => {
      this.appendStartupLog(`failed to start process: ${error.message}`);
      if (this.ownedServerProcess === childProcess) {
        this.ownedServerProcess = null;
        this.localServerUrl = null;
        this.localServerPort = null;
        this.onChange?.();
      }
    });

    this.ownedServerProcess.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        this.appendStartupLog(line);
      }
    });

    this.ownedServerProcess.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        this.appendStartupLog(`stderr: ${line}`);
      }
    });

    childProcess.once('exit', (code, signal) => {
      this.appendStartupLog(`process exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      if (this.ownedServerProcess) {
	        console.error(`leocodebox desktop server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      }
      if (this.ownedServerProcess === childProcess) {
        this.ownedServerProcess = null;
        this.localServerUrl = null;
        this.localServerPort = null;
        this.onChange?.();
      }
    });
  }

  async resolveLocalServerUrl() {
    const defaultUrl = `http://${HOST}:${DEFAULT_PORT}`;
    const defaultDisplayUrl = `http://${DISPLAY_HOST}:${DEFAULT_PORT}`;
    const devUrl = process.env.ELECTRON_DEV_URL;
    const forceOwnServer = process.env.ELECTRON_FORCE_OWN_SERVER !== '0';

    if (devUrl) {
      const ready = await waitForLeocodeboxServer(defaultUrl, SERVER_START_TIMEOUT_MS);
      if (!ready) {
        throw new Error(`Development backend did not become ready at ${defaultDisplayUrl}`);
      }
      this.localServerPort = DEFAULT_PORT;
      return devUrl;
    }

    if (!forceOwnServer) {
      const candidateUrls = await getExistingServerCandidateUrls(defaultUrl);
      for (const candidateUrl of candidateUrls) {
        if (await isLeocodeboxServer(candidateUrl)) {
          const displayUrl = getDisplayUrl(candidateUrl);
          this.localServerPort = getPortFromUrl(candidateUrl);
	          this.appendStartupLog(`Using existing Local leocodebox at ${displayUrl}`);
          return displayUrl;
        }
      }
    }

    const serverEntry = await this.resolveServerEntry();

    const port = await chooseServerPort(this.getServerBindHost());
    const serverUrl = `http://${HOST}:${port}`;
    const displayUrl = `http://${DISPLAY_HOST}:${port}`;
    this.localServerPort = port;
    this.startBundledServer(port, serverEntry);

    const ready = await waitForLeocodeboxServer(serverUrl, SERVER_START_TIMEOUT_MS);
    if (!ready) {
      const recentLogs = this.getStartupLogs().slice(-20).join('\n');
      await this.shutdownOwnedServer();
      this.localServerPort = null;
      throw new Error([
        `Bundled backend did not become ready at ${displayUrl}.`,
        recentLogs ? `Recent startup output:\n${recentLogs}` : 'No startup output was captured.',
      ].join('\n\n'));
    }

	    this.appendStartupLog(`Local leocodebox ready at ${displayUrl}`);
    this.localServerUrl = displayUrl;
    return displayUrl;
  }

  async ensureLocalServer() {
    if (this.localServerUrl && !await isLeocodeboxServer(this.localServerUrl)) {
      this.appendStartupLog(`Local server health check failed at ${this.localServerUrl}; restarting.`);
      this.localServerUrl = null;
      this.localServerPort = null;
    }
    if (this.localServerUrl) {
      return this.localServerUrl;
    }
    // Concurrent callers must not each spawn a bundled server: the process is
    // only recorded on this.ownedServerProcess and localServerUrl is not set
    // until the very end of startup, so parallel entries would each spawn and
    // clobber ownedServerProcess, leaking orphans. Reuse a single in-flight
    // startup promise and clear it on settle (success or failure) so a later
    // call can retry.
    if (!this.startupPromise) {
      this.startupPromise = this.resolveLocalServerUrl()
        .then((url) => {
          this.localServerUrl = url;
          return url;
        })
        .finally(() => {
          this.startupPromise = null;
        });
    }
    return this.startupPromise;
  }

  async getResolvedTarget() {
    await this.ensureLocalServer();
    return {
	      kind: 'local',
	      name: '本地 leocodebox',
	      url: this.localServerUrl,
    };
  }

  async loadLocalTarget() {
    return {
      pendingTarget: this.getPendingTarget(),
      target: await this.getResolvedTarget(),
    };
  }

  hasOwnedServer() {
    return Boolean(this.ownedServerProcess);
  }

  detachOwnedServer() {
    if (!this.ownedServerProcess) return;
    this.ownedServerProcess.unref();
    this.ownedServerProcess = null;
  }

  async shutdownOwnedServer() {
    if (!this.ownedServerProcess) return;

    const child = this.ownedServerProcess;
    this.ownedServerProcess = null;
    let exited = false;
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process may already have exited between the health check and signal.
      }
    };
    kill('SIGTERM');

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!exited) kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        exited = true;
        clearTimeout(timeout);
        resolve();
      });
    });
    this.localServerUrl = null;
    this.localServerPort = null;
    // Clear any settled/in-flight startup guard so a restart re-resolves cleanly.
    this.startupPromise = null;
    this.onChange?.();
  }
}

export { DEFAULT_PORT, HOST };
