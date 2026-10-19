import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react()],
  test: {
    root,
    // Integration suites share one disposable cluster; never run their files concurrently.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.{ts,tsx}'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], exclude: ['tests/integration/recovery.test.ts'], environment: 'node', testTimeout: 120000, hookTimeout: 120000 },
      },
      {
        // Restarts the cluster container: run on its own, after the integration project.
        extends: true,
        test: { name: 'recovery', include: ['tests/integration/recovery.test.ts'], environment: 'node', testTimeout: 300000 },
      },
    ],
  },
});
