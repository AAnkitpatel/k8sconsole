/**
 * Integration tests against a DISPOSABLE cluster (k3s in Docker, see README).
 * Set K8SC_TEST_KUBECONFIG to its kubeconfig. Fixtures: tests/fixtures/demo.yaml (namespace k8sc-demo).
 * HOME is redirected to a temp dir so the developer's ~/.kube is never read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { AppController } from '../../build/app/src/main/controller';
import type { EventApi, EventName } from '../../build/app/src/shared/api';
import type { KubeObject, ResourceRef } from '../../build/app/src/shared/types';

const KUBECONFIG = process.env.K8SC_TEST_KUBECONFIG;
const NS = 'k8sc-demo';
const d = KUBECONFIG ? describe : describe.skip;

const POD: ResourceRef = { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
const DEPLOY: ResourceRef = { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true };
const CM: ResourceRef = { apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true };
const CRON: ResourceRef = { apiVersion: 'batch/v1', kind: 'CronJob', plural: 'cronjobs', namespaced: true };
const NODE: ResourceRef = { apiVersion: 'v1', kind: 'Node', plural: 'nodes', namespaced: false };

type Ev = { [E in EventName]: { event: E; payload: EventApi[E] } }[EventName];

function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeout = 60000, interval = 250): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const v = await fn();
        if (v) return resolve(v as T);
      } catch {
        // retry
      }
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(tick, interval);
    };
    void tick();
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

d('AppController against a disposable cluster', () => {
  let dir: string;
  let ctrl: AppController;
  const events: Ev[] = [];
  const h = () => ctrl.handlers;

  /** A Ready, non-terminating web pod that has been running long enough to have logs. */
  const readyWebPod = () =>
    waitFor(async () => {
      const pods = await h()['resource:list']({ resource: POD, namespace: NS, labelSelector: 'app=web' });
      return pods.find(
        (p) =>
          !p.metadata.deletionTimestamp &&
          (p.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True') &&
          Date.now() - Date.parse(p.status?.startTime ?? '') > 6000,
      );
    }, 120000, 1000);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'k8sc-int-'));
    ctrl = new AppController({
      userDataDir: join(dir, 'userData'),
      home: join(dir, 'home'),
      envKubeconfig: KUBECONFIG,
      autosuggestPlugin: resolve(__dirname, '../../build/app/resources/shell/zsh-autosuggestions.zsh'),
      emit: (event, payload) => events.push({ event, payload } as Ev),
      appInfo: () => ({ version: 'test', electron: '-', chrome: '-', node: process.versions.node, platform: process.platform }),
      dialogs: {
        pickFile: async () => null,
        pickFolder: async () => null,
        saveFile: async (name) => join(dir, name),
        openExternal: async () => undefined,
      },
    });
  });

  afterAll(async () => {
    try {
      await h()['resource:delete'](CM, NS, 'k8sc-int-created');
    } catch {
      // already gone
    }
    ctrl?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers the kubeconfig from $KUBECONFIG only (not the real home)', async () => {
    const { sources, contexts } = await h()['kubeconfig:list']();
    expect(sources).toHaveLength(1);
    expect(sources[0].origin).toBe('env');
    expect(contexts[0].name).toBe('k3s-disposable');
    expect(contexts[0].authMethod).toBe('client certificate');
  });

  it('connects, reports the server version and lists namespaces', async () => {
    const { contexts } = await h()['kubeconfig:list']();
    const s = await h()['cluster:connect'](contexts[0].id);
    expect(s.state).toBe('connected');
    expect(s.serverVersion).toMatch(/^v1\.\d+/);
    expect(s.namespaces).toContain(NS);
    expect(s.canListNamespaces).toBe(true);
    const disc = await h()['cluster:discovery']();
    expect(disc.some((r) => r.kind === 'Deployment' && r.apiVersion === 'apps/v1')).toBe(true);
  });

  it('lists pods, deployments and reads YAML', async () => {
    const pods = (await h()['resource:list']({ resource: POD, namespace: NS, labelSelector: 'app=web' })).filter((p) => !p.metadata.deletionTimestamp);
    expect(pods.length).toBeGreaterThanOrEqual(2);
    expect(pods[0].kind).toBe('Pod');
    const yaml = await h()['resource:yaml'](DEPLOY, NS, 'web');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).not.toContain('managedFields');
  });

  it('watches live changes: scaling a deployment emits MODIFIED events', async () => {
    const { subscriptionId } = await h()['resource:watch']({ resource: DEPLOY, namespace: NS });
    await waitFor(() => events.find((e) => e.event === 'watch:event' && e.payload.subscriptionId === subscriptionId && e.payload.type === 'SNAPSHOT'));
    await h()['action:scale'](DEPLOY, NS, 'web', 3);
    const mod = await waitFor(() =>
      events.find((e) => e.event === 'watch:event' && e.payload.subscriptionId === subscriptionId && e.payload.type === 'MODIFIED' && (e.payload.object as KubeObject).spec.replicas === 3),
    );
    expect(mod).toBeTruthy();
    await h()['resource:unwatch'](subscriptionId);
    await h()['action:scale'](DEPLOY, NS, 'web', 2);
  });

  it('edits YAML with dry run, applies it, and detects conflicts', async () => {
    const original = await h()['resource:yaml'](CM, NS, 'app-config');
    const before = (await h()['resource:get'](CM, NS, 'app-config')).data.greeting;
    const edited = original.replace(/^ {2}greeting: .*$/m, '  greeting: edited by integration test');
    const ref = { ref: CM, namespace: NS, name: 'app-config' };
    const [dry] = await h()['resource:apply'](edited, { dryRun: true, mode: 'replace', original: ref });
    expect(dry.ok).toBe(true);
    expect((await h()['resource:get'](CM, NS, 'app-config')).data.greeting).toBe(before);
    const [applied] = await h()['resource:apply'](edited, { dryRun: false, mode: 'replace', original: ref });
    expect(applied.ok).toBe(true);
    expect((await h()['resource:get'](CM, NS, 'app-config')).data.greeting).toBe('edited by integration test');
    // Re-applying the stale YAML (old resourceVersion) must be rejected as a conflict.
    const [stale] = await h()['resource:apply'](original, { dryRun: false, mode: 'replace', original: ref });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/Conflict/);
    const fresh = await h()['resource:yaml'](CM, NS, 'app-config');
    await h()['resource:apply'](fresh.replace(/^ {2}greeting: .*$/m, '  greeting: hello from k8sconsole'), { dryRun: false, mode: 'replace', original: ref });
  });

  it('rejects unknown fields server-side (strict field validation)', async () => {
    const [r] = await h()['resource:apply'](`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: strict-check\n  namespace: ${NS}\nbogusField: 1\n`, { dryRun: true, mode: 'create' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown field/i);
  });

  it('creates and deletes a resource from YAML', async () => {
    const [r] = await h()['resource:apply'](`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: k8sc-int-created\n  namespace: ${NS}\ndata:\n  x: "1"\n`, { dryRun: false, mode: 'create' });
    expect(r.ok).toBe(true);
    await h()['resource:delete'](CM, NS, 'k8sc-int-created');
    await waitFor(async () => {
      try {
        await h()['resource:get'](CM, NS, 'k8sc-int-created');
        return false;
      } catch (err: any) {
        return /not found/i.test(err.message);
      }
    });
  });

  it('reads events for a failing pod', async () => {
    const pod = await h()['resource:get'](POD, NS, 'crasher');
    const evs = await waitFor(async () => {
      const e = await h()['resource:events'](NS, pod.metadata.uid!);
      return e.length ? e : null;
    });
    expect(evs.some((e) => e.involvedObject.name === 'crasher')).toBe(true);
  });

  it('streams logs (tail, then follow) and previous logs of a restarted container', async () => {
    const pod = await readyWebPod();
    const { streamId } = await h()['logs:start']({ namespace: NS, pod: pod.metadata.name, container: 'web', follow: false, tailLines: 5, timestamps: true, previous: false });
    const end = await waitFor(() => events.find((e) => e.event === 'logs:chunk' && e.payload.streamId === streamId && e.payload.end));
    const text = events.filter((e) => e.event === 'logs:chunk' && e.payload.streamId === streamId).map((e) => (e.payload as any).data ?? '').join('');
    expect(end).toBeTruthy();
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T.* tick \d+/m);
    expect(text.trim().split('\n').length).toBeLessThanOrEqual(5);

    const follow = await h()['logs:start']({ namespace: NS, pod: pod.metadata.name, container: 'web', follow: true, tailLines: 1, timestamps: false, previous: false });
    await waitFor(() => events.filter((e) => e.event === 'logs:chunk' && e.payload.streamId === follow.streamId && (e.payload as any).data).length >= 2, 20000);
    await h()['logs:stop'](follow.streamId);

    await waitFor(async () => ((await h()['resource:get'](POD, NS, 'crasher')).status?.containerStatuses?.[0]?.restartCount ?? 0) >= 1, 90000, 1000);
    // Right after a restart the runtime may briefly report the previous log as unavailable; retry like a user would.
    const prevText = await waitFor(async () => {
      const prev = await h()['logs:start']({ namespace: NS, pod: 'crasher', container: 'crash', follow: false, timestamps: false, previous: true });
      await waitFor(() => events.find((e) => e.event === 'logs:chunk' && e.payload.streamId === prev.streamId && e.payload.end));
      const t = events.filter((e) => e.event === 'logs:chunk' && e.payload.streamId === prev.streamId).map((e) => (e.payload as any).data ?? '').join('');
      return t.includes('about-to-crash') ? t : null;
    }, 60000, 2000);
    expect(prevText).toContain('about-to-crash');
  });

  it('reports a clear error for logs of a missing container', async () => {
    const { streamId } = await h()['logs:start']({ namespace: NS, pod: 'crasher', container: 'nope', follow: false, timestamps: false, previous: false });
    const end = await waitFor(() => events.find((e) => e.event === 'logs:chunk' && e.payload.streamId === streamId && e.payload.end));
    expect((end.payload as any).error).toMatch(/nope|not found|not valid/i);
  });

  it('runs an interactive shell over exec and handles resize', async () => {
    const pod = await readyWebPod();
    const { sessionId } = await h()['exec:start']({ namespace: NS, pod: pod.metadata.name, container: 'web', cols: 100, rows: 30 });
    await new Promise((r) => setTimeout(r, 1500));
    await h()['exec:resize'](sessionId, 120, 40);
    await h()['exec:input'](sessionId, 'echo K8SC_$((40+2)); stty size\n');
    const out = await waitFor(() => {
      const t = events.filter((e) => e.event === 'exec:data' && e.payload.sessionId === sessionId).map((e) => (e.payload as any).data ?? '').join('');
      return t.includes('K8SC_42') && /40 120/.test(t) ? t : null;
    }, 20000);
    expect(out).toContain('K8SC_42');
    await h()['exec:input'](sessionId, 'exit\n');
    await waitFor(() => events.find((e) => e.event === 'exec:data' && e.payload.sessionId === sessionId && (e.payload as any).exit), 20000);
  });

  it('port-forwards a service (named targetPort) on 127.0.0.1', async () => {
    const f = await h()['portforward:start']({ namespace: NS, targetKind: 'Service', targetName: 'web', remotePort: 80, localPort: 0 });
    expect(f.localPort).toBeGreaterThan(0);
    expect(f.podName).toMatch(/^web-/);
    const body = await waitFor(() => httpGet(`http://127.0.0.1:${f.localPort}/`).then((b) => (b.includes('k8sc-web-ok') ? b : null)), 20000);
    expect(body).toContain('k8sc-web-ok');
    expect((await h()['portforward:list']()).map((x) => x.id)).toContain(f.id);
    await h()['portforward:stop'](f.id);
    expect(await h()['portforward:list']()).toHaveLength(0);
  });

  it('rejects port-forwards to a port already in use', async () => {
    const a = await h()['portforward:start']({ namespace: NS, targetKind: 'Service', targetName: 'web', remotePort: 80, localPort: 0 });
    await expect(h()['portforward:start']({ namespace: NS, targetKind: 'Service', targetName: 'web', remotePort: 80, localPort: a.localPort })).rejects.toThrow(/EADDRINUSE/);
    await h()['portforward:stop'](a.id);
  });

  it('restarts a deployment (rolling) and triggers / suspends a CronJob', async () => {
    await h()['action:restart'](DEPLOY, NS, 'web');
    const dep = await h()['resource:get'](DEPLOY, NS, 'web');
    expect(dep.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toBeTruthy();

    const { jobName } = await h()['action:triggerCronJob'](NS, 'nightly');
    const job = await h()['resource:get']({ apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaced: true }, NS, jobName);
    expect(job.metadata.ownerReferences?.[0].kind).toBe('CronJob');
    await h()['resource:delete']({ apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaced: true }, NS, jobName);

    await h()['action:suspendCronJob'](NS, 'nightly', false);
    expect((await h()['resource:get'](CRON, NS, 'nightly')).spec.suspend).toBe(false);
    await h()['action:suspendCronJob'](NS, 'nightly', true);
    expect((await h()['resource:get'](CRON, NS, 'nightly')).spec.suspend).toBe(true);
  });

  it('cordons and uncordons the node', async () => {
    const [node] = await h()['resource:list']({ resource: NODE });
    await h()['action:cordon'](node.metadata.name, true);
    expect((await h()['resource:get'](NODE, undefined, node.metadata.name)).spec.unschedulable).toBe(true);
    await h()['action:cordon'](node.metadata.name, false);
    expect((await h()['resource:get'](NODE, undefined, node.metadata.name)).spec.unschedulable).toBeFalsy();
  });

  it('evicts a pod managed by a deployment, which then gets replaced', async () => {
    await waitFor(async () => (await h()['resource:get'](DEPLOY, NS, 'web')).status?.readyReplicas === 2, 120000, 1000);
    const pods = await h()['resource:list']({ resource: POD, namespace: NS, labelSelector: 'app=web' });
    const victim = pods.find((p) => !p.metadata.deletionTimestamp)!;
    await h()['action:evict'](NS, victim.metadata.name);
    await waitFor(async () => {
      const now = await h()['resource:list']({ resource: POD, namespace: NS, labelSelector: 'app=web' });
      return !now.some((p) => p.metadata.name === victim.metadata.name);
    }, 120000, 1000);
  });

  it('reports metrics availability without failing', async () => {
    const m = await h()['metrics:get']();
    expect(typeof m.available).toBe('boolean');
    if (!m.available) expect(m.error).toBeTruthy();
  });

  it('saves logs to a private file', async () => {
    const r = await h()['logs:save']('../../evil name.log', 'line\n');
    expect(r.saved).toBe(true);
    expect(r.path).toBe(join(dir, '.._.._evil_name.log'));
  });

  it('rejects malformed input crossing the IPC boundary', async () => {
    await expect(h()['resource:get']({ apiVersion: 'v1', kind: 'Pod', plural: 'pods/../../secrets', namespaced: true }, NS, 'x')).rejects.toThrow(/Invalid/);
    await expect(h()['logs:start']({ namespace: '../x', pod: 'p', container: 'c', follow: false, timestamps: false, previous: false })).rejects.toThrow(/Invalid/);
    await expect(h()['app:openExternal']('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('fails clearly when the API server is unreachable, then recovers on reconnect', async () => {
    const bad = join(dir, 'unreachable.yaml');
    writeFileSync(
      bad,
      'apiVersion: v1\nkind: Config\nclusters:\n- name: dead\n  cluster:\n    server: https://127.0.0.1:1\n    insecure-skip-tls-verify: true\nusers:\n- name: u\n  user:\n    token: x\ncontexts:\n- name: dead\n  context: {cluster: dead, user: u}\ncurrent-context: dead\n',
    );
    await h()['settings:update']({ kubeconfigFiles: [bad] });
    const { contexts } = await h()['kubeconfig:list']();
    const dead = contexts.find((c) => c.name === 'dead')!;
    const s = await h()['cluster:connect'](dead.id);
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/Connection refused/);
    await expect(h()['resource:list']({ resource: POD })).rejects.toThrow(/Not connected/);
    const good = contexts.find((c) => c.name === 'k3s-disposable')!;
    expect((await h()['cluster:connect'](good.id)).state).toBe('connected');
  });

  it('monitor samples real usage through the kubelet summary API and keeps history', async () => {
    const first = await h()['monitor:start']();
    expect(first?.source).toBe('kubelet-summary');
    expect(first!.nodes[0].cpuUsageMillis).toBeGreaterThan(0);
    expect(first!.nodes[0].memUsageBytes).toBeGreaterThan(0);
    expect(first!.cluster.cpuAllocMillis).toBeGreaterThan(0);
    const web = first!.pods.find((p) => p.namespace === NS && p.name.startsWith('web-'));
    expect(web?.cpuUsageMillis).toBeDefined();
    const updates = events.filter((e) => e.event === 'monitor:update').length;
    // A second sample arrives after the 10 s interval and yields network rates.
    const next = await waitFor(() => {
      const u = events.filter((e) => e.event === 'monitor:update');
      return u.length > updates ? (u[u.length - 1].payload as any) : null;
    }, 30000, 500);
    expect(next.cluster.history.t.length).toBeGreaterThanOrEqual(2);
    expect(next.nodes[0].rxBps).toBeGreaterThanOrEqual(0);
    const live = (next.pods as Array<{ namespace: string; name: string; cpuUsageMillis?: number }>).find((p) => p.namespace === NS && p.name.startsWith('web-') && p.cpuUsageMillis !== undefined)!;
    expect((await h()['monitor:podHistory'](NS, live.name))!.t.length).toBeGreaterThanOrEqual(1);
    await h()['monitor:stop']();
  }, 60000);

  it('opens a cluster-bound zsh where kubectl talks to the connected cluster and namespace', async () => {
    const info = await h()['terminal:start']({ cols: 160, rows: 40, shell: 'zsh', bindToCluster: true, namespace: NS });
    expect(info.context).toBe('k3s-disposable');
    expect(info.namespace).toBe(NS);
    const text = () => events.filter((e) => e.event === 'terminal:data' && (e.payload as any).sessionId === info.sessionId).map((e) => (e.payload as any).data ?? '').join('');
    await waitFor(() => /namespace .*k8sc-demo/.test(text()), 20000, 100);
    await h()['terminal:input'](info.sessionId, 'kubectl get deploy web -o name && echo KDONE\r');
    await waitFor(() => /deployment\.apps\/web[\s\S]*KDONE/.test(text()), 30000, 200);
    const sug = await h()['terminal:suggestions'](NS);
    expect(sug.some((s) => s.startsWith('kubectl logs -f web-'))).toBe(true);
    await h()['terminal:stop'](info.sessionId);
  }, 60000);

  it('disconnect stops sessions and port forwards', async () => {
    const f = await h()['portforward:start']({ namespace: NS, targetKind: 'Service', targetName: 'web', remotePort: 80, localPort: 0 });
    expect(f.state).toBe('active');
    await h()['cluster:disconnect']();
    expect(await h()['portforward:list']()).toHaveLength(0);
    expect((await h()['cluster:status']()).state).toBe('disconnected');
  });
});
