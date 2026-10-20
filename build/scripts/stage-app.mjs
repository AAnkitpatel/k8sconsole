// Stages what goes into an installer, for one target platform:
//   build/stage/app       → app.asar (compiled main/preload/renderer + a minimal package.json; no node_modules)
//   build/stage/node-pty  → resources/node-pty (native terminal module, outside the archive so its helpers are real files)
// Usage: node build/scripts/stage-app.mjs [linux|darwin|win32]   (default: this platform)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const platform = process.argv[2] ?? process.platform;
if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`unsupported platform ${platform}`);
const stage = join(root, 'build', 'stage');
const app = join(stage, 'app');
const pty = join(stage, 'node-pty');

execSync('npm run build --silent', { cwd: root, stdio: 'inherit' });
execSync('node build/scripts/collect-licenses.mjs', { cwd: root, stdio: 'ignore' });

rmSync(app, { recursive: true, force: true });
rmSync(pty, { recursive: true, force: true });
mkdirSync(join(app, 'out'), { recursive: true });
for (const d of ['main', 'preload', 'renderer']) cpSync(join(root, 'build', 'out', d), join(app, 'out', d), { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const appPkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, license: pkg.license, author: pkg.author, homepage: pkg.homepage, main: 'out/main/main.js' };
writeFileSync(join(app, 'package.json'), JSON.stringify(appPkg, null, 2));

// node-pty: runtime JavaScript (no tests or source maps) plus the native binaries for the target platform only.
const src = join(root, 'node_modules', 'node-pty');
const keep = (p) => {
  const rel = relative(src, p).replaceAll('\\', '/');
  if (rel === '') return true;
  if (['package.json', 'LICENSE'].includes(rel)) return true;
  if (rel === 'lib' || rel.startsWith('lib/')) return !/\.test\.js$|\.map$/.test(rel);
  if (platform === 'linux') return rel === 'build' || rel === 'build/Release' || rel === 'build/Release/pty.node';
  if (rel === 'prebuilds') return true;
  if (rel.startsWith('prebuilds/')) return rel.split('/')[1].startsWith(`${platform}-`) && !rel.endsWith('.pdb');
  if (platform === 'win32' && (rel === 'third_party' || rel.startsWith('third_party/conpty'))) return !rel.endsWith('.pdb');
  return false;
};
cpSync(src, pty, { recursive: true, filter: keep });
for (const required of platform === 'linux' ? ['build/Release/pty.node'] : ['prebuilds']) {
  if (!existsSync(join(pty, required))) throw new Error(`node-pty for ${platform} is missing ${required}`);
}

const count = (d) => readdirSync(d, { recursive: true }).length;
console.log(`Staged app (${count(app)} files) and node-pty for ${platform} (${count(pty)} files) in ${relative(root, stage)}`);
