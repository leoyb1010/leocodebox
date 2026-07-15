#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'desktop-app');
const macOutputDir = path.join(rootDir, 'release', 'desktop', 'mac-arm64');

const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
);

function getElectronVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
  } catch {
    try {
      return JSON.parse(
        readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
      ).packages['node_modules/electron'].version;
    } catch {
      throw new Error('Could not resolve an exact Electron version for desktop packaging.');
    }
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

async function copyRequired(relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, relativePath);
  if (!(await pathExists(from))) {
    throw new Error(`Required desktop build input is missing: ${relativePath}`);
  }
  await fs.cp(from, to, { recursive: true });
}

async function copyIfExists(relativePath) {
  const from = path.join(rootDir, relativePath);
  if (!(await pathExists(from))) return false;
  await fs.cp(from, path.join(stageDir, relativePath), { recursive: true });
  return true;
}

async function copyNodeModule(packageName) {
  const parts = packageName.split('/');
  const source = path.join(rootDir, 'node_modules', ...parts);
  if (!(await pathExists(source))) return false;

  const target = path.join(stageDir, 'node_modules', ...parts);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  return true;
}

async function findConflictCopies(directory) {
  const matches = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findConflictCopies(fullPath));
    } else if (/(?:\s2| copy|conflicted copy)\.[^.]+$/i.test(entry.name)) {
      matches.push(path.relative(rootDir, fullPath));
    }
  }
  return matches;
}

async function removeConflictCopies(directory) {
  let removed = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await removeConflictCopies(fullPath);
    } else if (/(?:\s2| copy|conflicted copy)\.[^.]+$/i.test(entry.name)) {
      await fs.rm(fullPath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function buildDesktopPackageJson(copiedOptionalDependencies) {
  return {
    name: `${packageJson.name}-desktop`,
    version: packageJson.version,
    productName: packageJson.productName,
    description: `${packageJson.productName} desktop shell`,
    author: packageJson.author,
    license: packageJson.license,
    type: 'module',
    main: 'electron/main.js',
    dependencies: packageJson.dependencies,
    optionalDependencies: copiedOptionalDependencies,
    build: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      asar: packageJson.build.asar,
      artifactName: packageJson.build.artifactName,
      electronVersion: getElectronVersion(),
      directories: {
        output: '../../release/desktop',
      },
      extraMetadata: {
        main: 'electron/main.js',
      },
      files: [
        'electron/**',
        'public/**',
        'dist/**',
        'dist-server/**',
        'node_modules/**',
        // The Claude Agent SDK ships a ~226MB prebuilt CLI binary per platform,
        // but leocodebox always points the SDK at the user's own `claude`
        // executable (see server/modules/providers/list/claude/claude-runtime.js -> pathToClaudeCodeExecutable),
        // so the bundled binary is dead weight. Mirrors the exclusion in the
        // root package.json build.files that the staged config previously lost.
        '!**/node_modules/@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*/**',
        // The codex fallback binary (~300MB) is downloaded on first use into
        // ~/.leocodebox/vendor/codex instead of shipping inside the DMG
        // (see server/modules/providers/list/codex/codex-fallback.service.ts).
        '!**/node_modules/@openai/codex-{darwin,linux,win32}-*/**',
        // Browser automation uses the smaller headless shell. Exclude the full
        // Chrome-for-Testing bundle if a developer installed both variants.
        '!**/node_modules/playwright-core/.local-browsers/chromium-*/**',
        'package.json',
        'README.md',
        'README.zh-CN.md',
        'LICENSE',
        'NOTICE',
      ],
      afterPack: packageJson.build.afterPack,
      protocols: packageJson.build.protocols,
      mac: packageJson.build.mac,
      win: packageJson.build.win,
      nsis: packageJson.build.nsis,
      publish: packageJson.build.publish,
    },
  };
}

// electron-builder does not reliably replace an existing .app bundle on APFS;
// it can create conflict copies such as `leocodebox 2.app`, then recurse into
// a malformed directory tree. Every release stage starts from clean outputs.
await Promise.all([
  fs.rm(stageDir, { recursive: true, force: true }),
  fs.rm(macOutputDir, { recursive: true, force: true }),
]);
await fs.mkdir(stageDir, { recursive: true });

const conflictCopies = (await Promise.all(
  ['src', 'server', 'electron', 'scripts'].map((directory) => findConflictCopies(path.join(rootDir, directory))),
)).flat();
if (conflictCopies.length > 0) {
  throw new Error(`Release input contains conflict-copy files:\n${conflictCopies.join('\n')}`);
}

await copyRequired('electron');
await copyRequired('dist');
await copyRequired('dist-server');
await copyRequired('public');

// public/visuals is a byte-for-byte duplicate of dist/visuals (Vite copies
// public/* into dist/ at build, and the server serves both). Only brand/ is
// read from disk by file path (the launch splash in electron/placeholder.html);
// every other subfolder is HTTP-served and resolves from dist/visuals. Drop the
// redundant subfolders from the shipped app — webp is incompressible, so this is
// the single largest DMG saving. Deleting from the stage is deterministic;
// electron-builder `files` negations of an already-included dir are not.
const stagedVisualsRoot = path.join(stageDir, 'public', 'visuals');
if (await pathExists(stagedVisualsRoot)) {
  for (const entry of await fs.readdir(stagedVisualsRoot)) {
    if (entry !== 'brand') {
      await fs.rm(path.join(stagedVisualsRoot, entry), { recursive: true, force: true });
    }
  }
}

await copyRequired('node_modules');

// Finder/iCloud conflict copies occasionally appear inside installed packages.
// They are never part of the dependency graph and must not enter a release.
const removedDependencyConflictCopies = await removeConflictCopies(
  path.join(stageDir, 'node_modules'),
);

const stagedBrowserRoot = path.join(stageDir, 'node_modules', 'playwright-core', '.local-browsers');
if (await pathExists(stagedBrowserRoot)) {
  for (const entry of await fs.readdir(stagedBrowserRoot)) {
    if (entry.startsWith('chromium-')) {
      await fs.rm(path.join(stagedBrowserRoot, entry), { recursive: true, force: true });
    }
  }
}
await copyRequired('README.md');
await copyRequired('README.zh-CN.md');
await copyRequired('LICENSE');
await copyRequired('NOTICE');
// Signing entitlements (only used when LEOCODEBOX_SIGN_IDENTITY is set; harmless otherwise).
await copyIfExists('build');
// afterPack hook must live in the staged project so electron-builder can run it
// (it strips extended attributes so code signing does not fail on "detritus").
await copyIfExists('scripts/release/after-pack.cjs');

const copiedRuntimeDependencies = [];
if (await copyNodeModule('ws')) {
  copiedRuntimeDependencies.push('ws');
} else {
  throw new Error('Required desktop dependency is missing from node_modules: ws');
}

const copiedOptionalDependencies = {};
for (const [name, version] of Object.entries(packageJson.optionalDependencies || {})) {
  if (await copyNodeModule(name)) {
    copiedOptionalDependencies[name] = version;
  }
}

await fs.writeFile(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildDesktopPackageJson(copiedOptionalDependencies), null, 2)}\n`,
  'utf8',
);

console.log(`Prepared thin desktop app at ${path.relative(rootDir, stageDir)}`);
console.log(`Removed dependency conflict copies: ${removedDependencyConflictCopies}`);
console.log(`Runtime dependencies: ${copiedRuntimeDependencies.join(', ')}`);
if (Object.keys(copiedOptionalDependencies).length) {
  console.log(`Optional dependencies: ${Object.keys(copiedOptionalDependencies).join(', ')}`);
}
