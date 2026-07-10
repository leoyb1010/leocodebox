import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appName = 'leocodebox.app';
const outputDir = path.resolve('release/desktop');
const sourceApp = path.join(outputDir, 'mac-arm64', appName);
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const outputDmg = path.join(outputDir, `leocodebox-${packageJson.version}-mac-arm64.dmg`);

// When a Developer ID is provided, produce a real (notarizable) signature with a
// secure timestamp + hardened runtime + entitlements. Otherwise fall back to an
// ad-hoc signature for local self-use. The copy-to-temp + xattr -cr above is what
// makes signing succeed where electron-builder's in-place signer hits
// "resource fork, Finder information, or similar detritus not allowed".
const signIdentity = (process.env.LEOCODEBOX_SIGN_IDENTITY || '').trim();
const entitlementsPath = path.resolve('build/entitlements.mac.plist');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
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
  if (signIdentity) {
    run('/usr/bin/codesign', [
      '--force', '--deep', '--options', 'runtime', '--timestamp',
      '--entitlements', entitlementsPath,
      '--sign', signIdentity, signedApp,
    ]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', signedApp]);
    console.log(`Signed with Developer ID: ${signIdentity}`);
  } else {
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', signedApp]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', signedApp]);
  }
  run('/bin/cp', ['-R', signedApp, path.join(dmgRoot, appName)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  await symlink('/Applications', path.join(dmgRoot, 'Applications'));
  await rm(outputDmg, { force: true });
  run('/usr/bin/hdiutil', [
    'create', '-volname', 'leocodebox', '-srcfolder', dmgRoot,
    '-ov', '-format', 'UDZO', outputDmg,
  ]);
  run('/usr/bin/hdiutil', ['verify', outputDmg]);
  console.log(`Created signed DMG: ${outputDmg}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
