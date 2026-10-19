// Hardens the packaged Electron binary by flipping security fuses.
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const binary = process.argv[2];
if (!binary) throw new Error('usage: flip-fuses.mjs <electron-binary>');
await flipFuses(binary, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false, // ELECTRON_RUN_AS_NODE cannot turn the app into a generic Node runtime
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS ignored
  [FuseV1Options.EnableNodeCliInspectArguments]: false, // --inspect* ignored
  [FuseV1Options.OnlyLoadAppFromAsar]: true, // never load a loose resources/app directory
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, // enforced on platforms that support it
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});
const wire = await getCurrentFuseWire(binary);
console.log('Fuses:', Object.entries(FuseV1Options).filter(([k]) => isNaN(Number(k))).map(([k, v]) => `${k}=${wire[v]}`).join(' '));
