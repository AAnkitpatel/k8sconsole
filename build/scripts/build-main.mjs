// Bundles the Electron main process and preload script with esbuild.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'build/out');
const common = { metafile: true, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'node-pty'], sourcemap: false, logLevel: 'info', legalComments: 'linked' };

const m = await build({ ...common, entryPoints: [resolve(root, 'build/app/src/main/main.ts')], outfile: resolve(out, 'main/main.js') });
const p = await build({ ...common, entryPoints: [resolve(root, 'build/app/src/preload/preload.ts')], outfile: resolve(out, 'preload/preload.js') });
mkdirSync(resolve(out, 'meta'), { recursive: true });
writeFileSync(resolve(out, 'meta/main-inputs.json'), JSON.stringify([...Object.keys(m.metafile.inputs), ...Object.keys(p.metafile.inputs)].map((i) => resolve(root, i))));
mkdirSync(resolve(out, 'renderer'), { recursive: true });
