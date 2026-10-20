// node-pty's prebuilt macOS spawn-helper is installed without its execute bit, which makes every terminal fail
// with "posix_spawnp failed". Runs after `npm install` / `npm ci` (and again when staging an installer).
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function fixSpawnHelpers(ptyDir) {
  const prebuilds = join(ptyDir, 'prebuilds');
  if (!existsSync(prebuilds)) return 0;
  let fixed = 0;
  for (const d of readdirSync(prebuilds).filter((x) => x.startsWith('darwin-'))) {
    const helper = join(prebuilds, d, 'spawn-helper');
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
      fixed++;
    }
  }
  return fixed;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fix-node-pty.mjs')) {
  fixSpawnHelpers(join(process.cwd(), 'node_modules', 'node-pty'));
}
