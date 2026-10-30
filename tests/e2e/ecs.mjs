// End-to-end test of the Amazon ECS workspace against a local AWS stand-in (no AWS account needed).
// Usage: xvfb-run -a node tests/e2e/ecs.mjs [--exe /opt/k8sconsole/k8sconsole]
import { _electron as electron, chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mockAws } from './mock-aws.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'reports/screenshots');
try {
  mkdirSync(shots, { recursive: true });
} catch {
  // read-only checkout (package validation): screenshots are skipped
}
const exeIdx = process.argv.indexOf('--exe');
const exe = exeIdx > 0 ? process.argv[exeIdx + 1] : createRequire(import.meta.url)('electron');
const tmp = mkdtempSync(join(tmpdir(), 'k8sc-e2e-ecs-'));
const results = [];
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

const aws = await mockAws();
const home = join(tmp, 'home');
mkdirSync(join(home, '.aws'), { recursive: true });
// A throwaway profile with fake keys; the app only ever talks to the local stand-in.
writeFileSync(join(home, '.aws', 'config'), '[profile e2e]\nregion = eu-west-2\n');
writeFileSync(join(home, '.aws', 'credentials'), '[e2e]\naws_access_key_id = AKIAE2EEXAMPLE\naws_secret_access_key = e2e-not-a-secret\n');
// Windows resolves the home folder from USERPROFILE.
const env = { ...process.env, HOME: home, USERPROFILE: home, K8SC_USER_DATA_DIR: join(tmp, 'userData'), K8SC_ALLOW_MULTIPLE: '1', AWS_ENDPOINT_URL: aws.url, AWS_EC2_METADATA_DISABLED: 'true' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY', 'KUBECONFIG', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) delete env[k];

async function launch() {
  if (exeIdx < 0) {
    const app = await electron.launch({ executablePath: exe, args: [root, '--no-sandbox'], env, timeout: 60000 });
    return { win: await app.firstWindow(), close: () => app.close() };
  }
  const child = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`no DevTools endpoint; stderr: ${buf.slice(-2000)}`)), 60000);
    child.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        res(m[1]);
      }
    });
    child.on('exit', (code) => rej(new Error(`app exited with ${code}; stderr: ${buf.slice(-2000)}`)));
  });
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0];
  const win = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  if (!win.url().endsWith('/index.html')) await win.waitForURL(/\/index\.html$/, { timeout: 30000 });
  return { win, close: async () => (await browser.close().catch(() => undefined), child.kill('SIGTERM')) };
}

const app = await launch();
let failed = false;
try {
  const win = app.win;
  win.on('pageerror', (e) => console.log('  [renderer error]', e.message));
  win.on('console', (m) => m.type() === 'error' && console.log('  [renderer console]', m.text()));
  await win.waitForLoadState('domcontentloaded');
  const shot = (name) => win.screenshot({ path: join(shots, `ecs-${name}.png`) }).catch(() => undefined);
  const details = win.locator('aside.details');
  const tab = (name) => details.getByRole('tab', { name, exact: false });

  await step('switches to the Amazon ECS workspace and lists AWS profiles', async () => {
    await win.getByTestId('ws-ecs').click();
    await win.getByTestId('ecs-connect').waitFor();
    const options = await win.getByTestId('aws-profile').locator('option').allTextContents();
    assert.ok(options.some((o) => o.startsWith('e2e (access keys, eu-west-2)')), options.join('|'));
    assert.equal(await win.getByTestId('aws-readonly').isChecked(), true, 'read-only is the default');
    // Key material never reaches the renderer.
    const profiles = await win.evaluate(() => globalThis.k8sc.invoke('aws:profiles'));
    assert.ok(!JSON.stringify(profiles).includes('AKIAE2E'));
  });

  await step('connects read-only with a profile and shows the overview', async () => {
    await win.getByTestId('aws-connect').click();
    await win.getByTestId('ecs-overview').waitFor();
    await win.getByTestId('aws-connection-state').getByText(`AWS e2e · eu-west-2 · ${aws.account}`).waitFor();
    assert.equal(await win.getByTestId('aws-mode').textContent(), 'read-only');
    await win.getByTestId('ecs-cluster-card').getByText('shop-prod').waitFor();
    await win.getByText('Needs attention', { exact: true }).waitFor();
    await win.locator('.ecs-overview').getByText('unable to consistently start tasks').waitFor();
    await shot('overview');
  });

  await step('lists services with status and blocks writes while read-only', async () => {
    await win.getByTestId('ecs-nav-services').click();
    await win.getByTestId('ecs-service-row').nth(2).waitFor();
    assert.equal(await win.getByTestId('ecs-service-row').count(), 3);
    await win.getByTestId('ecs-service-row').filter({ hasText: 'worker' }).getByText('1 of 2 running').waitFor();
    await win.getByTestId('ecs-service-row').filter({ hasText: 'web' }).click();
    await details.waitFor();
    assert.equal(await win.getByTestId('ecs-scale').isDisabled(), true);
    const r = await win.evaluate((c) => globalThis.k8sc.invoke('ecs:updateService', c, 'web', { desiredCount: 0 }), aws.cluster);
    assert.equal(r.ok, false);
    assert.match(r.error, /read-only/);
    assert.equal(aws.writes.length, 0, 'no write reached AWS');
  });

  await step('service details: targets, logs, metrics and events', async () => {
    await tab('Targets').click();
    await details.getByText('web-tg').waitFor();
    assert.equal(await details.getByText('healthy', { exact: true }).count(), 2);
    await tab('Logs').click();
    await win.getByTestId('ecs-log-output').getByText('ERROR upstream timed out').first().waitFor({ timeout: 20000 });
    await details.getByText('/ecs/web (eu-west-2) · all tasks of the service').waitFor();
    await tab('Metrics').click();
    await details.getByText('CPU utilization').waitFor();
    await details.locator('svg path').first().waitFor();
    await tab('Events').click();
    await details.getByText('has reached a steady state').waitFor();
    await shot('service');
  });

  await step('tasks view shows running and stopped tasks with the stop reason', async () => {
    await win.getByTestId('ecs-nav-tasks').click();
    await win.getByTestId('ecs-task-row').nth(3).waitFor();
    assert.equal(await win.getByTestId('ecs-task-row').count(), 4);
    await win.getByTestId('ecs-task-row').filter({ hasText: 'stopped' }).click();
    await details.getByText('Stopped: Essential container in task exited (EssentialContainerExited)').waitFor();
    await tab('Logs').click();
    await win.getByTestId('ecs-log-output').getByText('line 1').waitFor({ timeout: 20000 });
    await tab('Shell').click();
    await win.getByTestId('ecs-exec-unavailable').getByText('read-only').waitFor();
  });

  await step('task definitions: families, revisions and JSON', async () => {
    await win.getByTestId('ecs-nav-taskdefs').click();
    await win.getByTestId('ecs-family').nth(2).waitFor();
    await win.getByTestId('ecs-family').filter({ hasText: 'web' }).click();
    await win.getByTestId('yaml-editor').getByText('shop/web:1.5.0').waitFor();
    await win.getByRole('combobox', { name: 'Revision' }).selectOption({ label: 'revision 4' });
    await win.getByTestId('yaml-editor').getByText('shop/web:1.4.0').waitFor();
  });

  await step('monitor, service map, events and security scan', async () => {
    await win.getByTestId('ecs-nav-monitor').click();
    await win.getByTestId('ecs-monitor').getByText('Cluster CPU').waitFor();
    await win.getByTestId('ecs-monitor-row').nth(2).waitFor();
    await win.getByText('Cluster utilization is the average of its services').waitFor();
    await shot('monitor');
    await win.getByTestId('ecs-nav-map').click();
    const canvas = win.getByTestId('graph-canvas');
    await canvas.waitFor();
    for (const t of ['shop-alb', 'web-tg', 'worker', 'web:5']) await canvas.getByText(t, { exact: true }).first().waitFor();
    // Regression: a quick pan (press, move, release in one burst) used to blank the window.
    await win.evaluate(() => {
      const el = document.querySelector('[data-testid="graph-canvas"]');
      const fire = (type, x) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 200, button: 0 }));
      for (let i = 0; i < 5; i++) {
        fire('mousedown', 400);
        fire('mousemove', 430);
        fire('mouseup', 430);
      }
    });
    await win.waitForTimeout(500);
    assert.equal(await win.getByTestId('error-boundary').count(), 0);
    await canvas.getByText('shop-alb', { exact: true }).waitFor();
    await shot('map');
    await win.getByTestId('ecs-nav-events').click();
    await win.getByTestId('ecs-events').getByText('unable to consistently start tasks').waitFor();
    await win.getByTestId('ecs-nav-security').click();
    await win.getByTestId('ecs-security').getByText('Open to the internet on port 22').waitFor();
    await win.getByTestId('ecs-security').getByText('Secrets in plain environment variables').waitFor();
    await win.getByTestId('ecs-security').getByText('Image uses a moving tag').waitFor();
    await shot('security');
  });

  await step('ECS cost, image vulnerabilities and extension actions', async () => {
    await win.getByTestId('ecs-nav-cost').click();
    await win.getByTestId('ecs-cost-total').waitFor({ timeout: 20000 });
    assert.match(await win.getByTestId('ecs-cost-total').textContent(), /^\$\d/);
    assert.equal(await win.getByTestId('ecs-cost-row').count(), 3);
    await shot('cost');
    await win.getByTestId('ecs-nav-images').click();
    await win.getByTestId('image-row').first().waitFor({ timeout: 20000 });
    assert.ok((await win.getByTestId('image-row').count()) >= 3);
    await win.getByTestId('image-row').filter({ hasText: 'shop/worker:latest' }).waitFor();
    // Extensions are shared by both workspaces: the example adds a command to ECS services.
    const r = await win.evaluate(() => globalThis.k8sc.invoke('extensions:installJson', JSON.stringify({ apiVersion: 1, id: 'ecs-tools', name: 'ECS tools', version: '1.0.0', commands: [{ id: 'desc', title: 'Describe service', command: 'aws ecs describe-services --cluster {{cluster}} --services {{service}}', kinds: ['EcsService'] }] })));
    assert.equal(r.ok, true, r.error);
    await win.getByTestId('ecs-nav-services').click();
    await win.getByTestId('ecs-service-row').filter({ hasText: 'web' }).click();
    await details.getByTestId('extension-command').filter({ hasText: 'Describe service' }).waitFor();
    await win.getByTestId('ecs-nav-overview').click();
  });

  await step('AWS shell is bound to the profile and region', async () => {
    await win.getByTestId('toggle-terminal').click();
    const term = win.getByTestId('dock-terminal').last();
    await term.waitFor();
    await win.waitForTimeout(1500);
    await term.click();
    // The default shell is PowerShell on Windows and zsh/bash elsewhere.
    const probe = process.platform === 'win32' ? 'Write-Output ("bound:" + $env:AWS_PROFILE + ":" + $env:AWS_REGION + ":" + $env:K8SC_ECS_CLUSTER)' : 'echo "bound:$AWS_PROFILE:$AWS_REGION:$K8SC_ECS_CLUSTER"';
    await win.keyboard.type(probe + '\n');
    await term.getByText('bound:e2e:eu-west-2:shop-prod').waitFor({ timeout: 15000 });
    await win.getByRole('button', { name: 'Hide terminal' }).click();
  });

  await step('read-write connection: scale, roll back and stop a task (all confirmed)', async () => {
    await win.getByTestId('aws-disconnect').click();
    await win.getByTestId('ecs-connect').waitFor();
    await win.getByTestId('aws-readonly').uncheck();
    await win.getByTestId('aws-connect').click();
    await win.getByTestId('ecs-overview').waitFor();
    assert.equal(await win.getByTestId('aws-mode').textContent(), 'read-write');

    await win.getByTestId('ecs-nav-services').click();
    await win.getByTestId('ecs-service-row').filter({ hasText: 'web' }).click();
    await win.getByTestId('ecs-scale').click();
    const modal = win.locator('.modal');
    await modal.getByRole('textbox').fill('3');
    await modal.getByRole('button', { name: 'Scale' }).click();
    await win.getByText('web: desired count set to 3').waitFor();
    assert.deepEqual(aws.writes.at(-1), { op: 'UpdateService', input: { cluster: aws.cluster, service: 'web', desiredCount: 3 } });

    await details.getByRole('button', { name: 'Deploy revision' }).click();
    await modal.getByRole('combobox', { name: 'Revision' }).selectOption({ label: 'web:4' });
    await modal.getByRole('button', { name: 'Roll back' }).click();
    await win.getByText('Deploying web:4 to web').waitFor();
    assert.equal(aws.writes.at(-1).input.taskDefinition.endsWith('task-definition/web:4'), true);

    await win.getByTestId('ecs-nav-tasks').click();
    await win.getByTestId('ecs-task-row').filter({ hasText: 'a1aaaaaaaaaa' }).click();
    await details.getByRole('button', { name: 'Stop' }).click();
    await modal.getByRole('button', { name: 'Stop task' }).click();
    await win.getByText('Stopping task a1aaaaaaaaaa').waitFor();
    assert.equal(aws.writes.at(-1).op, 'StopTask');
    assert.match(aws.writes.at(-1).input.task, /task\/shop-prod\/a1a+$/);
    assert.equal(aws.writes.length, 3, 'exactly the three confirmed writes');
  });

  await step('redeploy, ECS Exec toggle and run a one-off task', async () => {
    const modal = win.locator('.modal');
    await win.getByTestId('ecs-nav-services').click();
    await win.getByTestId('ecs-service-row').filter({ hasText: 'worker' }).click();
    await details.getByRole('button', { name: 'Redeploy' }).click();
    await modal.getByRole('button', { name: 'Redeploy' }).click();
    await win.getByText('New deployment of worker started').waitFor();
    assert.deepEqual(aws.writes.at(-1).input, { cluster: aws.cluster, service: 'worker', forceNewDeployment: true });
    await details.getByRole('button', { name: 'Enable ECS Exec' }).click();
    await modal.getByRole('button', { name: 'Enable' }).click();
    await win.getByText('ECS Exec enabled for worker').waitFor();
    assert.deepEqual(aws.writes.at(-1).input, { cluster: aws.cluster, service: 'worker', enableExecuteCommand: true, forceNewDeployment: true });

    await win.getByTestId('ecs-nav-taskdefs').click();
    await win.getByTestId('ecs-family').filter({ hasText: 'batch' }).click();
    await win.getByTestId('yaml-editor').getByText('shop/batch:2.0.0').waitFor();
    await win.getByRole('button', { name: 'Run task' }).click();
    await modal.getByRole('combobox').first().selectOption('batch');
    await modal.getByPlaceholder('e.g. npm run migrate').fill('node scripts/backfill.js --since "2 days"');
    await modal.getByRole('button', { name: 'Run task' }).click();
    await win.getByText('Started 1 task').waitFor();
    const run = aws.writes.at(-1);
    assert.equal(run.op, 'RunTask');
    assert.match(run.input.taskDefinition, /task-definition\/batch:1$/);
    assert.deepEqual(run.input.overrides, { containerOverrides: [{ name: 'batch', command: ['node', 'scripts/backfill.js', '--since', '2 days'] }] });
    assert.deepEqual(run.input.networkConfiguration.awsvpcConfiguration.subnets, ['subnet-0aaaaaaaaaaaaaaaa']);
    assert.equal(run.input.startedBy, 'k8sconsole');
    // The app opens the Tasks view on the new task.
    await details.getByText('Task', { exact: true }).waitFor();
  });

  await step('deregister a revision and delete a service (typed confirmations)', async () => {
    const modal = win.locator('.modal');
    await win.getByTestId('ecs-nav-taskdefs').click();
    await win.getByTestId('ecs-family').filter({ hasText: 'web' }).click();
    await win.getByRole('combobox', { name: 'Revision' }).selectOption({ label: 'revision 4' });
    await win.getByTestId('yaml-editor').getByText('shop/web:1.4.0').waitFor();
    await win.getByRole('button', { name: 'Deregister' }).click();
    const confirmBtn = modal.getByRole('button', { name: 'Deregister' });
    assert.equal(await confirmBtn.isDisabled(), true, 'needs the typed name');
    await modal.getByLabel('Confirmation text').fill('web:4');
    await confirmBtn.click();
    await win.getByText('Deregistered web:4').waitFor();
    assert.deepEqual(aws.writes.at(-1), { op: 'DeregisterTaskDefinition', input: { taskDefinition: aws.cluster.replace(':cluster/shop-prod', ':task-definition/web:4') } });

    await win.getByTestId('ecs-nav-services').click();
    await win.getByTestId('ecs-service-row').filter({ hasText: 'batch' }).click();
    await details.getByRole('button', { name: 'Delete' }).click();
    await modal.getByLabel('Confirmation text').fill('batch');
    await modal.getByRole('button', { name: 'Delete' }).click();
    await win.getByText('Deleted service batch').waitFor();
    assert.deepEqual(aws.writes.at(-1), { op: 'DeleteService', input: { cluster: aws.cluster, service: 'batch', force: false } });
  });

  await step('registers an edited task definition without read-only fields', async () => {
    const d = await win.evaluate(() => globalThis.k8sc.invoke('ecs:taskDefinition', 'web:5'));
    assert.equal(d.ok, true);
    const edited = JSON.parse(d.value.json);
    edited.containerDefinitions[0].image = 'shop/web:1.6.0';
    const r = await win.evaluate((j) => globalThis.k8sc.invoke('ecs:registerTaskDefinition', j), JSON.stringify(edited));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.revision, 6);
    const sent = aws.writes.at(-1).input;
    assert.equal(sent.containerDefinitions[0].image, 'shop/web:1.6.0');
    for (const k of ['taskDefinitionArn', 'revision', 'status', 'compatibilities', 'registeredAt']) assert.equal(k in sent, false, `${k} must not be sent`);
  });

  await step('switching back to Kubernetes keeps both workspaces working', async () => {
    await win.getByTestId('ws-kubernetes').click();
    await win.getByTestId('context-select').waitFor();
    await win.getByTestId('ws-ecs').click();
    // The ECS workspace comes back where it was left (the Services view), still connected.
    await win.getByRole('heading', { name: 'Services', exact: true }).waitFor();
    assert.equal(await win.getByTestId('aws-mode').textContent(), 'read-write');
  });
} catch {
  failed = true;
  await app.win?.screenshot({ path: join(shots, 'ecs-failure.png') }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
  await aws.close();
  try {
    // The app can still be flushing files while it exits; retry, and never fail the run over cleanup.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.log('  (temp cleanup skipped:', err.code ?? err.message, ')');
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nECS E2E: ${passed}/${results.length} steps passed`);
  try {
    writeFileSync(join(root, 'reports/evidence/e2e-ecs-results.json'), JSON.stringify({ exe: exeIdx > 0 ? exe : 'dev', results }, null, 2));
  } catch {
    // read-only checkout
  }
  process.exit(failed ? 1 : 0);
}
