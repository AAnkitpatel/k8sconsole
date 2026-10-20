// The npm packages that ship inside K8sConsole, from the build metadata (esbuild and Vite inputs),
// plus the runtime pieces shipped next to the bundle (Electron, node-pty).
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

export function bundledPackages(root) {
  const meta = join(root, 'build/out/meta');
  const inputs = [...JSON.parse(readFileSync(join(meta, 'main-inputs.json'), 'utf8')), ...JSON.parse(readFileSync(join(meta, 'renderer-inputs.json'), 'utf8'))];
  const pkgs = new Map();
  for (const raw of inputs) {
    const p = raw.replace(/^\0/, '').split('?')[0];
    const idx = p.lastIndexOf(`node_modules${sep}`);
    if (idx < 0) continue;
    const rest = p.slice(idx + 13).split(sep);
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    const dir = p.slice(0, idx + 13) + name;
    if (!pkgs.has(dir) && existsSync(join(dir, 'package.json'))) pkgs.set(dir, name);
  }
  return [...pkgs.entries()].map(([dir, name]) => ({ dir, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Runtime components that are not part of the JavaScript bundle. */
export function shippedRuntime(root) {
  return ['electron', 'node-pty'].map((name) => ({ dir: join(root, 'node_modules', name), name }));
}
