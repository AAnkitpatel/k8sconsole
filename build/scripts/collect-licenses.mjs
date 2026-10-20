// Writes THIRD_PARTY_NOTICES.txt for every npm package bundled into the app (from build metadata).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bundledPackages } from './bundled-packages.mjs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkgs = new Map(bundledPackages(root).map((p) => [p.dir, p.name]));
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
