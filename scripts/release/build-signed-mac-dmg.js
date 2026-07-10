import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appName = 'leocodebox.app';
const outputDir = path.resolve('release/desktop');
const sourceApp = path.join(outputDir, 'mac-arm64', appName);
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const outputDmg = path.join(outputDir, `leocodebox-${packageJson.version}-mac-arm64.dmg`);
const outputZipName = `leocodebox-${packageJson.version}-mac-arm64.zip`;
const outputZip = path.join(outputDir, outputZipName);
const updateMetadataPath = path.join(outputDir, 'latest-mac.yml');

// Developer ID signing happens in a clean temporary directory. Every nested
// Mach-O is signed explicitly because codesign --deep does not discover native
// executables stored in arbitrary node_modules resource directories.
const signIdentity = (process.env.LEOCODEBOX_SIGN_IDENTITY || '').trim();
const signerPath = path.resolve('scripts/release/sign-macos-app.sh');
const signatureVerifierPath = path.resolve('scripts/release/verify-macos-signatures.sh');
const appUpdateConfig = [
  'provider: github',
  'owner: leoyb1010',
  'repo: leocodebox',
  'private: true',
  'updaterCacheDirName: leocodebox-updater',
  '',
].join('\n');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'leocodebox-dmg-'));
const signedApp = path.join(tempRoot, appName);
const dmgRoot = path.join(tempRoot, 'image');

try {
  await mkdir(dmgRoot, { recursive: true });
  run('/bin/cp', ['-R', sourceApp, signedApp], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  run('/usr/bin/xattr', ['-cr', signedApp]);
  await writeFile(path.join(signedApp, 'Contents', 'Resources', 'app-update.yml'), appUpdateConfig);
  if (signIdentity) {
    run('/bin/bash', [signerPath, signedApp, signIdentity]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', signedApp]);
    run('/bin/bash', [signatureVerifierPath, signedApp]);
    console.log(`Signed with Developer ID: ${signIdentity}`);
  } else {
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', signedApp]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', signedApp]);
  }

  await rm(outputZip, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', signedApp, outputZip]);
  const [zipSha512, zipStats] = await Promise.all([hashFile(outputZip), stat(outputZip)]);
  await writeFile(updateMetadataPath, [
    `version: ${packageJson.version}`,
    'files:',
    `  - url: ${outputZipName}`,
    `    sha512: ${zipSha512}`,
    `    size: ${zipStats.size}`,
    `path: ${outputZipName}`,
    `sha512: ${zipSha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n'));

  run('/usr/bin/ditto', ['--norsrc', '--noqtn', signedApp, path.join(dmgRoot, appName)]);
  await symlink('/Applications', path.join(dmgRoot, 'Applications'));
  await rm(outputDmg, { force: true });
  run('/usr/bin/hdiutil', [
    'create', '-volname', 'leocodebox', '-srcfolder', dmgRoot,
    '-ov', '-format', 'UDZO', outputDmg,
  ]);
  run('/usr/bin/hdiutil', ['verify', outputDmg]);
  console.log(`Created signed DMG: ${outputDmg}`);
  console.log(`Created updater ZIP: ${outputZip}`);
  console.log(`Created updater metadata: ${updateMetadataPath}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
