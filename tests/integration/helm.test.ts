/**
 * Helm integration test against the DISPOSABLE cluster. Requires K8SC_TEST_KUBECONFIG and K8SC_TEST_HELM (path to helm 3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppController } from '../../build/app/src/main/controller';

const KUBECONFIG = process.env.K8SC_TEST_KUBECONFIG;
const HELM = process.env.K8SC_TEST_HELM;
const NS = 'k8sc-demo';
const chart = resolve(__dirname, '../fixtures/chart');
const d = KUBECONFIG && HELM ? describe : describe.skip;

d('Helm releases through the AppController', () => {
  let dir: string;
  let ctrl: AppController;
  const helm = (...args: string[]) => execFileSync(HELM!, [...args, '--kubeconfig', KUBECONFIG!], { encoding: 'utf8' });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'k8sc-helm-int-'));
    try {
      helm('uninstall', 'k8sc-rel', '-n', NS);
    } catch {
      // not installed
    }
    helm('install', 'k8sc-rel', chart, '-n', NS, '--set', 'message=first');
    helm('upgrade', 'k8sc-rel', chart, '-n', NS, '--set', 'message=second');
    ctrl = new AppController({
      userDataDir: join(dir, 'ud'),
      home: join(dir, 'home'),
      envKubeconfig: KUBECONFIG,
      autosuggestPlugin: resolve(__dirname, '../../build/app/resources/shell/zsh-autosuggestions.zsh'),
      emit: () => undefined,
      appInfo: () => ({ version: 't', electron: '-', chrome: '-', node: '-', platform: '-' }),
      dialogs: { pickFile: async () => null, pickFolder: async () => null, saveFile: async () => null, openExternal: async () => undefined },
    });
    ctrl.handlers['settings:update']({ helmPath: HELM! });
    const { contexts } = await ctrl.handlers['kubeconfig:list']();
    expect((await ctrl.handlers['cluster:connect'](contexts[0].id)).state).toBe('connected');
  });

  afterAll(() => {
    ctrl?.shutdown();
    try {
      helm('uninstall', 'k8sc-rel', '-n', NS);
    } catch {
      // already removed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects helm', async () => {
    const a = await ctrl.handlers['helm:available']();
    expect(a.available).toBe(true);
    expect(a.version).toMatch(/^v3\./);
  });

  it('lists releases, history, values and manifest', async () => {
    const rels = await ctrl.handlers['helm:list'](NS);
    const rel = rels.find((r) => r.name === 'k8sc-rel')!;
    expect(rel).toMatchObject({ namespace: NS, revision: '2', status: 'deployed' });
    const hist = await ctrl.handlers['helm:history'](NS, 'k8sc-rel');
    expect(hist.map((h) => h.revision)).toEqual([1, 2]);
    expect(await ctrl.handlers['helm:values'](NS, 'k8sc-rel', false)).toContain('message: second');
    expect(await ctrl.handlers['helm:manifest'](NS, 'k8sc-rel')).toContain('k8sc-rel-config');
    expect((await ctrl.handlers['helm:list'](undefined)).some((r) => r.name === 'k8sc-rel')).toBe(true);
  });

  it('rolls back and uninstalls', async () => {
    await ctrl.handlers['helm:rollback'](NS, 'k8sc-rel', 1);
    const cm = await ctrl.handlers['resource:get']({ apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true }, NS, 'k8sc-rel-config');
    expect(cm.data.message).toBe('first');
    expect((await ctrl.handlers['helm:history'](NS, 'k8sc-rel')).length).toBe(3);
    await ctrl.handlers['helm:uninstall'](NS, 'k8sc-rel');
    expect((await ctrl.handlers['helm:list'](NS)).some((r) => r.name === 'k8sc-rel')).toBe(false);
  });
});
