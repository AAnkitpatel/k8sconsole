// Captures clean product screenshots for the website from a disposable demo cluster.
// Usage: K8SC_TEST_KUBECONFIG=… [K8SC_TEST_HELM=…] xvfb-run -a -s "-screen 0 1440x900x24" node tests/e2e/screenshots.mjs
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mockClaude } from '../unit/mock-claude.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'website/assets/screens');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'k8sc-shots-'));
// Present the disposable cluster as "demo" in screenshots.
const kc = readFileSync(process.env.K8SC_TEST_KUBECONFIG, 'utf8').replaceAll('k3s-disposable', 'demo');
writeFileSync(join(tmp, 'kubeconfig.yaml'), kc, { mode: 0o600 });

const claude = await mockClaude([
  { blocks: [{ type: 'text', text: 'Let me check the pods and recent events in k8sc-demo. ' }, { type: 'tool_use', id: 's1', name: 'list_resources', input: { kind: 'pods', namespace: 'k8sc-demo' } }, { type: 'tool_use', id: 's2', name: 'get_events', input: { namespace: 'k8sc-demo' } }], stop: 'tool_use' },
  { blocks: [{ type: 'tool_use', id: 's3', name: 'get_pod_logs', input: { namespace: 'k8sc-demo', pod: 'crasher', previous: true } }], stop: 'tool_use' },
  {
    blocks: [
      {
        type: 'text',
        text: '**crasher** is in CrashLoopBackOff: its command prints `about-to-crash` and exits with code 3, so the kubelet keeps restarting it.\n\n- The two **web** pods are healthy (Ready 1/1, no restarts).\n- No other warnings in the namespace.\n\nIf the pod is a leftover test, remove it; otherwise fix its command. I also prepared a memory limit for **web**, which currently has none.',
      },
      { type: 'tool_use', id: 's4', name: 'propose_change', input: { summary: 'Add CPU/memory requests and a memory limit to deployment web', yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: k8sc-demo\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          resources:\n            requests: {cpu: 50m, memory: 32Mi}\n            limits: {memory: 128Mi}\n' } },
    ],
    stop: 'tool_use',
  },
  { blocks: [{ type: 'text', text: 'Review the change, run a dry run, then apply when you are happy with it.' }], stop: 'end_turn' },
]);

const env = { ...process.env, HOME: join(tmp, 'home'), K8SC_USER_DATA_DIR: join(tmp, 'ud'), K8SC_ALLOW_MULTIPLE: '1', KUBECONFIG: join(tmp, 'kubeconfig.yaml'), ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_API_KEY: 'sk-ant-demo-0000000000000000' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WAYLAND_DISPLAY;
if (process.env.K8SC_TEST_HELM) env.PATH = `${dirname(process.env.K8SC_TEST_HELM)}:${env.PATH}`;
mkdirSync(env.HOME, { recursive: true });
writeFileSync(join(env.HOME, '.zshrc'), "PROMPT='%F{cyan}demo%f %F{8}~%f $ '\n");

const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root, '--no-sandbox'], env, timeout: 60000 });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 });
const shot = async (name) => {
  await win.waitForTimeout(700);
  await win.screenshot({ path: join(out, `${name}.png`) });
  console.log('captured', name);
};
try {
  await win.getByTestId('connect-button').first().click();
  await win.locator('.conn-connected').waitFor({ timeout: 30000 });
  await win.getByTestId('namespace-select').selectOption('k8sc-demo');
  await win.getByText('Cluster Overview').waitFor();
  await win.waitForTimeout(2500);
  await shot('overview');

  await win.getByTestId('nav-map').click();
  await win.getByTestId('graph-node').nth(5).waitFor({ timeout: 20000 });
  await shot('cluster-map');

  await win.getByTestId('nav-monitor').click();
  await win.locator('.chart path[stroke]').first().waitFor({ timeout: 40000 });
  await win.waitForTimeout(12000);
  await shot('monitor');

  await win.getByTestId('nav-timeline').click();
  await win.locator('.tl-object').first().waitFor({ timeout: 20000 });
  await shot('timeline');

  await win.getByTestId('nav-security').click();
  await win.getByTestId('finding').first().waitFor({ timeout: 30000 });
  await win.getByTestId('finding').filter({ hasText: 'fix available' }).first().locator('.finding-head').click();
  await shot('security');

  await win.getByTestId('nav-pods').click();
  await win.getByTestId('resource-row').filter({ hasText: 'web-' }).first().click();
  await win.getByRole('tab', { name: 'Logs' }).click();
  await win.getByTestId('log-output').filter({ hasText: 'tick' }).waitFor({ timeout: 20000 });
  await shot('logs');

  await win.getByTestId('toggle-terminal').click();
  await win.locator('.term-suggest .chip-btn').first().waitFor({ timeout: 20000 });
  await win.getByTestId('dock-terminal').first().click();
  await win.keyboard.type('kubectl get deploy,svc\n', { delay: 25 });
  await win.waitForTimeout(1500);
  await win.keyboard.type('kubectl rollout st', { delay: 40 });
  await shot('terminal');
  await win.keyboard.press('Control+U');
  await win.getByTestId('toggle-terminal').click();

  await win.getByTestId('toggle-assistant').click();
  await win.getByRole('button', { name: 'Why are pods failing in this namespace?' }).click();
  await win.getByTestId('assistant-log').filter({ hasText: 'run a dry run' }).waitFor({ timeout: 30000 });
  await shot('assistant');
} finally {
  await app.close().catch(() => undefined);
  await claude.close();
  rmSync(tmp, { recursive: true, force: true });
}
