import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readStore, sanitizeProvider } from './provider-store.service.js';

type DiagnosticsCliTool = Record<string, unknown>;

type DiagnosticsInput = {
  appVersion: string | null;
  cliTools: DiagnosticsCliTool[];
  switchProviders: ReturnType<typeof sanitizeProvider>[];
  activeByTarget: Record<string, string>;
};

/** Home-directory paths identify the user; collapse them for shareable output. */
export function redactHomePaths<T>(value: T, homeDir = os.homedir()): T {
  const serialized = JSON.stringify(value);
  const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return JSON.parse(serialized.replace(new RegExp(escapedHome, 'g'), '~')) as T;
}

/**
 * Pure assembly so the redaction contract is unit-testable: everything the
 * report contains has already been through sanitizeProvider (API keys reduced
 * to a 4+4 mask) and home paths are collapsed to `~`.
 */
export function buildDiagnosticsReport(input: DiagnosticsInput, homeDir = os.homedir()) {
  return redactHomePaths({
    generatedAt: new Date().toISOString(),
    app: 'leocodebox',
    appVersion: input.appVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    cliTools: input.cliTools,
    leoapi: {
      activeByTarget: input.activeByTarget,
      providers: input.switchProviders,
    },
  }, homeDir);
}

export async function collectDiagnostics(appRoot: string, cliTools: DiagnosticsCliTool[]) {
  let appVersion: string | null = null;
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || null;
  } catch {
    appVersion = null;
  }

  const store = await readStore();
  return buildDiagnosticsReport({
    appVersion,
    cliTools,
    switchProviders: store.providers.map(sanitizeProvider),
    activeByTarget: store.activeByTarget,
  });
}
