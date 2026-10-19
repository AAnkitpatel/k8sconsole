import { describe, expect, it } from 'vitest';
import { buildResourceGraph, collapsePods, hideIdleReplicaSets, neighborhood, nodeId, podReferences, selectorMatches } from '../../build/app/src/shared/graph';
import { runSecurityScan, scanWorkload, scanRbac, scanNetwork, scoreFindings } from '../../build/app/src/shared/security';
import { allows, bindingManifest, effectiveRules, knownSubjects, permissionMatrix, roleManifest, ruleAllows, whoCan, type RbacData } from '../../build/app/src/shared/rbac';
import { buildLanes, density, toOccurrence } from '../../build/app/src/shared/timeline';
import { redactForAssistant, resolveKind } from '../../build/app/src/main/features';
import type { ApiResourceInfo, KubeObject } from '../../build/app/src/shared/types';

const meta = (name: string, extra: any = {}) => ({ name, namespace: 'shop', uid: `uid-${name}`, ...extra });
const deploy: KubeObject = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('web'), spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { spec: { containers: [{ name: 'c', image: 'nginx' }] } } }, status: { readyReplicas: 2 } };
const rs: KubeObject = { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: meta('web-abc', { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'uid-web', controller: true }] }), spec: { replicas: 2 }, status: { readyReplicas: 2 } };
const pod = (name: string, phase = 'Running'): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: meta(name, { labels: { app: 'web' }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-abc', uid: 'uid-web-abc', controller: true }] }),
  spec: { nodeName: 'n1', serviceAccountName: 'web-sa', containers: [{ name: 'c', envFrom: [{ configMapRef: { name: 'cfg' } }], env: [{ name: 'X', valueFrom: { secretKeyRef: { name: 'creds', key: 'k' } } }] }], volumes: [{ name: 'd', persistentVolumeClaim: { claimName: 'data' } }] },
  status: { phase, containerStatuses: [{ name: 'c', ready: phase === 'Running', state: phase === 'Running' ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff' } } }] },
});
const objects: KubeObject[] = [
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: meta('front'), spec: { rules: [{ http: { paths: [{ backend: { service: { name: 'web' } } }] } }] } },
  { apiVersion: 'v1', kind: 'Service', metadata: meta('web'), spec: { selector: { app: 'web' } } },
  deploy,
  rs,
  pod('web-1'),
  pod('web-2', 'Pending'),
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('cfg') },
  { apiVersion: 'v1', kind: 'Secret', metadata: meta('creds') },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta('data'), spec: { volumeName: 'pv-1' }, status: { phase: 'Bound' } },
  { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'pv-1' } },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('web-sa') },
  { apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
  { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: meta('web'), spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' } } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta('deny'), spec: { podSelector: {} } },
];

describe('relationship graph', () => {
  const g = buildResourceGraph(objects);
  const has = (from: string, to: string, type: string) => g.edges.some((e) => e.from === from && e.to === to && e.type === type);
  it('links traffic, ownership, config, storage, identity, placement, scaling and policy', () => {
    expect(has(nodeId('Ingress', 'shop', 'front'), nodeId('Service', 'shop', 'web'), 'routes')).toBe(true);
    expect(has(nodeId('Service', 'shop', 'web'), nodeId('Pod', 'shop', 'web-1'), 'selects')).toBe(true);
    expect(has(nodeId('Deployment', 'shop', 'web'), nodeId('ReplicaSet', 'shop', 'web-abc'), 'owns')).toBe(true);
    expect(has(nodeId('ReplicaSet', 'shop', 'web-abc'), nodeId('Pod', 'shop', 'web-1'), 'owns')).toBe(true);
    expect(has(nodeId('Pod', 'shop', 'web-1'), nodeId('ConfigMap', 'shop', 'cfg'), 'mounts')).toBe(true);
    expect(has(nodeId('Pod', 'shop', 'web-1'), nodeId('Secret', 'shop', 'creds'), 'mounts')).toBe(true);
    expect(has(nodeId('Pod', 'shop', 'web-1'), nodeId('PersistentVolumeClaim', 'shop', 'data'), 'mounts')).toBe(true);
    expect(has(nodeId('PersistentVolumeClaim', 'shop', 'data'), nodeId('PersistentVolume', undefined, 'pv-1'), 'binds')).toBe(true);
    expect(has(nodeId('Pod', 'shop', 'web-1'), nodeId('ServiceAccount', 'shop', 'web-sa'), 'uses')).toBe(true);
    expect(has(nodeId('Pod', 'shop', 'web-1'), nodeId('Node', undefined, 'n1'), 'runs-on')).toBe(true);
    expect(has(nodeId('HorizontalPodAutoscaler', 'shop', 'web'), nodeId('Deployment', 'shop', 'web'), 'scales')).toBe(true);
    expect(has(nodeId('NetworkPolicy', 'shop', 'deny'), nodeId('Pod', 'shop', 'web-2'), 'guards')).toBe(true);
  });
  it('carries health status', () => {
    expect(g.nodes.find((n) => n.name === 'web-2')?.status).toBe('error');
    expect(g.nodes.find((n) => n.kind === 'Deployment')?.status).toBe('ok');
  });
  it('extracts a neighborhood without expanding through nodes', () => {
    const sub = neighborhood(g, nodeId('ConfigMap', 'shop', 'cfg'), 2);
    expect(sub.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(['ConfigMap', 'Pod', 'ReplicaSet', 'Service']));
    expect(sub.nodes.some((n) => n.kind === 'Ingress')).toBe(false);
  });
  it('collapses large pod sets per owner', () => {
    const many = [rs, ...Array.from({ length: 10 }, (_, i) => pod(`p${i}`))];
    const c = collapsePods(buildResourceGraph(many), 3);
    expect(c.nodes.filter((n) => n.kind === 'Pod')).toHaveLength(4);
    expect(c.nodes.some((n) => n.name === '+7 more pods')).toBe(true);
    expect(c.truncated).toBe(7);
  });
  it('hides ReplicaSets kept only as rollout history', () => {
    const old: KubeObject = { ...rs, metadata: meta('web-old', { ownerReferences: rs.metadata.ownerReferences }), spec: { replicas: 0 }, status: {} };
    const h = hideIdleReplicaSets(buildResourceGraph([...objects, old]));
    expect(h.nodes.some((n) => n.name === 'web-old')).toBe(false);
    expect(h.nodes.some((n) => n.name === 'web-abc')).toBe(true);
  });
  it('evaluates label selectors with expressions', () => {
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }] }, { tier: 'b' })).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['b'] }] }, { tier: 'b' })).toBe(false);
    expect(selectorMatches({ matchExpressions: [{ key: 'x', operator: 'DoesNotExist' }] }, {})).toBe(true);
    expect(selectorMatches({}, { a: '1' })).toBe(true);
    expect(podReferences({ imagePullSecrets: [{ name: 'reg' }] }).secrets.has('reg')).toBe(true);
  });
});

describe('security scan', () => {
  const risky: KubeObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta('risky'),
    spec: {
      template: {
        spec: {
          hostNetwork: true,
          volumes: [{ name: 'h', hostPath: { path: '/var/run/docker.sock' } }],
          containers: [{ name: 'app', image: 'repo/app:latest', securityContext: { privileged: true, capabilities: { add: ['SYS_ADMIN'] } }, env: [{ name: 'DB_PASSWORD', value: 'hunter2' }] }],
        },
      },
    },
  };
  const hardened: KubeObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta('good'),
    spec: {
      template: {
        spec: {
          serviceAccountName: 'good',
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'app',
              image: 'repo/app:1.2.3',
              readinessProbe: { httpGet: { path: '/', port: 80 } },
              resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '128Mi' } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            },
          ],
        },
      },
    },
  };
  it('flags dangerous settings with severities and fixes', () => {
    const f = scanWorkload(risky);
    const rules = f.map((x) => x.rule);
    expect(rules).toEqual(expect.arrayContaining(['privileged', 'host-network', 'host-path', 'dangerous-capabilities', 'mutable-image-tag', 'secret-in-env', 'no-memory-limit', 'run-as-root']));
    const priv = f.find((x) => x.rule === 'privileged')!;
    expect(priv.severity).toBe('critical');
    expect(priv.fix?.patch).toEqual({ spec: { template: { spec: { containers: [{ name: 'app', securityContext: { privileged: false } }] } } } });
  });
  it('reports nothing for a hardened workload', () => {
    expect(scanWorkload(hardened)).toEqual([]);
  });
  it('builds CronJob patches at the job template path and never offers fixes for bare pods', () => {
    const cj: KubeObject = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: meta('cj'), spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'j', image: 'x:1', securityContext: { privileged: true } }] } } } } } };
    expect(scanWorkload(cj).find((x) => x.rule === 'privileged')?.fix?.patch).toEqual({ spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'j', securityContext: { privileged: false } }] } } } } } });
    const bare: KubeObject = { apiVersion: 'v1', kind: 'Pod', metadata: meta('bare'), spec: { containers: [{ name: 'p', image: 'x:1', securityContext: { privileged: true } }] } };
    expect(scanWorkload(bare).every((x) => !x.fix)).toBe(true);
  });
  it('checks RBAC and namespaces', () => {
    const roles = [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'ops' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] }];
    const bindings = [
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'dev-admin' }, roleRef: { kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'User', name: 'dev' }] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'system' }, roleRef: { kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'Group', name: 'system:masters' }] },
    ];
    const r = scanRbac(roles, bindings).map((x) => x.rule);
    expect(r).toEqual(['wildcard-rbac', 'cluster-admin-binding']);
    const n = scanNetwork([{ metadata: { name: 'shop' } }, { metadata: { name: 'kube-system' } }], [], [{ metadata: { name: 'lb', namespace: 'shop' }, spec: { type: 'LoadBalancer' } }]).map((x) => x.rule);
    expect(n).toEqual(['no-network-policy', 'no-pod-security-level', 'exposed-service']);
  });
  it('skips controller-owned pods and scores findings', () => {
    const report = runSecurityScan({ workloads: [risky, hardened, pod('web-1')], roles: [], bindings: [], namespaces: [], networkPolicies: [], services: [] }, 1);
    expect(report.scanned.workloads).toBe(2);
    expect(report.findings[0].severity).toBe('critical');
    expect(report.score).toBeLessThan(100);
    expect(scoreFindings([]).score).toBe(100);
  });
});

describe('RBAC evaluation', () => {
  const data: RbacData = {
    roles: [{ metadata: { name: 'pod-reader', namespace: 'shop' }, rules: [{ apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] }] }],
    clusterRoles: [
      { metadata: { name: 'node-viewer' }, rules: [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list'] }] },
      { metadata: { name: 'one-secret' }, rules: [{ apiGroups: [''], resources: ['secrets'], resourceNames: ['tls'], verbs: ['get'] }] },
    ],
    roleBindings: [
      { kind: 'RoleBinding', metadata: { name: 'readers', namespace: 'shop' }, roleRef: { kind: 'Role', name: 'pod-reader' }, subjects: [{ kind: 'ServiceAccount', name: 'ci' }, { kind: 'Group', name: 'devs' }] },
      { kind: 'RoleBinding', metadata: { name: 'tls', namespace: 'shop' }, roleRef: { kind: 'ClusterRole', name: 'one-secret' }, subjects: [{ kind: 'User', name: 'alice' }] },
    ],
    clusterRoleBindings: [{ kind: 'ClusterRoleBinding', metadata: { name: 'all-sa-nodes' }, roleRef: { kind: 'ClusterRole', name: 'node-viewer' }, subjects: [{ kind: 'Group', name: 'system:serviceaccounts' }] }],
  };
  const ci = { kind: 'ServiceAccount' as const, name: 'ci', namespace: 'shop' };
  it('resolves rules through bindings and implicit groups', () => {
    const rules = effectiveRules(ci, data);
    expect(allows(rules, 'list', '', 'pods', 'shop')?.via.binding).toBe('readers');
    expect(allows(rules, 'list', '', 'pods', 'other')).toBeNull();
    expect(allows(rules, 'get', '', 'nodes', undefined)?.via.binding).toBe('all-sa-nodes');
    expect(allows(rules, 'delete', '', 'pods', 'shop')).toBeNull();
    expect(allows(rules, 'get', '', 'pods/log', 'shop')).not.toBeNull();
    expect(allows(effectiveRules({ kind: 'ServiceAccount', name: 'ci', namespace: 'other' }, data), 'list', '', 'pods', 'shop')).toBeNull();
  });
  it('honours resourceNames and wildcards', () => {
    const alice = effectiveRules({ kind: 'User', name: 'alice' }, data);
    expect(allows(alice, 'get', '', 'secrets', 'shop', 'tls')).not.toBeNull();
    expect(allows(alice, 'get', '', 'secrets', 'shop', 'db')).toBeNull();
    expect(ruleAllows({ verbs: ['*'], apiGroups: ['*'], resources: ['*'] }, 'delete', 'apps', 'deployments')).toBe(true);
  });
  it('answers who-can and builds a permission matrix', () => {
    const who = whoCan(data, 'list', '', 'pods', 'shop').map((w) => `${w.subject.kind}:${w.subject.name}`);
    expect(who).toEqual(['Group:devs', 'ServiceAccount:ci']);
    const m = permissionMatrix(effectiveRules(ci, data), [{ group: '', resource: 'pods' }], 'shop');
    expect(m[0].verbs).toMatchObject({ get: true, list: true, delete: false });
    expect(knownSubjects(data).map((s) => s.name)).toEqual(['devs', 'system:serviceaccounts', 'ci', 'alice']);
  });
  it('generates role and binding manifests', () => {
    expect(roleManifest({ kind: 'Role', name: 'r', namespace: 'shop', rules: [{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] }] })).toMatchObject({ kind: 'Role', metadata: { name: 'r', namespace: 'shop' }, rules: [{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] }] });
    const b = bindingManifest({ kind: 'ClusterRoleBinding', name: 'b', roleKind: 'ClusterRole', roleName: 'view', subjects: [ci, { kind: 'User', name: 'bob' }] });
    expect(b.metadata.namespace).toBeUndefined();
    expect(b.subjects).toEqual([{ kind: 'ServiceAccount', name: 'ci', namespace: 'shop' }, { kind: 'User', name: 'bob', apiGroup: 'rbac.authorization.k8s.io' }]);
  });
});

describe('event timeline', () => {
  const ev = (name: string, type: string, first: string, last: string, count = 1, obj = 'web-1'): KubeObject => ({
    metadata: { name, uid: name, namespace: 'shop', creationTimestamp: first },
    type,
    reason: type === 'Warning' ? 'BackOff' : 'Pulled',
    message: `${name} message`,
    firstTimestamp: first,
    lastTimestamp: last,
    count,
    involvedObject: { kind: 'Pod', name: obj, namespace: 'shop' },
  });
  const events = [ev('a', 'Normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ev('b', 'Warning', '2026-01-01T00:01:00Z', '2026-01-01T00:09:00Z', 5), ev('c', 'Normal', '2026-01-01T00:05:00Z', '2026-01-01T00:05:00Z', 1, 'web-2')];
  const since = Date.parse('2026-01-01T00:00:00Z');
  const until = Date.parse('2026-01-01T00:10:00Z');
  it('groups events per object with warnings first', () => {
    const { lanes } = buildLanes(events, { since, until });
    expect(lanes.map((l) => l.name)).toEqual(['web-1', 'web-2']);
    expect(lanes[0]).toMatchObject({ warnings: 5, total: 6 });
    expect(lanes[0].items[1]).toMatchObject({ type: 'Warning', count: 5, first: Date.parse('2026-01-01T00:01:00Z') });
  });
  it('filters by type, text and window and computes density', () => {
    expect(buildLanes(events, { since, until, types: ['Warning'] }).lanes).toHaveLength(1);
    expect(buildLanes(events, { since, until, text: 'c message' }).lanes.map((l) => l.name)).toEqual(['web-2']);
    expect(buildLanes(events, { since: until + 1, until: until + 2 }).lanes).toHaveLength(0);
    const d = density(buildLanes(events, { since, until }).lanes, since, until, 10);
    expect(d.reduce((a, b) => a + b.warning, 0)).toBe(5);
    expect(d[9].warning).toBe(5);
    expect(toOccurrence({ metadata: { name: 'x' } } as KubeObject)).toBeNull();
  });
});

describe('assistant helpers', () => {
  const discovery: ApiResourceInfo[] = [
    { group: '', version: 'v1', apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true, verbs: ['list'], shortNames: ['po'] },
    { group: 'apps', version: 'v1', apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true, verbs: ['list'], shortNames: ['deploy'] },
    { group: 'extensions.example', version: 'v1', apiVersion: 'extensions.example/v1', kind: 'Deployment', plural: 'deployments', namespaced: true, verbs: ['list'] },
  ];
  it('resolves kinds by name, plural, short name and singular', () => {
    expect(resolveKind(discovery, 'Pod')?.plural).toBe('pods');
    expect(resolveKind(discovery, 'po')?.kind).toBe('Pod');
    expect(resolveKind(discovery, 'deployments')?.apiVersion).toBe('apps/v1');
    expect(resolveKind(discovery, 'deploy')?.kind).toBe('Deployment');
    expect(resolveKind(discovery, 'nope')).toBeNull();
  });
  it('redacts secrets and credential-like env values', () => {
    const s = redactForAssistant({ kind: 'Secret', metadata: { name: 's', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"p":"x"}}' }, managedFields: [{}] }, data: { p: 'aHVudGVyMg==' } });
    expect(s.data).toEqual({ p: '<redacted>' });
    expect(s.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']).toBeUndefined();
    expect(s.metadata.managedFields).toBeUndefined();
    const d = redactForAssistant({ kind: 'Deployment', metadata: { name: 'd' }, spec: { template: { spec: { containers: [{ name: 'c', env: [{ name: 'API_KEY', value: 'k' }, { name: 'MODE', value: 'prod' }] }] } } } });
    expect(d.spec.template.spec.containers[0].env).toEqual([{ name: 'API_KEY', value: '<redacted>' }, { name: 'MODE', value: 'prod' }]);
  });
});
