// End-to-end smoke test: launches the built Electron app (or an installed binary) and drives the UI.
// Usage: K8SC_TEST_KUBECONFIG=/path/kubeconfig xvfb-run -a node tests/e2e/smoke.mjs [--exe /opt/k8sconsole/k8sconsole]
import { _electron as electron, chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mockClaude } from '../unit/mock-claude.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'reports/screenshots');
try {
  mkdirSync(shots, { recursive: true });
} catch {
  // read-only checkout (package validation): screenshots are skipped
}
const exeIdx = process.argv.indexOf('--exe');
const exe = exeIdx > 0 ? process.argv[exeIdx + 1] : createRequire(import.meta.url)('electron');
const kubeconfig = process.env.K8SC_TEST_KUBECONFIG;
const tmp = mkdtempSync(join(tmpdir(), 'k8sc-e2e-'));
const results = [];
/** Screenshots are evidence only: a read-only checkout must not fail a step. */
const snap = (page, opts) => page.screenshot(opts).catch(() => undefined);
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log(`  ✗ ${name}\n    ${String(err?.stack ?? err).split('\n').slice(0, 4).join('\n    ')}`);
    throw err;
  }
};

// The assistant talks to a local mock of the Messages API (the SDK honours ANTHROPIC_BASE_URL).
const claude = kubeconfig
  ? await mockClaude([
      { blocks: [{ type: 'text', text: 'Let me look at the pods. ' }, { type: 'tool_use', id: 'e1', name: 'list_resources', input: { kind: 'pods', namespace: 'k8sc-demo' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: '**crasher** exits with code 3 right after start.' }, { type: 'tool_use', id: 'e2', name: 'propose_change', input: { summary: 'Label the config for review', yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n  namespace: k8sc-demo\n  labels: {e2e: reviewed}\n' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: 'I prepared a change for your review.' }], stop: 'end_turn' },
    ])
  : null;
const env = { ...process.env, HOME: join(tmp, 'home'), K8SC_USER_DATA_DIR: join(tmp, 'userData'), K8SC_ALLOW_MULTIPLE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WAYLAND_DISPLAY;
if (kubeconfig) env.KUBECONFIG = kubeconfig;
else delete env.KUBECONFIG;
if (claude) {
  env.ANTHROPIC_BASE_URL = claude.url;
  env.ANTHROPIC_API_KEY = 'sk-ant-e2e-0000000000000000';
}
if (process.env.K8SC_TEST_HELM) env.PATH = `${dirname(process.env.K8SC_TEST_HELM)}:${env.PATH}`;

/**
 * Dev builds are launched through Playwright's Electron driver. Packaged builds have the Node inspector fuse
 * disabled, so they are started directly and attached over the Chromium DevTools protocol instead.
 */
async function launch() {
  if (exeIdx < 0) {
    const app = await electron.launch({ executablePath: exe, args: [root, '--no-sandbox'], env, timeout: 60000 });
    return { win: await app.firstWindow(), close: () => app.close() };
  }
  const child = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`no DevTools endpoint; stderr: ${buf.slice(-2000)}`)), 60000);
    child.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`app exited with ${code}; stderr: ${buf.slice(-2000)}`)));
  });
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0];
  const win = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  if (!win.url().endsWith('/index.html')) await win.waitForURL(/\/index\.html$/, { timeout: 30000 });
  return {
    win,
    close: async () => {
      await browser.close().catch(() => undefined);
      child.kill('SIGTERM');
    },
  };
}

const app = await launch();
let failed = false;
try {
  const win = app.win;
  win.on('pageerror', (e) => console.log('  [renderer error]', e.message, (e.stack ?? '').split('\n').slice(0, 12).join(' | ')));
  win.on('console', (m) => m.type() === 'error' && console.log('  [renderer console]', m.text()));
  await win.waitForLoadState('domcontentloaded');

  await step('window opens with the app title', async () => {
    assert.equal(await win.title(), 'K8sConsole');
    await win.getByText('K8sConsole').first().waitFor();
  });

  await step('renderer is isolated (no Node, no raw ipcRenderer, narrow bridge only)', async () => {
    const probe = await win.evaluate(() => ({
      require: typeof globalThis.require,
      process: typeof globalThis.process,
      ipcRenderer: typeof globalThis.ipcRenderer,
      bridge: Object.keys(globalThis.k8sc ?? {}).sort(),
    }));
    assert.deepEqual(probe, { require: 'undefined', process: 'undefined', ipcRenderer: 'undefined', bridge: ['invoke', 'on'] });
    const rejected = await win.evaluate(() => globalThis.k8sc.invoke('shell:exec', 'rm -rf /'));
    assert.equal(rejected.ok, false);
    const csp = await win.evaluate(async () => {
      try {
        await fetch('https://example.com');
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });
    assert.equal(csp, 'blocked');
  });

  if (!kubeconfig) {
    await step('shows the empty-state when no kubeconfig exists', async () => {
      await win.getByText('No kubeconfig found').waitFor({ timeout: 15000 });
      await snap(win, { path: join(shots, 'installed-empty-state.png') });
    });
  } else {
    await step('lists contexts and connects to the disposable cluster', async () => {
      await win.getByTestId('connect-button').first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '01-clusters.png') });
      await win.getByTestId('connect-button').first().click();
      await win.getByText('Cluster Overview').waitFor({ timeout: 30000 });
      await win.locator('.conn-connected').waitFor({ timeout: 30000 });
      await win.waitForTimeout(1500);
      await snap(win, { path: join(shots, '02-overview.png') });
    });

    await step('namespace selection and pod list with live status', async () => {
      await win.getByTestId('namespace-select').selectOption('k8sc-demo');
      await win.getByTestId('nav-pods').click();
      await win.getByTestId('resource-row').first().waitFor({ timeout: 20000 });
      await win.locator('.live-live').waitFor({ timeout: 20000 });
      const rows = await win.getByTestId('resource-row').count();
      assert.ok(rows >= 3, `expected >=3 pods, got ${rows}`);
      await snap(win, { path: join(shots, '03-pods.png') });
    });

    await step('pod details, logs streaming and YAML editor', async () => {
      await win.getByTestId('resource-row').filter({ hasText: 'web-' }).filter({ hasText: 'Running' }).first().click();
      await win.getByRole('tab', { name: 'Logs' }).click();
      await win.getByTestId('log-output').filter({ hasText: 'tick' }).waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '04-logs.png') });
      await win.getByRole('tab', { name: 'YAML' }).click();
      await win.getByTestId('yaml-editor').locator('.cm-content').filter({ hasText: 'kind: Pod' }).waitFor({ timeout: 15000 });
      await snap(win, { path: join(shots, '05-yaml.png') });
    });

    await step('interactive shell in the pod', async () => {
      await win.getByRole('tab', { name: 'Shell' }).click();
      await win.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
      // Wait for the container shell's prompt before typing, as a user would.
      await win.getByTestId('terminal').filter({ hasText: /[#$] *$/m }).waitFor({ timeout: 20000 });
      await win.getByTestId('terminal').click();
      await win.keyboard.type('echo E2E_$((6*7))\n', { delay: 15 });
      await win.getByTestId('terminal').filter({ hasText: 'E2E_42' }).waitFor({ timeout: 15000 });
      await snap(win, { path: join(shots, '06-shell.png') });
    });

    await step('deployment details show related pods; scale dialog validates input', async () => {
      await win.getByTestId('nav-deployments').click();
      await win.getByTestId('resource-row').filter({ hasText: 'web' }).first().click();
      await win.getByText(/^Pods \(\d+\)$/).waitFor({ timeout: 15000 });
      await win.getByRole('button', { name: 'Scale' }).click();
      const input = win.locator('.modal input');
      await input.fill('-3');
      await win.getByText('Replicas must be a non-negative whole number.').waitFor();
      await snap(win, { path: join(shots, '07-scale-dialog.png') });
      await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
    });

    await step('monitor view: ktop-style tiles, charts and node/pod usage tables', async () => {
      await win.getByTestId('nav-monitor').click();
      await win.getByRole('heading', { name: 'Monitor' }).waitFor({ timeout: 20000 });
      await win.locator('.mon-table tbody tr').first().waitFor({ timeout: 30000 });
      await win.getByText('kubelet summary API').waitFor({ timeout: 30000 });
      // Wait for a second sample so the line charts have a series to draw.
      await win.locator('.chart path[stroke]').first().waitFor({ timeout: 40000 });
      const bars = await win.locator('.usagebar-fill').count();
      assert.ok(bars > 0, 'expected usage bars');
      await snap(win, { path: join(shots, '09-monitor.png'), fullPage: true });
    });

    await step('integrated terminal: cluster-bound zsh with kubectl and suggestions', async () => {
      await win.getByTestId('toggle-terminal').click();
      const term = win.getByTestId('dock-terminal').first();
      await term.waitFor({ timeout: 15000 });
      await win.locator('.term-status').filter({ hasText: 'k3s-disposable' }).waitFor({ timeout: 20000 });
      await win.locator('.term-suggest .chip-btn').first().waitFor({ timeout: 20000 });
      await term.click();
      await win.keyboard.type('kubectl get ns k8sc-demo -o name; echo TERM_$((40+2))\n', { delay: 10 });
      await term.filter({ hasText: 'TERM_42' }).waitFor({ timeout: 30000 });
      await term.filter({ hasText: 'namespace/k8sc-demo' }).waitFor({ timeout: 30000 });
      await win.keyboard.type('kubectl ge', { delay: 30 });
      await win.waitForTimeout(800);
      await snap(win, { path: join(shots, '10-terminal.png') });
      await win.keyboard.press('Control+U');
    });

    await step('relations tab shows the object graph', async () => {
      await win.getByTestId('nav-pods').click();
      await win.getByTestId('resource-row').filter({ hasText: 'web-' }).first().click();
      await win.getByRole('tab', { name: 'Relations' }).click();
      await win.getByTestId('graph-node').nth(3).waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '11-relations.png') });
    });

    await step('cluster map: namespace graph and node map', async () => {
      await win.getByTestId('nav-map').click();
      await win.getByTestId('graph-node').nth(5).waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '12-cluster-map.png') });
      await win.getByTestId('map-mode-nodes').click();
      await win.getByTestId('nodemap-node').first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '13-node-map.png') });
    });

    await step('event timeline lanes', async () => {
      await win.getByTestId('nav-timeline').click();
      await win.locator('.tl-object').filter({ hasText: 'crasher' }).first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '14-timeline.png') });
    });

    await step('security scan with expandable findings', async () => {
      await win.getByTestId('nav-security').click();
      await win.getByTestId('security-score').waitFor({ timeout: 30000 });
      await win.getByTestId('finding').first().waitFor({ timeout: 30000 });
      await win.getByTestId('finding').filter({ hasText: 'fix available' }).first().locator('.finding-head').click();
      await win.getByRole('button', { name: 'Dry run' }).first().waitFor();
      await snap(win, { path: join(shots, '15-security.png') });
    });

    await step('access: who-can and role editor preview', async () => {
      await win.getByTestId('nav-access').click();
      await win.locator('.access-body table tbody tr').first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '16-access.png') });
      await win.getByRole('tab', { name: 'Role editor' }).click();
      await win.getByLabel('Role name').fill('e2e-readers');
      await win.locator('.role-preview').filter({ hasText: 'kind: Role' }).waitFor();
    });

    if (process.env.K8SC_TEST_HELM) {
      await step('helm charts and repositories', async () => {
        await win.getByRole('button', { name: 'Helm Releases' }).click();
        await win.getByTestId('helm-charts-tab').click();
        await win.getByRole('heading', { name: 'Repositories' }).waitFor({ timeout: 20000 });
        await snap(win, { path: join(shots, '17-helm-charts.png') });
      });
    }

    await step('AI assistant: tool activity, answer and reviewable proposal', async () => {
      await win.getByTestId('toggle-assistant').click();
      await win.getByRole('button', { name: 'Why are pods failing in this namespace?' }).click();
      await win.getByTestId('assistant-log').filter({ hasText: 'I prepared a change for your review.' }).waitFor({ timeout: 30000 });
      await win.locator('.msg-tools .tag').filter({ hasText: 'Listed resources' }).waitFor();
      await win.getByRole('button', { name: 'Review & apply…' }).click();
      await win.getByRole('dialog', { name: 'Review proposed change' }).waitFor();
      await snap(win, { path: join(shots, '18-assistant.png') });
      await win.getByRole('dialog', { name: 'Review proposed change' }).locator('.modal-footer').getByRole('button', { name: 'Close' }).click();
      await win.getByTestId('toggle-assistant').click();
    });

    await step('hotbar: pin the cluster and switch with one click', async () => {
      await win.getByTestId('nav-clusters').click();
      await win.getByTestId('pin-button').first().click();
      await win.getByTestId('hotbar-item').first().waitFor();
      assert.equal(await win.getByTestId('hotbar-item').count(), 1);
      assert.match(await win.getByTestId('hotbar-item').first().getAttribute('class'), /active/);
      await win.getByTestId('nav-overview').click();
      await win.getByText('Cluster Overview').waitFor();
    });

    await step('platform: cost, GitOps and image vulnerabilities', async () => {
      // Screenshots without the terminal (it shows this machine's prompt).
      if (await win.getByRole('button', { name: 'Hide terminal' }).isVisible()) await win.getByRole('button', { name: 'Hide terminal' }).click();
      await win.getByTestId('nav-cost').click();
      await win.getByTestId('cost-view').waitFor();
      await win.getByTestId('cost-total').waitFor({ timeout: 20000 });
      assert.match(await win.getByTestId('cost-total').textContent(), /^\$/);
      await snap(win, { path: join(shots, '12-cost.png') });
      await win.getByTestId('nav-gitops').click();
      await win.getByTestId('gitops-view').waitFor();
      await win.locator('[data-testid="gitops-empty"], [data-testid="gitops-row"]').first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '15-gitops.png') });
      await win.getByTestId('nav-images').click();
      await win.getByTestId('image-row').first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '13-images.png') });
    });

    await step('extensions: install, policy results, and a command typed into the terminal', async () => {
      await win.getByTestId('nav-extensions').click();
      await win.getByTestId('ext-add-json').click();
      await win.getByTestId('ext-install').click();
      await win.getByTestId('ext-card').first().waitFor();
      await win.getByTestId('ext-finding').filter({ hasText: 'no "team" label' }).first().waitFor({ timeout: 20000 });
      await snap(win, { path: join(shots, '14-extensions.png') });
      await win.getByTestId('nav-deployments').click();
      await win.getByTestId('resource-row').filter({ hasText: 'web' }).first().click();
      await win.getByTestId('extension-command').filter({ hasText: 'Rollout history' }).click();
      const term = win.getByTestId('dock-terminal').last();
      await term.getByText('kubectl rollout history deployment/web -n k8sc-demo').first().waitFor({ timeout: 20000 });
      await win.getByRole('button', { name: 'Hide terminal' }).click();
    });

    await step('settings: MCP server on and off', async () => {
      await win.getByTestId('nav-settings').click();
      await win.getByTestId('mcp-enabled').check();
      await win.getByTestId('mcp-state').filter({ hasText: 'Running' }).waitFor({ timeout: 10000 });
      assert.match(await win.getByTestId('mcp-command').textContent(), /claude mcp add --transport http k8sconsole http:\/\/127\.0\.0\.1:\d+\/mcp/);
      await win.getByTestId('mcp-enabled').uncheck();
      await win.getByTestId('mcp-state').waitFor({ state: 'detached', timeout: 10000 });
    });

    await step('settings view and theme switch', async () => {
      await win.getByTestId('nav-settings').click();
      await win.getByLabel('Theme').selectOption('light');
      await win.waitForFunction(() => document.documentElement.classList.contains('light'));
      await snap(win, { path: join(shots, '08-settings-light.png') });
      await win.getByLabel('Theme').selectOption('dark');
    });
  }
} catch (err) {
  failed = true;
  await app.win?.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined);
  console.log('  page url at failure:', app.win?.url());
  if (!results.some((r) => !r.ok)) console.log('  ✗ setup failed:', err?.message ?? err);
} finally {
  await app.close().catch(() => undefined);
  await claude?.close();
  try {
    // The app can still be flushing files while it exits; retry, and never fail the run over cleanup.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.log('  (temp cleanup skipped:', err.code ?? err.message, ')');
  }
}
const passed = results.filter((r) => r.ok).length;
console.log(`\nE2E: ${passed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
