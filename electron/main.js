import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell, webContents } from 'electron';
import updaterPackage from 'electron-updater';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CloudController } from './cloud.js';
import { DesktopWindowManager } from './desktopWindow.js';
import { DesktopNotificationsController } from './desktopNotifications.js';
import { LocalServerController } from './localServer.js';
import { readProductVersion } from './productMetadata.js';
import { TabsController } from './tabs.js';
import { isFirstPartyShellUrl } from './trustPolicy.js';
import { DesktopUpdaterController, clearUpdaterTokenEnvironment } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = updaterPackage;

// electron-updater also reads GITHUB_TOKEN directly. Update credentials must
// come from the encrypted per-user settings store, never inherited env vars.
clearUpdaterTokenEnvironment();

const APP_NAME = 'leocodebox';
const APP_USER_MODEL_ID = 'com.leoyuan.leocodebox';
const CALLBACK_PROTOCOL = 'leocodebox';
const CALLBACK_URL = `${CALLBACK_PROTOCOL}://auth/callback`;
const CLOUDCLI_CONTROL_PLANE_URL = process.env.CLOUDCLI_CONTROL_PLANE_URL || 'https://leocodebox.local';
const LOCAL_ONLY_MODE = true;
const REMOTE_START_TIMEOUT_MS = 30000;
const AUTH_CALLBACK_TTL_MS = 10 * 60 * 1000;

const tabs = new TabsController();

if (LOCAL_ONLY_MODE) {
  const configuredProfilePath = String(process.env.LEOCODEBOX_USER_DATA_DIR || '').trim();
  const localProfilePath = configuredProfilePath
    ? path.resolve(configuredProfilePath)
    : path.join(app.getPath('appData'), APP_NAME, 'LocalProfile');
  mkdirSync(localProfilePath, { recursive: true });
  app.setPath('userData', localProfilePath);
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let activeTarget = { kind: 'launcher', name: APP_NAME, url: null };
let desktopWindow = null;
let localServer = null;
let cloud = null;
let desktopNotifications = null;
let desktopUpdater = null;
let isQuitting = false;
let isRefreshingCloud = false;
let pendingCloudConnectStartedAt = 0;
let productVersion = null;

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getProductVersion() {
  if (!productVersion) {
    productVersion = readProductVersion(getAppRoot(), app.getVersion());
  }
  return productVersion;
}

function getLauncherPath() {
  return path.join(__dirname, 'launcher', 'index.html');
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function getWindowIconPath() {
  if (process.platform === 'darwin') {
    return path.join(getAppRoot(), 'electron', 'assets', 'logo-macos.png');
  }
  return path.join(getAppRoot(), 'public', 'logo-512.png');
}

function getStorePath() {
  return path.join(app.getPath('userData'), 'cloud-account.json');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getDesktopNotificationsSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-notifications-settings.json');
}

function getDesktopUpdaterSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-updater.json');
}

async function clearLocalOnlyWebCaches() {
  await rm(path.join(app.getPath('userData'), 'Service Worker'), { recursive: true, force: true }).catch((error) => {
    console.warn('[leocodebox] Could not remove stale service worker directory:', error?.message || error);
  });

  await session.defaultSession.clearStorageData({
    storages: ['serviceworkers', 'cachestorage'],
  }).catch((error) => {
    console.warn('[leocodebox] Could not clear stale service worker storage:', error?.message || error);
  });
}

function getRunningEnvironmentUrls() {
  if (LOCAL_ONLY_MODE) return [];
  return cloud.getEnvironments()
    .filter((environment) => environment.status === 'running')
    .map((environment) => cloud.getEnvironmentUrl(environment))
    .filter(Boolean);
}

function getDisplayTargetName() {
  return activeTarget?.name || APP_NAME;
}

function getCloudState() {
  if (LOCAL_ONLY_MODE) {
    return {
      account: null,
      environments: [],
      controlPlaneUrl: null,
      localOnly: true,
    };
  }

  return {
    account: cloud.getAccount(),
    environments: cloud.getEnvironments(),
    controlPlaneUrl: CLOUDCLI_CONTROL_PLANE_URL,
    localOnly: false,
  };
}

function getLocalState() {
  return {
    desktopSettings: localServer.getSettings(),
    localServerRunning: Boolean(localServer.getLocalServerUrl()),
    localWebUrl: localServer.getLocalServerUrl(),
    shareableWebUrl: localServer.getShareableWebUrl(),
  };
}

function serializeEnvironment(environment) {
  return {
    id: environment.id,
    name: environment.name,
    subdomain: environment.subdomain,
    access_url: cloud.getEnvironmentUrl(environment),
    status: environment.status,
    created_at: environment.created_at,
    github_url: environment.github_url || null,
    region: environment.region || null,
    agent: environment.agent || null,
  };
}

function getDesktopState() {
  const cloudAccount = LOCAL_ONLY_MODE ? null : cloud.getAccount();
  const localState = getLocalState();
  const authState = LOCAL_ONLY_MODE ? 'local_only' : cloud.getAuthState();
  return {
    appVersion: getProductVersion(),
    localOnly: LOCAL_ONLY_MODE,
    account: {
      connected: !LOCAL_ONLY_MODE && authState === 'connected',
      email: cloudAccount?.email || null,
      authState,
      requiresReconnect: authState === 'expired',
    },
    activeTarget,
    desktopSettings: localState.desktopSettings,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    localServerRunning: localState.localServerRunning,
    localStartupLogs: localServer.getStartupLogs(),
    cloudLoading: isRefreshingCloud,
    tabs: tabs.getSerializableTabs(),
    activeTabId: tabs.activeTabId,
    environments: LOCAL_ONLY_MODE ? [] : cloud.getEnvironments().map(serializeEnvironment),
    desktopNotifications: LOCAL_ONLY_MODE
      ? { enabled: false, supported: false, connectedCount: 0, targetCount: 0 }
      : (desktopNotifications?.getState() || { enabled: false, supported: false, connectedCount: 0, targetCount: 0 }),
    desktopUpdater: desktopUpdater?.getState() || null,
  };
}

function emitDesktopUpdaterState(state = desktopUpdater?.getState()) {
  if (!state) return;
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) {
      contents.send('leocodebox-desktop:update-state', state);
    }
  }
  syncDesktopState();
}

async function openExternalUrl(url) {
  if (String(url).startsWith(CALLBACK_PROTOCOL + "://")) {
    if (LOCAL_ONLY_MODE) {
      throw new Error('Cloud account callbacks are disabled in local-only mode.');
    }
    await handleDeepLink(url);
    return;
  }

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('Invalid external URL.');
  }

  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw new Error(`Refusing to open unsupported URL scheme: ${parsed.protocol}`);
  }

  await shell.openExternal(url);
}

function isAllowedLocalAuthOrigin(origin) {
  if (!LOCAL_ONLY_MODE || !localServer) return false;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:') return false;
  const hostAllowed = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (!hostAllowed) return false;

  if (process.env.ELECTRON_DEV_URL) {
    try {
      if (new URL(process.env.ELECTRON_DEV_URL).origin === parsed.origin) return true;
    } catch {
      // Ignore malformed development URLs and fall through to the server origin check.
    }
  }

  const port = localServer.getLocalServerPort();
  if (!port) return false;
  return hostAllowed && Number.parseInt(parsed.port || '80', 10) === port;
}

function isTrustedLocalIpcSender(event, claimedOrigin = null) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  let senderOrigin;
  try {
    senderOrigin = new URL(senderUrl).origin;
  } catch {
    return false;
  }
  if (!isAllowedLocalAuthOrigin(senderOrigin)) return false;
  if (!claimedOrigin) return true;
  try {
    return new URL(String(claimedOrigin)).origin === senderOrigin;
  } catch {
    return false;
  }
}

function requireTrustedLocalIpcSender(event) {
  if (!isTrustedLocalIpcSender(event)) {
    throw new Error('Rejected privileged desktop request from an untrusted renderer.');
  }
}

// The first-party desktop shell chrome is loaded from disk (file://) and drives
// the privileged leocodeboxDesktop bridge; it is not an http-loopback origin, so
// isTrustedLocalIpcSender would reject it. Treat file:// as trusted here in
// addition to the loopback local server (covered by isTrustedLocalIpcSender).
function isFirstPartyShellSender(event) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isFirstPartyShellUrl(senderUrl, getLauncherPath());
}

function isTrustedDesktopUiSender(event) {
  return isFirstPartyShellSender(event) || isTrustedLocalIpcSender(event);
}

function requireTrustedDesktopUiSender(event) {
  if (!isTrustedDesktopUiSender(event)) {
    throw new Error('Rejected privileged desktop request from an untrusted renderer.');
  }
}

// Desktop state is also readable by remote *.leocodebox.local environment pages
// (via the leocodeboxDesktopNotifications bridge). localStartupLogs leaks the
// full PATH, absolute CLI paths, and the user's home directory, so strip it for
// any caller that is not the trusted first-party shell / local server.
function getDesktopStateForSender(event) {
  const state = getDesktopState();
  if (isTrustedDesktopUiSender(event)) return state;
  const { localStartupLogs, ...safeState } = state;
  return safeState;
}

async function showError(title, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${title}: ${message}`);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'error',
    title,
    message: title,
    detail: message,
  });
}

function isExpectedNavigationAbort(error) {
  const message = error instanceof Error ? error.message : String(error);
  // ERR_ABORTED (-3) and ERR_FAILED (-2) both occur benignly when a view is torn
  // down mid-load (e.g. during quit or tab switch); neither should surface a dialog.
  return error?.code === 'ERR_ABORTED'
    || error?.code === 'ERR_FAILED'
    || message.includes('ERR_ABORTED')
    || message.includes('ERR_FAILED')
    || message.includes('(-3)')
    || message.includes('(-2)')
    || message.includes('Render frame was disposed')
    || message.includes('Script failed to execute');
}

function syncDesktopState() {
  if (!desktopWindow || isQuitting) return;
  desktopWindow.buildAppMenu();
  desktopWindow.emitDesktopState();
  if (activeTarget?.kind === 'local' && !localServer?.getLocalServerUrl()) {
    void desktopWindow.showLocalStartupTarget(localServer.getPendingTarget(), localServer.getStartupLogs())
      .catch((error) => {
        if (isExpectedNavigationAbort(error)) return;
        void showError('Could not update local startup log', error);
      });
  }
}

function setActiveTarget(target) {
  activeTarget = target;
}

function getEnvironmentTarget(environment) {
  return {
    kind: 'remote',
    id: environment.id,
    name: environment.name || environment.subdomain,
    url: cloud.getEnvironmentUrl(environment),
  };
}

async function getEnvironmentLaunchTarget(environment) {
  const environmentUrl = cloud.getEnvironmentUrl(environment);
  return {
    ...getEnvironmentTarget(environment),
    url: environmentUrl,
    loadUrl: await cloud.getEnvironmentLaunchUrl(environment),
  };
}

async function hasCloudWebSession() {
  if (LOCAL_ONLY_MODE) return false;
  const cookies = await session.defaultSession.cookies.get({});
  return cookies.some((cookie) => {
    const cookieDomain = String(cookie.domain || '');
    return cookieDomain.includes('leocodebox.local')
      && /-auth-token(?:\.\d+)?$/.test(cookie.name)
      && Boolean(cookie.value);
  });
}

function isCloudAuthRedirect(url) {
  if (LOCAL_ONLY_MODE) return false;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const controlPlane = new URL(CLOUDCLI_CONTROL_PLANE_URL);
    return parsed.origin === controlPlane.origin
      && (parsed.pathname === '/login' || parsed.pathname.startsWith('/auth/'));
  } catch {
    return false;
  }
}

function getDiagnosticsText() {
  const cloudAccount = LOCAL_ONLY_MODE ? null : cloud.getAccount();
  const localState = getLocalState();
  return JSON.stringify({
    app: APP_NAME,
    version: getProductVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    appPath: getAppRoot(),
    userDataPath: app.getPath('userData'),
    activeTarget,
    localServerUrl: localState.localWebUrl,
    localServerPort: localServer.localServerPort,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    desktopSettings: localState.desktopSettings,
    localOnly: LOCAL_ONLY_MODE,
    cloudConnected: Boolean(cloudAccount?.apiKey),
    cloudEmail: cloudAccount?.email || null,
    cloudEnvironmentCount: LOCAL_ONLY_MODE ? 0 : cloud.getEnvironments().length,
    cloudRunningEnvironmentCount: getRunningEnvironmentUrls().length,
    cloudAuthState: LOCAL_ONLY_MODE ? 'local_only' : cloud.getAuthState(),
    cloudAccountPath: getStorePath(),
    controlPlaneUrl: LOCAL_ONLY_MODE ? null : CLOUDCLI_CONTROL_PLANE_URL,
    localStartupLogs: localServer.getStartupLogs().slice(-100),
  }, null, 2);
}

async function copyDiagnostics() {
  clipboard.writeText(getDiagnosticsText());
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Diagnostics copied',
    message: 'leocodebox desktop diagnostics were copied to the clipboard.',
  });
}

async function refreshCloudEnvironments({ showErrors = false } = {}) {
  if (LOCAL_ONLY_MODE) {
    isRefreshingCloud = false;
    syncDesktopState();
    return [];
  }

  isRefreshingCloud = true;
  syncDesktopState();
  try {
    return await cloud.refreshCloudEnvironments();
  } catch (error) {
    const authState = cloud.getAuthState();
    if (authState === 'expired') {
      const expiredError = new Error('Your leocodebox session expired. Reconnect your account.');
      if (showErrors) {
        await showError('leocodebox login required', expiredError);
        return [];
      }
      throw expiredError;
    }
    if (showErrors) {
      await showError('Could not load leocodebox environments', error);
      return [];
    }
    throw error;
  } finally {
    isRefreshingCloud = false;
    void desktopNotifications?.sync().catch((error) => console.error('[DesktopNotifications] sync failed:', error?.message || error));
    syncDesktopState();
  }
}

async function connectCloudAccount() {
  if (LOCAL_ONLY_MODE) {
    return null;
  }

  const connectUrl = cloud.buildConnectUrl();
  pendingCloudConnectStartedAt = Date.now();
  clipboard.writeText(connectUrl);
  await openExternalUrl(connectUrl);
  return connectUrl;
}

async function handleDeepLink(url) {
  if (LOCAL_ONLY_MODE) return;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol !== `${CALLBACK_PROTOCOL}:` || parsed.hostname !== 'auth') {
    return;
  }

  if (!pendingCloudConnectStartedAt || Date.now() - pendingCloudConnectStartedAt > AUTH_CALLBACK_TTL_MS) {
    await showError('leocodebox account connection failed', new Error('No recent leocodebox account connection was started from this app.'));
    return;
  }

  const apiKey = parsed.searchParams.get('api_key');
  if (!apiKey) {
    await showError('leocodebox account connection failed', new Error('The callback did not include an API key.'));
    return;
  }

  await cloud.saveFromCallback({
    apiKey,
    email: parsed.searchParams.get('email'),
  });
  pendingCloudConnectStartedAt = 0;
  await refreshCloudEnvironments({ showErrors: true });

  dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'leocodebox account connected',
    message: cloud.getAccount()?.email ? `Connected as ${cloud.getAccount().email}.` : 'leocodebox account connected.',
  }).catch(() => {});
}

async function copyLocalWebUrl() {
  await localServer.ensureLocalServer();
  const shareableUrl = localServer.getShareableWebUrl();
  const localUrl = localServer.getLocalServerUrl();

  if (!shareableUrl) {
    throw new Error('Local leocodebox URL is not available yet.');
  }

  clipboard.writeText(shareableUrl);
  const isLanUrl = shareableUrl !== localUrl;
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Web URL copied',
    message: isLanUrl ? 'LAN web URL copied.' : 'Local web URL copied.',
    detail: isLanUrl
      ? `${shareableUrl}\n\nUse this URL from another device on the same network.`
	      : `${shareableUrl}\n\nThis URL works on this computer. Enable LAN access before starting Local leocodebox to copy a phone-accessible URL.`,
  });

  return getDesktopState();
}

async function openLocalWebUi() {
  await localServer.ensureLocalServer();
  const url = localServer.getShareableWebUrl() || localServer.getLocalServerUrl();
  if (!url) {
    throw new Error('Local leocodebox URL is not available yet.');
  }

  await openExternalUrl(url);
  return getDesktopState();
}

async function updateDesktopSetting(key, value) {
  const result = await localServer.updateDesktopSetting(key, value);
  syncDesktopState();

  if (result.requiresRestartNotice) {
    await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
      type: 'info',
      title: 'Restart local server to apply',
      message: 'LAN access changes apply the next time the local server starts.',
	      detail: 'Quit leocodebox and stop the local server, then open Local leocodebox again.',
    });
  }

  return getDesktopState();
}

async function showEnvironmentPicker() {
  if (LOCAL_ONLY_MODE) {
    return openLocalInDesktop();
  }

  let environments = cloud.getEnvironments();
  let refreshError = null;

  if (cloud.getAccount()?.apiKey) {
    try {
      environments = await refreshCloudEnvironments({ showErrors: false });
    } catch (error) {
      refreshError = error;
      console.warn('[Cloud] Could not refresh environments before showing picker:', error?.message || error);
    }
  }

  const choices = ['Local leocodebox', ...environments.map((environment) => {
    const status = environment.status === 'running' ? '' : ` (${environment.status})`;
    return `${environment.name || environment.subdomain}${status}`;
  })];

  const response = await dialog.showMessageBox(desktopWindow?.getMainWindow(), {
    type: 'question',
    buttons: [...choices, 'Cancel'],
    defaultId: 0,
    cancelId: choices.length,
    title: 'Switch leocodebox Environment',
    message: 'Choose where this desktop window should connect.',
    detail: refreshError ? `Cloud environments could not be refreshed. Showing cached environments.\n\n${refreshError.message || refreshError}` : undefined,
  });

  if (response.response === choices.length) return getDesktopState();
  if (response.response === 0) return openLocalInDesktop();
  return openEnvironmentInDesktop(environments[response.response - 1]);
}

async function startEnvironment(environment) {
  if (LOCAL_ONLY_MODE) {
    throw new Error('Cloud environments are disabled in local-only mode.');
  }
  await cloud.startEnvironmentAndWait(environment, REMOTE_START_TIMEOUT_MS);
  await refreshCloudEnvironments({ showErrors: true });
  return getDesktopState();
}

async function stopEnvironment(environment) {
  if (LOCAL_ONLY_MODE) {
    throw new Error('Cloud environments are disabled in local-only mode.');
  }
  await cloud.stopEnvironment(environment);
  await refreshCloudEnvironments({ showErrors: true });
  return getDesktopState();
}

async function openEnvironmentInBrowser(environment) {
  if (LOCAL_ONLY_MODE) {
    throw new Error('Cloud environments are disabled in local-only mode.');
  }
  await openExternalUrl(await cloud.getEnvironmentLaunchUrl(environment));
  return getDesktopState();
}

function getProjectFolder(environment) {
  return String(environment.name || environment.subdomain || 'workspace').replace(/[^a-zA-Z0-9-]/g, '');
}

function getSshTarget(credentials) {
  if (credentials.ssh_command) {
    const parts = String(credentials.ssh_command).split(/\s+/);
    if (parts.length >= 2) return parts[1];
  }
  return `${credentials.username}@ssh.leocodebox.local`;
}

function getSshHost(credentials) {
  const target = getSshTarget(credentials);
  const atIndex = target.indexOf('@');
  return atIndex >= 0 ? target.slice(atIndex + 1) : 'ssh.leocodebox.local';
}

function getSafeSshUsername(credentials) {
  const username = String(credentials.username || '');
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new Error('Cloud environment returned an invalid SSH username.');
  }
  return username;
}

function getSafeSshHost(credentials) {
  const host = getSshHost(credentials);
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error('Cloud environment returned an invalid SSH host.');
  }
  return host;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function getEnvironmentCredentials(environment) {
  const credentials = await cloud.getEnvironmentCredentials(environment);
  if (credentials.password) {
    clipboard.writeText(credentials.password);
  }
  return credentials;
}

async function openEnvironmentInIde(environment, ide) {
  const credentials = await getEnvironmentCredentials(environment);
  const scheme = ide === 'cursor' ? 'cursor' : 'vscode';
  const remoteUri = `${scheme}://vscode-remote/ssh-remote+${getSafeSshUsername(credentials)}@${getSafeSshHost(credentials)}/workspace/${getProjectFolder(environment)}?windowId=_blank`;
  await shell.openExternal(remoteUri);
  return getDesktopState();
}

async function openEnvironmentInSsh(environment) {
  const credentials = await getEnvironmentCredentials(environment);
  const remoteCommand = `cd /workspace/${getProjectFolder(environment)} && exec $SHELL -l`;
  const sshCommand = `ssh -t ${shellQuote(getSshTarget(credentials))} ${shellQuote(remoteCommand)}`;

  if (process.platform === 'darwin') {
    const escaped = sshCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${escaped}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    clipboard.writeText(sshCommand);
    await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
      type: 'info',
      title: 'SSH command copied',
      message: 'The SSH command was copied to the clipboard.',
      detail: sshCommand,
    });
  }

  return getDesktopState();
}

async function copyEnvironmentMobileUrl(environment) {
  if (LOCAL_ONLY_MODE) {
    throw new Error('Cloud environments are disabled in local-only mode.');
  }
  const url = cloud.getEnvironmentUrl(environment);
  clipboard.writeText(url);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Environment URL copied',
    message: 'Use this URL from your mobile browser.',
    detail: url,
  });
  return getDesktopState();
}

async function openCloudDashboard() {
  if (LOCAL_ONLY_MODE) {
    return getDesktopState();
  }
  await openExternalUrl(CLOUDCLI_CONTROL_PLANE_URL);
  return getDesktopState();
}

function getActiveRemoteEnvironment() {
  if (LOCAL_ONLY_MODE) return null;
  if (activeTarget?.kind !== 'remote') return null;
  return cloud.findEnvironment(activeTarget.id);
}

async function runActiveEnvironmentAction(action) {
  const environment = getActiveRemoteEnvironment();
  if (!environment) {
    throw new Error('Open a cloud environment first.');
  }

  switch (action) {
    case 'web':
      return openEnvironmentInBrowser(environment);
    case 'vscode':
      return openEnvironmentInIde(environment, 'vscode');
    case 'cursor':
      return openEnvironmentInIde(environment, 'cursor');
    case 'ssh':
      return openEnvironmentInSsh(environment);
    case 'mobile':
      return copyEnvironmentMobileUrl(environment);
    default:
      throw new Error(`Unknown environment action: ${action}`);
  }
}

async function openLocalInDesktop() {
  const existingTab = tabs.getTab('local');
  if (existingTab && localServer.getLocalServerUrl()) {
    await desktopWindow.showTarget(await localServer.getResolvedTarget());
    desktopWindow.showMainWindow();
    return getDesktopState();
  }

  const pendingTarget = localServer.getPendingTarget();
  tabs.upsertTarget(pendingTarget);
  setActiveTarget(pendingTarget);
  await desktopWindow.showLocalStartupTarget(pendingTarget, localServer.getStartupLogs());
  desktopWindow.showMainWindow();
  desktopWindow.emitDesktopState();

  const target = await localServer.getResolvedTarget();
  await desktopWindow.showTarget(target);
  return getDesktopState();
}

async function openSwitchInDesktop() {
  await openLocalInDesktop();
  desktopWindow.emitLocalModal('leoapi');
  return getDesktopState();
}

async function openEnvironmentInDesktop(environment) {
  if (LOCAL_ONLY_MODE) {
    return openLocalInDesktop();
  }

  const pendingTarget = getEnvironmentTarget(environment);
  const tabId = tabs.getTabIdForTarget(pendingTarget);
  const hadTab = Boolean(tabs.getTab(tabId));
  const previousTabId = tabs.activeTabId;

  if (!hadTab) {
    await desktopWindow.showTabPlaceholder(
      pendingTarget,
      `${environment.status === 'running' ? 'Opening' : 'Starting'} ${pendingTarget.name}...`,
    );
    tabs.upsertTarget(pendingTarget);
    desktopWindow.emitDesktopState();
  }

  let nextEnvironment = environment;

  if (environment.status !== 'running') {
    const response = await dialog.showMessageBox(desktopWindow?.getMainWindow(), {
      type: 'question',
      buttons: ['Start Environment', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Start environment?',
      message: `${pendingTarget.name} is ${environment.status}.`,
      detail: 'leocodebox can start it before opening the remote app.',
    });

    if (response.response !== 0) {
      if (!hadTab) {
        tabs.remove(tabId);
        desktopWindow.destroyTabView(tabId);
        if (previousTabId && previousTabId !== tabId) {
          await desktopWindow.switchDesktopTab(previousTabId);
        } else {
          await desktopWindow.showLauncher();
        }
      }
      return getDesktopState();
    }

    if (hadTab) {
      await desktopWindow.showTabPlaceholder(pendingTarget, `Starting ${pendingTarget.name}...`);
      tabs.upsertTarget(pendingTarget);
      desktopWindow.emitDesktopState();
    }

    nextEnvironment = await cloud.startEnvironmentAndWait(environment, REMOTE_START_TIMEOUT_MS);
  }

  let target = getEnvironmentTarget(nextEnvironment);
  if (!(await hasCloudWebSession())) {
    target = await getEnvironmentLaunchTarget(nextEnvironment);
  }

  const usedBootstrap = Boolean(target.loadUrl);
  const finalUrl = await desktopWindow.showTarget(target);
  if (!usedBootstrap && isCloudAuthRedirect(finalUrl)) {
    const bootstrapTarget = await getEnvironmentLaunchTarget(nextEnvironment);
    bootstrapTarget.forceLoad = true;
    await desktopWindow.showTarget(bootstrapTarget);
  }
  return getDesktopState();
}

function findEnvironmentByUrl(environmentUrl) {
  if (LOCAL_ONLY_MODE) return null;

  const targetOrigin = (() => {
    try {
      return new URL(environmentUrl).origin;
    } catch {
      return null;
    }
  })();
  if (!targetOrigin) return null;

  return cloud.getEnvironments().find((environment) => {
    try {
      return new URL(cloud.getEnvironmentUrl(environment)).origin === targetOrigin;
    } catch {
      return false;
    }
  }) || null;
}

async function openNotificationTarget({ environmentUrl, sessionId = null }) {
  if (LOCAL_ONLY_MODE) {
    return openLocalInDesktop();
  }

  const window = desktopWindow?.getMainWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  const environment = findEnvironmentByUrl(environmentUrl);
  if (environment) {
    await openEnvironmentInDesktop(environment);
  } else {
    const parsed = new URL(environmentUrl);
    await desktopWindow.showTarget({
      kind: 'remote',
      name: parsed.hostname,
      url: parsed.origin,
    });
  }

  const targetUrl = new URL(sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/', environmentUrl).toString();
  await desktopWindow.navigateActiveView(targetUrl);
  return getDesktopState();
}

async function getEnvironmentAuthToken(environmentUrl) {
  if (LOCAL_ONLY_MODE) return null;
  return (await desktopWindow?.readAuthTokenForTarget(environmentUrl)) || null;
}

async function clearCloudAccount() {
  if (LOCAL_ONLY_MODE) {
    syncDesktopState();
    return getDesktopState();
  }

  await cloud.clearCloudAccount();
  desktopNotifications?.stop();
  const removedTabs = tabs.removeByKind('remote');
  for (const tab of removedTabs) {
    desktopWindow?.destroyTabView(tab.id);
  }
  if (activeTarget?.kind === 'remote') {
    await desktopWindow?.showLauncher();
  } else {
    syncDesktopState();
  }
  return getDesktopState();
}

function getRemoteEnvironmentMenuItems() {
  if (LOCAL_ONLY_MODE) return [];

  const cloudAccount = cloud.getAccount();
  const environments = cloud.getEnvironments();

  if (!cloudAccount?.apiKey) {
    return [{ label: 'Connect leocodebox Account...', click: () => void connectCloudAccount() }];
  }

  if (!environments.length) {
    return [{ label: 'No environments found', enabled: false }];
  }

  return environments.map((environment) => ({
    label: `${environment.name || environment.subdomain}${environment.status === 'running' ? '' : ` (${environment.status})`}`,
    click: () => void openEnvironmentInDesktop(environment)
      .catch((error) => showError('Could not open environment', error)),
  }));
}

function registerProtocolHandler() {
  if (LOCAL_ONLY_MODE) return;

  const appEntry = path.join(getAppRoot(), 'electron', 'main.js');
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(CALLBACK_PROTOCOL, process.execPath, [appEntry]);
  } else {
    app.setAsDefaultProtocolClient(CALLBACK_PROTOCOL);
  }
}

function registerIpcHandlers() {
  // Registers a handler that first rejects any sender that is not the trusted
  // first-party desktop shell (file://) or the local leocodebox server (loopback
  // in local-only mode). Used for privileged, side-effectful channels so a
  // hijacked or navigated-away BrowserView cannot invoke them.
  const trustedHandle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      requireTrustedDesktopUiSender(event);
      return fn(event, ...args);
    });

  ipcMain.on('leocodebox:get-local-auth-token', (event, origin) => {
    event.returnValue = isTrustedLocalIpcSender(event, origin) ? localServer.getLocalAuthToken() : null;
  });

  ipcMain.handle('leocodebox-desktop:set-theme-mode', async (event, mode) => {
    requireTrustedLocalIpcSender(event);
    if (!['system', 'light', 'dark'].includes(mode)) {
      throw new Error('Invalid desktop theme mode.');
    }
    return updateDesktopSetting('themeMode', mode);
  });

  trustedHandle('leocodebox-desktop:connect-cloud', async () => ({
    ...getDesktopState(),
    connectUrl: await connectCloudAccount(),
  }));

  trustedHandle('leocodebox-desktop:copy-diagnostics', async () => {
    await copyDiagnostics();
    return getDesktopState();
  });

  trustedHandle('leocodebox-desktop:copy-local-web-url', async () => copyLocalWebUrl());
  // get-state is intentionally NOT gated with trustedHandle: it is also read by
  // remote *.leocodebox.local environment pages via the notifications bridge.
  // Those untrusted callers get a state with localStartupLogs stripped.
  ipcMain.handle('leocodebox-desktop:get-state', (event) => getDesktopStateForSender(event));
  trustedHandle('leocodebox-desktop:open-cloud-dashboard', async () => openCloudDashboard());
  trustedHandle('leocodebox-desktop:run-active-environment-action', async (_event, action) => runActiveEnvironmentAction(action));
  trustedHandle('leocodebox-desktop:open-environment', async (_event, environmentId) => {
    const environment = cloud.findEnvironment(environmentId);
    if (!environment) {
      throw new Error('Environment not found. Refresh and try again.');
    }
    return openEnvironmentInDesktop(environment);
  });
  trustedHandle('leocodebox-desktop:open-local', async () => openLocalInDesktop());
  trustedHandle('leocodebox-desktop:open-switch', async () => openSwitchInDesktop());
  trustedHandle('leocodebox-desktop:open-local-web-ui', async () => openLocalWebUi());
  trustedHandle('leocodebox-desktop:refresh-environments', async () => {
    await refreshCloudEnvironments({ showErrors: true });
    return getDesktopState();
  });
  trustedHandle('leocodebox-desktop:disconnect-cloud', async () => clearCloudAccount());
  trustedHandle('leocodebox-desktop:reload-active-tab', async () => desktopWindow.reloadActiveTab());
  trustedHandle('leocodebox-desktop:show-environment-picker', async () => showEnvironmentPicker());
  trustedHandle('leocodebox-desktop:show-launcher', async () => {
    await desktopWindow.showLauncher();
    return getDesktopState();
  });
  // update-desktop-notifications is a designed-public app-origin channel (the
  // leocodebox web UI, local or remote, manages its own notification prefs), so
  // it is not sender-gated; its returned state is redacted for untrusted callers.
  ipcMain.handle('leocodebox-desktop:update-desktop-notifications', async (event, settings) => {
    if (LOCAL_ONLY_MODE) return getDesktopStateForSender(event);
    await desktopNotifications?.saveSettings(settings);
    return getDesktopStateForSender(event);
  });
  trustedHandle('leocodebox-desktop:show-desktop-settings', async () => desktopWindow.showDesktopSettings());
  trustedHandle('leocodebox-desktop:show-local-settings', async () => desktopWindow.showLocalSettings());
  trustedHandle('leocodebox-desktop:close-settings-window', async () => {
    desktopWindow.closeSettingsWindow();
    return getDesktopState();
  });
  trustedHandle('leocodebox-desktop:show-active-environment-actions-menu', async () => desktopWindow.showActiveEnvironmentActionsMenu());
  trustedHandle('leocodebox-desktop:show-environment-actions-menu', async (_event, environmentId) => desktopWindow.showEnvironmentActionsMenu(environmentId));
  trustedHandle('leocodebox-desktop:switch-tab', async (_event, tabId) => desktopWindow.switchDesktopTab(tabId));
  trustedHandle('leocodebox-desktop:close-tab', async (_event, tabId) => desktopWindow.closeDesktopTab(tabId));
  trustedHandle('leocodebox-desktop:update-setting', async (_event, key, value) => updateDesktopSetting(key, value));
  ipcMain.handle('leocodebox-desktop:update-get-state', (event) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.getState();
  });
  ipcMain.handle('leocodebox-desktop:update-set-token', async (event, token) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.saveGithubToken(token);
  });
  ipcMain.handle('leocodebox-desktop:update-check', async (event) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.checkForUpdates();
  });
  ipcMain.handle('leocodebox-desktop:update-download', async (event) => {
    requireTrustedLocalIpcSender(event);
    return desktopUpdater.downloadUpdate();
  });
  ipcMain.handle('leocodebox-desktop:update-install', async (event) => {
    requireTrustedLocalIpcSender(event);
    await desktopUpdater.installUpdate(async () => {
      isQuitting = true;
      desktopNotifications?.stop();
      await localServer?.shutdownOwnedServer();
    });
    return desktopUpdater.getState();
  });
}

function registerAppEvents() {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (LOCAL_ONLY_MODE) return;
    void handleDeepLink(url);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopen = desktopWindow ? desktopWindow.createWindow() : createDesktopWindow();
      void reopen.catch((error) => {
        if (isExpectedNavigationAbort(error)) return;
        void showError('Could not reopen leocodebox', error);
      });
      return;
    }

    const window = desktopWindow?.getMainWindow();
    if (window) {
      window.show();
      window.focus();
    }
  });

  app.on('before-quit', () => {
    desktopNotifications?.stop();
  });

  app.on('before-quit', (event) => {
    if (isQuitting || !localServer?.hasOwnedServer()) return;

    event.preventDefault();
    isQuitting = true;
    void localServer.shutdownOwnedServer().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

async function createDesktopWindow() {
  desktopWindow = new DesktopWindowManager({
    appName: APP_NAME,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getDisplayTargetName,
    getRemoteEnvironmentMenuItems,
    getCloudState,
    getLocalState,
    tabs,
    actions: {
      copyDiagnostics,
      copyText: (text) => clipboard.writeText(text),
      clearCloudAccount,
      connectCloudAccount,
      getActiveTarget: () => activeTarget,
      getEnvironmentUrl: (environment) => cloud.getEnvironmentUrl(environment),
      openEnvironmentInBrowser,
      openEnvironmentInDesktop,
      openEnvironmentInIde,
      openEnvironmentInSsh,
      openLocalInDesktop,
      openLocalWebUi,
      openCloudDashboard,
      refreshCloudEnvironments: () => refreshCloudEnvironments({ showErrors: true }),
      setActiveTarget,
      showEnvironmentPicker,
      showError,
      startEnvironment,
      stopEnvironment,
      updateDesktopSetting,
      copyLocalWebUrl,
      openNotificationTarget,
    },
  });

  desktopWindow.createTray();
  desktopWindow.configurePermissions();
  await desktopWindow.createWindow();
}

function registerSingleInstance() {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', (_event, argv) => {
    const deepLink = LOCAL_ONLY_MODE ? null : argv.find((arg) => arg.startsWith(`${CALLBACK_PROTOCOL}://`));
    if (deepLink) {
      void handleDeepLink(deepLink);
    }

    const window = desktopWindow?.getMainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  return true;
}

async function bootstrap() {
  app.name = APP_NAME;
  app.setName(APP_NAME);
  process.title = APP_NAME;

  await app.whenReady();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: getProductVersion(),
    copyright: 'leocodebox',
  });

  await clearLocalOnlyWebCaches();

  localServer = new LocalServerController({
    appRoot: getAppRoot(),
    settingsPath: getSettingsPath(),
    isPackaged: app.isPackaged,
    appVersion: getProductVersion(),
    onChange: syncDesktopState,
  });
  cloud = new CloudController({
    storePath: getStorePath(),
    controlPlaneUrl: CLOUDCLI_CONTROL_PLANE_URL,
    callbackUrl: CALLBACK_URL,
    onChange: syncDesktopState,
  });
  desktopNotifications = new DesktopNotificationsController({
    settingsPath: getDesktopNotificationsSettingsPath(),
    appVersion: getProductVersion(),
    appName: APP_NAME,
    getDeviceId: () => cloud.getAccount()?.deviceId || '',
    getAccountEmail: () => cloud.getAccount()?.email || null,
    getRunningEnvironmentUrls,
    getApiKey: () => cloud.getAccount()?.apiKey || '',
    getAuthToken: getEnvironmentAuthToken,
    getIconPath: getWindowIconPath,
    openNotificationTarget,
    onChange: syncDesktopState,
  });
  desktopUpdater = new DesktopUpdaterController({
    appVersion: getProductVersion(),
    isPackaged: app.isPackaged,
    settingsPath: getDesktopUpdaterSettingsPath(),
    onChange: emitDesktopUpdaterState,
    updater: autoUpdater,
    storage: safeStorage,
  });

  await localServer.loadDesktopSettings();
  await desktopUpdater.load();
  if (!LOCAL_ONLY_MODE) {
    await cloud.loadCloudAccount();
    await desktopNotifications.loadSettings();
  }

  registerProtocolHandler();
  registerIpcHandlers();
  registerAppEvents();
  await createDesktopWindow();
  await openLocalInDesktop();
  if (desktopUpdater.getState().configured) {
    setTimeout(() => {
      void desktopUpdater.checkForUpdates();
    }, 15_000);
  }
  if (!LOCAL_ONLY_MODE) {
    void refreshCloudEnvironments({ showErrors: false });
  }
}

if (registerSingleInstance()) {
  bootstrap().catch(async (error) => {
    await showError('leocodebox failed to start', error);
    app.quit();
  });
}
