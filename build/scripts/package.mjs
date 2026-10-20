// Builds installers for the current OS with electron-builder (macOS: .dmg + .zip, Windows: NSIS installer + .zip).
// Linux .deb packages are built by build/scripts/package-deb.sh.
// Usage: node build/scripts/package.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'package.json'));
const platform = process.platform;
if (platform !== 'darwin' && platform !== 'win32') throw new Error('package.mjs builds macOS and Windows installers; use package-deb.sh on Linux');

execFileSync(process.execPath, [join(root, 'build/scripts/stage-app.mjs'), platform], { cwd: root, stdio: 'inherit' });
copyFileSync(join(root, 'LICENSE'), join(root, 'build/stage/LICENSE.txt'));

const { build, Platform } = require('electron-builder');

// macOS: with a Developer ID certificate (CSC_LINK) and notarization credentials (App Store Connect API key or Apple ID),
// the app is signed, notarized and stapled, so Gatekeeper opens it without a warning. Without them it is ad-hoc signed.
const hasCert = !!(process.env.CSC_LINK || process.env.CSC_NAME);
const hasNotaryKey = !!((process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID));
const macSigned = platform === 'darwin' && hasCert;
if (platform === 'darwin') console.log(`macOS signing: ${macSigned ? `Developer ID${hasNotaryKey ? ' + notarization' : ' (no notarization credentials)'}` : 'ad-hoc (no Developer ID certificate configured)'}`);
const pkg = require('./package.json');
const electronVersion = require('electron/package.json').version;

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'io.github.aankitpatel.k8sconsole',
  productName: pkg.productName,
  copyright: 'Copyright © 2026 Ankit Patel and K8sConsole contributors',
  electronVersion,
  directories: { app: 'build/stage/app', output: 'dist', buildResources: 'build/assets' },
  npmRebuild: false,
  asar: true,
  extraResources: [
    { from: 'build/stage/node-pty', to: 'node-pty' },
    { from: 'build/app/resources/shell', to: 'shell' },
    { from: 'build/out/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
  ],
  // Same hardening as the Linux package; electron-builder embeds the archive integrity hash these fuses require.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  artifactName: 'K8sConsole-${version}-${os}-${arch}.${ext}',
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/assets/icon-512.png',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // Hardened runtime is required for notarization and is used for ad-hoc builds too, so both paths are tested.
    hardenedRuntime: true,
    entitlements: macSigned ? 'build/assets/entitlements.mac.plist' : 'build/assets/entitlements.mac.adhoc.plist',
    entitlementsInherit: macSigned ? 'build/assets/entitlements.mac.plist' : 'build/assets/entitlements.mac.adhoc.plist',
    // Ad-hoc signature when no certificate is configured: Apple Silicon refuses to run unsigned code.
    ...(macSigned ? {} : { identity: '-' }),
    gatekeeperAssess: false,
    notarize: macSigned && hasNotaryKey,
  },
  dmg: { writeUpdateInfo: false },
  win: {
    icon: 'build/assets/icon-512.png',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    signAndEditExecutable: true,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'K8sConsole',
    license: 'build/stage/LICENSE.txt',
    differentialPackage: false,
  },
  publish: null,
};

const targets = platform === 'darwin' ? Platform.MAC.createTarget() : Platform.WINDOWS.createTarget();
const artifacts = await build({ targets, config, publish: 'never' });

// SHA-256 next to each installer, in `sha256sum` format.
const sums = [];
for (const file of artifacts.filter((f) => /\.(dmg|zip|exe)$/.test(f))) {
  const hash = createHash('sha256');
  await new Promise((res, rej) => createReadStream(file).on('data', (d) => hash.update(d)).on('end', res).on('error', rej));
  const name = file.split(/[\\/]/).pop();
  sums.push(`${hash.digest('hex')}  ${name}`);
  writeFileSync(`${file}.sha256`, `${sums.at(-1)}\n`);
}
console.log(sums.join('\n'));
console.log('dist:', readdirSync(join(root, 'dist')).join(', '));
