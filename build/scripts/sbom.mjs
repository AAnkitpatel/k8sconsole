// Writes a CycloneDX 1.5 SBOM of what K8sConsole ships: every npm package bundled into the app,
// Electron and node-pty, with exact versions, licences, package URLs and the lockfile's SHA-512 hashes.
// Usage (after `npm run build`): node build/scripts/sbom.mjs dist/k8sconsole-<version>.cdx.json
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPackages, shippedRuntime } from './bundled-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2] ?? join(root, 'dist', 'sbom.cdx.json');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

const purl = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
const components = new Map();
for (const { dir, name } of [...bundledPackages(root), ...shippedRuntime(root)]) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const ref = purl(name, pj.version);
  if (components.has(ref)) continue;
  const license = typeof pj.license === 'string' ? pj.license : pj.license?.type;
  const integrity = lock.packages?.[relative(root, dir).replaceAll('\\', '/')]?.integrity;
  const sha512 = integrity?.startsWith('sha512-') ? Buffer.from(integrity.slice(7), 'base64').toString('hex') : undefined;
  components.set(ref, {
    type: name === 'electron' ? 'framework' : 'library',
    'bom-ref': ref,
    name,
    version: pj.version,
    purl: ref,
    ...(license ? { licenses: [{ expression: license }] } : {}),
    ...(sha512 ? { hashes: [{ alg: 'SHA-512', content: sha512 }] } : {}),
  });
}
components.set('zsh-autosuggestions@0.7.1', {
  type: 'library',
  'bom-ref': 'zsh-autosuggestions@0.7.1',
  name: 'zsh-autosuggestions',
  version: '0.7.1',
  licenses: [{ expression: 'MIT' }],
  externalReferences: [{ type: 'vcs', url: 'https://github.com/zsh-users/zsh-autosuggestions' }],
});

const appRef = purl(pkg.name, pkg.version);
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'k8sconsole sbom.mjs' }] },
    component: { type: 'application', 'bom-ref': appRef, name: pkg.productName, version: pkg.version, purl: appRef, licenses: [{ expression: pkg.license }] },
  },
  components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)),
  dependencies: [{ ref: appRef, dependsOn: [...components.keys()].sort() }],
};
writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
console.log(`SBOM: ${components.size} components → ${relative(root, out)}`);
