import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Records bundled module paths so third-party license notices can be generated. */
function recordModules(): Plugin {
  return {
    name: 'record-modules',
    generateBundle() {
      const dir = resolve(__dirname, '../out/meta');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'renderer-inputs.json'), JSON.stringify([...this.getModuleIds()]));
    },
  };
}

export default defineConfig({
  root: resolve(__dirname),
  base: './',
  plugins: [react(), recordModules()],
  build: {
    outDir: resolve(__dirname, '../out/renderer'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    target: 'chrome130',
  },
});
