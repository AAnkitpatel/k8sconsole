// Writes THIRD_PARTY_NOTICES.txt for every npm package bundled into the app (from build metadata).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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
let out = 'K8sConsole bundles the following third-party software.\n\n';
const summary = [];
for (const [dir, name] of [...pkgs.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pj.license === 'string' ? pj.license : pj.license?.type ?? 'UNKNOWN';
  const lf = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  summary.push(`${name}@${pj.version} (${license})`);
  out += `${'='.repeat(78)}\n${name}@${pj.version}  —  ${license}\n${pj.homepage ?? ''}\n${'-'.repeat(78)}\n${lf ? readFileSync(join(dir, lf), 'utf8').trim() : '(no license file shipped; see package metadata)'}\n\n`;
}
writeFileSync(join(root, 'build/out/THIRD_PARTY_NOTICES.txt'), out);
console.log(`Collected ${summary.length} packages:\n  ${summary.join('\n  ')}`);
