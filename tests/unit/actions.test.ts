import { afterEach, describe, expect, it } from 'vitest';
import { KubeRest } from '../../build/app/src/main/kube/rest';
import { applyYaml, drainNode, jobFromCronJob, restartWorkload, scaleWorkload, discoverResources, deleteResource } from '../../build/app/src/main/kube/resources';
import { resolveServiceTarget } from '../../build/app/src/main/kube/portforward';
import type { ApiResourceInfo, KubeObject } from '../../build/app/src/shared/types';
import { json, startMockApi, status } from './mock-api';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

const DISCOVERY: ApiResourceInfo[] = [
  { group: '', version: 'v1', apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true, verbs: ['create', 'update'] },
  { group: '', version: 'v1', apiVersion: 'v1', kind: 'Namespace', plural: 'namespaces', namespaced: false, verbs: ['create'] },
];

describe('workload actions', () => {
  it('scales through the scale subresource with a merge patch', async () => {
    const api = await startMockApi((_r, res) => json(res, 200, {}));
    cleanup.push(api.close);
    await scaleWorkload(new KubeRest(api.kc), { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true }, 'prod', 'api', 3);
    const r = api.requests[0];
    expect(r.method).toBe('PATCH');
    expect(r.url.pathname).toBe('/apis/apps/v1/namespaces/prod/deployments/api/scale');
    expect(r.headers['content-type']).toBe('application/merge-patch+json');
    expect(JSON.parse(r.body)).toEqual({ spec: { replicas: 3 } });
  });

  it('refuses to scale unsupported kinds or invalid counts', async () => {
    const api = await startMockApi((_r, res) => json(res, 200, {}));
    cleanup.push(api.close);
    const rest = new KubeRest(api.kc);
    await expect(scaleWorkload(rest, { apiVersion: 'apps/v1', kind: 'DaemonSet', plural: 'daemonsets', namespaced: true }, 'a', 'b', 1)).rejects.toThrow();
    await expect(scaleWorkload(rest, { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true }, 'a', 'b', -1)).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
  });

  it('restarts like kubectl rollout restart', async () => {
    const api = await startMockApi((_r, res) => json(res, 200, {}));
    cleanup.push(api.close);
    await restartWorkload(new KubeRest(api.kc), { apiVersion: 'apps/v1', kind: 'StatefulSet', plural: 'statefulsets', namespaced: true }, 'db', 'pg', new Date('2026-01-01T00:00:00Z'));
    expect(JSON.parse(api.requests[0].body)).toEqual({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-01-01T00:00:00.000Z' } } } } });
  });

  it('deletes with background propagation', async () => {
    const api = await startMockApi((_r, res) => json(res, 200, {}));
    cleanup.push(api.close);
    await deleteResource(new KubeRest(api.kc), { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true }, 'ns', 'p');
    expect(api.requests[0].method).toBe('DELETE');
    expect(JSON.parse(api.requests[0].body).propagationPolicy).toBe('Background');
  });

  it('builds a manual Job from a CronJob template with an owner reference', () => {
    const cron: KubeObject = {
      kind: 'CronJob',
      metadata: { name: 'a'.repeat(60), namespace: 'ns', uid: 'u1' },
      spec: { jobTemplate: { metadata: { labels: { team: 'x' } }, spec: { template: { spec: { containers: [] } } } } },
    };
    const job = jobFromCronJob(cron, new Date(1700000000000));
    expect(job.metadata.name.length).toBeLessThanOrEqual(63);
    expect(job.metadata.name).toMatch(/-manual-[a-z0-9]+$/);
    expect(job.metadata.annotations?.['cronjob.kubernetes.io/instantiate']).toBe('manual');
    expect(job.metadata.labels).toEqual({ team: 'x' });
    expect(job.metadata.ownerReferences?.[0]).toMatchObject({ kind: 'CronJob', uid: 'u1', controller: true });
    expect(job.spec).toEqual(cron.spec.jobTemplate.spec);
  });

  it('drains a node: cordons, evicts regular pods, skips DaemonSet/mirror/finished pods and reports PDB failures', async () => {
    const pods = [
      { metadata: { name: 'app', namespace: 'a' }, status: { phase: 'Running' } },
      { metadata: { name: 'ds', namespace: 'kube-system', ownerReferences: [{ kind: 'DaemonSet', name: 'x', uid: '1', apiVersion: 'apps/v1' }] }, status: { phase: 'Running' } },
      { metadata: { name: 'static', namespace: 'kube-system', annotations: { 'kubernetes.io/config.mirror': 'x' } }, status: { phase: 'Running' } },
      { metadata: { name: 'done', namespace: 'a' }, status: { phase: 'Succeeded' } },
      { metadata: { name: 'guarded', namespace: 'a' }, status: { phase: 'Running' } },
    ];
    const api = await startMockApi((r, res) => {
      if (r.method === 'GET') return json(res, 200, { metadata: {}, items: pods });
      if (r.url.pathname.endsWith('/guarded/eviction')) return status(res, 429, 'Cannot evict pod as it would violate the pod disruption budget.', 'TooManyRequests');
      json(res, 200, {});
    });
    cleanup.push(api.close);
    const r = await drainNode(new KubeRest(api.kc), 'node-1');
    expect(api.requests[0]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(api.requests[0].body)).toEqual({ spec: { unschedulable: true } });
    expect(api.requests[1].url.searchParams.get('fieldSelector')).toBe('spec.nodeName=node-1');
    expect(r.evicted).toEqual(['a/app']);
    expect(r.skipped).toEqual(['kube-system/ds', 'kube-system/static', 'a/done']);
    expect(r.failed[0]).toContain('a/guarded');
    expect(r.failed[0]).toContain('disruption budget');
  });
});

describe('applyYaml', () => {
  it('replaces an existing object with PUT and supports server-side dry run', async () => {
    const api = await startMockApi((r, res) => json(res, 200, JSON.parse(r.body)));
    cleanup.push(api.close);
    const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: ns\n  resourceVersion: "7"\ndata:\n  a: b\n';
    const [r] = await applyYaml(new KubeRest(api.kc), DISCOVERY, yaml, {
      dryRun: true,
      mode: 'replace',
      defaultNamespace: 'default',
      original: { ref: { apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true }, namespace: 'ns', name: 'cfg' },
    });
    expect(r.ok).toBe(true);
    const req = api.requests[0];
    expect(req.method).toBe('PUT');
    expect(req.url.pathname).toBe('/api/v1/namespaces/ns/configmaps/cfg');
    expect(req.url.searchParams.get('dryRun')).toBe('All');
    expect(req.url.searchParams.get('fieldManager')).toBe('k8sconsole');
    expect(JSON.parse(req.body).metadata.resourceVersion).toBe('7');
  });

  it('explains optimistic-concurrency conflicts', async () => {
    const api = await startMockApi((_r, res) => status(res, 409, 'the object has been modified', 'Conflict'));
    cleanup.push(api.close);
    const [r] = await applyYaml(new KubeRest(api.kc), DISCOVERY, 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: cfg, namespace: ns}\n', {
      dryRun: false,
      mode: 'replace',
      defaultNamespace: 'default',
      original: { ref: { apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true }, namespace: 'ns', name: 'cfg' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Conflict.*reload/);
  });

  it('creates every document, defaulting the namespace, and reports unknown kinds', async () => {
    const api = await startMockApi((r, res) => json(res, 201, JSON.parse(r.body)));
    cleanup.push(api.close);
    const yaml = 'apiVersion: v1\nkind: Namespace\nmetadata: {name: n1}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: c1}\n---\napiVersion: example.com/v1\nkind: Widget\nmetadata: {name: w}\n';
    const results = await applyYaml(new KubeRest(api.kc), DISCOVERY, yaml, { dryRun: false, mode: 'create', defaultNamespace: 'team' });
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(api.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /api/v1/namespaces', 'POST /api/v1/namespaces/team/configmaps']);
    expect(results[2].error).toContain('does not serve Widget');
  });

  it('does not send anything when local validation fails', async () => {
    const api = await startMockApi((_r, res) => json(res, 200, {}));
    cleanup.push(api.close);
    const [r] = await applyYaml(new KubeRest(api.kc), DISCOVERY, 'kind: ConfigMap\n', { dryRun: false, mode: 'create', defaultNamespace: 'x' });
    expect(r.ok).toBe(false);
    expect(api.requests).toHaveLength(0);
  });
});

describe('discoverResources', () => {
  it('collects core and group resources, skipping subresources and failing groups', async () => {
    const api = await startMockApi((r, res) => {
      const p = r.url.pathname;
      if (p === '/api') return json(res, 200, { versions: ['v1'] });
      if (p === '/api/v1') return json(res, 200, { resources: [{ name: 'pods', kind: 'Pod', namespaced: true, verbs: ['list'] }, { name: 'pods/log', kind: 'Pod', namespaced: true }] });
      if (p === '/apis') return json(res, 200, { groups: [{ preferredVersion: { groupVersion: 'apps/v1' } }, { preferredVersion: { groupVersion: 'metrics.k8s.io/v1beta1' } }] });
      if (p === '/apis/apps/v1') return json(res, 200, { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['list', 'update'] }] });
      status(res, 503, 'service unavailable');
    });
    cleanup.push(api.close);
    const d = await discoverResources(new KubeRest(api.kc));
    expect(d.map((x) => `${x.apiVersion}/${x.plural}`).sort()).toEqual(['apps/v1/deployments', 'v1/pods']);
  });
});

describe('resolveServiceTarget', () => {
  const svc: KubeObject = { kind: 'Service', metadata: { name: 'web' }, spec: { ports: [{ port: 80, targetPort: 'http' }, { port: 9000, targetPort: 9001 }] } };
  const ready = (name: string, ports: any[]) => ({
    metadata: { name },
    spec: { containers: [{ name: 'c', ports }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  });
  it('resolves named and numeric target ports on ready pods', () => {
    expect(resolveServiceTarget(svc, [ready('p1', [{ name: 'http', containerPort: 8080 }])], 80)).toEqual({ pod: 'p1', port: 8080 });
    expect(resolveServiceTarget(svc, [ready('p1', [])], 9000)).toEqual({ pod: 'p1', port: 9001 });
  });
  it('ignores pods that are not ready and reports clear errors', () => {
    const notReady = { ...ready('p0', [{ name: 'http', containerPort: 1 }]), status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } };
    expect(() => resolveServiceTarget(svc, [notReady], 80)).toThrow(/No ready pods/);
    expect(() => resolveServiceTarget(svc, [ready('p1', [])], 81)).toThrow(/no port 81/);
    expect(() => resolveServiceTarget(svc, [ready('p1', [{ name: 'other', containerPort: 1 }])], 80)).toThrow(/named port/);
  });
});
