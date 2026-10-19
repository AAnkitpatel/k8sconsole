/**
 * Connection-recovery test: restarts the DISPOSABLE k3s container while a watch is open.
 * Opt-in: K8SC_TEST_KUBECONFIG and K8SC_TEST_RESTART_CONTAINER=<docker container name>.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppController } from '../../build/app/src/main/controller';
import type { WatchEvent } from '../../build/app/src/shared/types';

const KUBECONFIG = process.env.K8SC_TEST_KUBECONFIG;
const CONTAINER = process.env.K8SC_TEST_RESTART_CONTAINER;
const d = KUBECONFIG && CONTAINER ? describe : describe.skip;

d('connection recovery', () => {
  it('watch reports reconnecting while the API server is down and resumes afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k8sc-rec-'));
    const watchEvents: WatchEvent[] = [];
    const ctrl = new AppController({
      userDataDir: join(dir, 'ud'),
      home: join(dir, 'home'),
      envKubeconfig: KUBECONFIG,
      autosuggestPlugin: resolve(__dirname, '../../build/app/resources/shell/zsh-autosuggestions.zsh'),
      emit: (e, p) => e === 'watch:event' && watchEvents.push(p as WatchEvent),
      appInfo: () => ({ version: 't', electron: '-', chrome: '-', node: '-', platform: '-' }),
      dialogs: { pickFile: async () => null, pickFolder: async () => null, saveFile: async () => null, openExternal: async () => undefined },
    });
    try {
      const { contexts } = await ctrl.handlers['kubeconfig:list']();
      await ctrl.handlers['cluster:connect'](contexts[0].id);
      const { subscriptionId } = await ctrl.handlers['resource:watch']({ resource: { apiVersion: 'v1', kind: 'Namespace', plural: 'namespaces', namespaced: false } });
      const until = async (pred: () => boolean, ms: number) => {
        const t = Date.now();
        while (!pred()) {
          if (Date.now() - t > ms) throw new Error('timeout');
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      await until(() => watchEvents.some((e) => e.subscriptionId === subscriptionId && e.type === 'SNAPSHOT'), 20000);
      const before = watchEvents.length;
      execFileSync('docker', ['restart', CONTAINER!], { stdio: 'ignore' });
      await until(() => watchEvents.slice(before).some((e) => e.status === 'reconnecting'), 60000);
      await until(() => watchEvents.slice(before).some((e) => e.type === 'SNAPSHOT'), 180000);
      const after = watchEvents.slice(before);
      expect(after.find((e) => e.type === 'SNAPSHOT')!.items!.some((n) => n.metadata.name === 'k8sc-demo')).toBe(true);
      expect(after.some((e) => e.status === 'live')).toBe(true);
    } finally {
      ctrl.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
});
