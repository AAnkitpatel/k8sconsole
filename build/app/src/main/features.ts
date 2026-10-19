import { stringify } from 'yaml';
import type { ApiResourceInfo, ApplyResult, AppSettings, KubeObject, MonitorSnapshot, ResourceRef } from '../shared/types';
import { buildResourceGraph, collapsePods, hideIdleReplicaSets, neighborhood, nodeId, type ResourceGraph } from '../shared/graph';
import { runSecurityScan, type Finding, type SecurityReport } from '../shared/security';
import { effectiveRules, knownSubjects, permissionMatrix, whoCan, type Subject } from '../shared/rbac';
import { formatAge, summarizeNode, summarizePod, summarizeWorkload, cleanForEditing } from '../shared/format';
import { isValidName, resourcePath } from '../shared/resources';
import { validateManifest } from '../shared/validation';
import { graphInventory, rbacInventory, scanInventory } from './kube/inventory';
import { describeApiError, getResource, listResources } from './kube/resources';
import { readMetrics } from './kube/metrics';
import type { KubeRest } from './kube/rest';
import type { AssistantToolHost } from './assistant';

export interface FeatureSession {
  rest: KubeRest;
  discovery: ApiResourceInfo[];
  contextName: string;
  serverVersion?: string;
}

/** Resolves a user/model supplied kind (Kind, plural, singular or short name) against discovery. */
export function resolveKind(discovery: ApiResourceInfo[], kind: string): ApiResourceInfo | null {
  const k = kind.trim().toLowerCase();
  const preferred = (list: ApiResourceInfo[]) => list.find((d) => d.group === '' || d.group === 'apps' || d.group === 'batch') ?? list[0] ?? null;
  return (
    preferred(discovery.filter((d) => d.kind.toLowerCase() === k)) ??
    preferred(discovery.filter((d) => d.plural === k)) ??
    preferred(discovery.filter((d) => (d.shortNames ?? []).includes(k))) ??
    preferred(discovery.filter((d) => `${d.kind.toLowerCase()}s` === k))
  );
}

const SECRETISH = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

/** Removes secret material before an object leaves the app (assistant tool results). */
export function redactForAssistant(obj: KubeObject): KubeObject {
  const o = cleanForEditing(obj, true);
  if (o.kind === 'Secret') {
    for (const field of ['data', 'stringData'] as const) if (o[field]) o[field] = Object.fromEntries(Object.keys(o[field]).map((k) => [k, '<redacted>']));
    if (o.metadata.annotations) delete o.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
  }
  const scrubEnv = (spec: any) => {
    for (const c of [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]) for (const e of c.env ?? []) if (e.value !== undefined && SECRETISH.test(e.name)) e.value = '<redacted>';
  };
  scrubEnv(o.spec);
  scrubEnv(o.spec?.template?.spec);
  scrubEnv(o.spec?.jobTemplate?.spec?.template?.spec);
  return o;
}

function brief(o: KubeObject): Record<string, unknown> {
  const base: Record<string, unknown> = { name: o.metadata.name, namespace: o.metadata.namespace, age: formatAge(o.metadata.creationTimestamp) };
  switch (o.kind) {
    case 'Pod': {
      const s = summarizePod(o);
      return { ...base, status: s.status, ready: s.ready, restarts: s.restarts, node: o.spec?.nodeName };
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
    case 'DaemonSet':
      return { ...base, ready: summarizeWorkload(o).ready };
    case 'Node':
      return { ...base, status: summarizeNode(o).status };
    case 'Event':
      return { type: o.type, reason: o.reason, object: `${o.involvedObject?.kind}/${o.involvedObject?.name}`, message: o.message, count: o.count ?? 1, last: o.lastTimestamp ?? o.eventTime };
    default:
      return o.status?.phase ? { ...base, phase: o.status.phase } : base;
  }
}

export class FeatureService {
  constructor(
    private readonly s: () => FeatureSession,
    private readonly settings: () => AppSettings,
    private readonly monitor: () => MonitorSnapshot | null,
  ) {}

  async namespaceGraph(namespace: string | undefined): Promise<ResourceGraph & { notes: string[] }> {
    const { rest, discovery } = this.s();
    const { objects, notes } = await graphInventory(rest, discovery, namespace || undefined);
    return { ...collapsePods(hideIdleReplicaSets(buildResourceGraph(objects)), 8), notes };
  }

  async objectGraph(kind: string, namespace: string | undefined, name: string, depth = 2): Promise<ResourceGraph & { notes: string[] }> {
    const { rest, discovery } = this.s();
    const info = resolveKind(discovery, kind);
    const scope = info?.namespaced ? namespace : undefined;
    const { objects, notes } = await graphInventory(rest, discovery, scope);
    const graph = buildResourceGraph(objects);
    const root = nodeId(info?.kind ?? kind, scope, name);
    if (!graph.nodes.some((n) => n.id === root)) return { nodes: [], edges: [], notes: [...notes, `${kind} ${name} is not part of the relationship graph.`] };
    return { ...hideIdleReplicaSets(neighborhood(graph, root, Math.min(4, Math.max(1, depth)))), notes };
  }

  async scan(namespace: string | undefined): Promise<SecurityReport & { notes: string[] }> {
    const { rest, discovery } = this.s();
    const { input, notes } = await scanInventory(rest, discovery, namespace || undefined);
    return { ...runSecurityScan(input), notes };
  }

  /** Applies a finding's fix as a strategic merge patch (dry run first is up to the caller). */
  async fix(finding: Finding, dryRun: boolean): Promise<ApplyResult> {
    const { rest, discovery } = this.s();
    if (!finding?.fix?.patch) return { ok: false, dryRun, error: 'This finding has no automatic fix.' };
    const t = finding.target;
    const info = discovery.find((d) => d.apiVersion === t.apiVersion && d.kind === t.kind);
    if (!info) return { ok: false, dryRun, error: `${t.kind} is not served by this cluster.` };
    const ref: ResourceRef = { apiVersion: info.apiVersion, kind: info.kind, plural: info.plural, namespaced: info.namespaced };
    try {
      const object = await rest.request('PATCH', resourcePath(ref, info.namespaced ? t.namespace : undefined, t.name), {
        body: finding.fix.patch,
        contentType: 'application/strategic-merge-patch+json',
        query: { dryRun: dryRun ? 'All' : undefined, fieldManager: 'k8sconsole' },
      });
      return { ok: true, dryRun, object };
    } catch (err) {
      return { ok: false, dryRun, error: describeApiError(err) };
    }
  }

  async accessOverview() {
    const { rest, discovery } = this.s();
    const { data, notes } = await rbacInventory(rest, discovery);
    const resources = [...new Map(discovery.filter((d) => d.verbs.includes('get') || d.verbs.includes('list')).map((d) => [`${d.group}/${d.plural}`, { group: d.group, resource: d.plural, namespaced: d.namespaced }])).values()].sort(
      (a, b) => a.group.localeCompare(b.group) || a.resource.localeCompare(b.resource),
    );
    return { subjects: knownSubjects(data), resources, notes };
  }

  async permissions(subject: Subject, namespace: string | undefined) {
    const { rest, discovery } = this.s();
    if (!subject || !['User', 'Group', 'ServiceAccount'].includes(subject.kind) || typeof subject.name !== 'string') throw new Error('Invalid subject');
    const { data } = await rbacInventory(rest, discovery);
    const rules = effectiveRules(subject, data);
    const resources = [...new Map(discovery.map((d) => [`${d.group}/${d.plural}`, { group: d.group, resource: d.plural, namespaced: d.namespaced }])).values()].filter((r) => (namespace ? r.namespaced : true));
    return { rules, matrix: permissionMatrix(rules, resources, namespace || undefined).filter((m) => Object.values(m.verbs).some(Boolean)) };
  }

  async whoCan(verb: string, group: string, resource: string, namespace?: string, name?: string) {
    const { rest, discovery } = this.s();
    const { data } = await rbacInventory(rest, discovery);
    return whoCan(data, String(verb), String(group ?? ''), String(resource), namespace || undefined, name || undefined);
  }

  async selfRules(namespace?: string) {
    const { rest } = this.s();
    const ns = namespace && isValidName(namespace) ? namespace : 'default';
    const review = await rest.request('POST', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', { body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: ns } } });
    let user: string | undefined;
    let groups: string[] | undefined;
    try {
      const who = await rest.request('POST', '/apis/authentication.k8s.io/v1/selfsubjectreviews', { body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' } });
      user = who.status?.userInfo?.username;
      groups = who.status?.userInfo?.groups;
    } catch {
      // SelfSubjectReview needs Kubernetes 1.28+.
    }
    return { user, groups, rules: review.status?.resourceRules ?? [], incomplete: !!review.status?.incomplete };
  }

  async check(verb: string, group: string, resource: string, namespace?: string, name?: string) {
    const { rest } = this.s();
    const [res, sub] = String(resource).split('/');
    const review = await rest.request('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { verb, group, resource: res, subresource: sub, namespace: namespace || undefined, name: name || undefined } } },
    });
    return { allowed: !!review.status?.allowed, reason: review.status?.reason };
  }

  /** Read-only cluster access for the AI assistant. */
  assistantHost(onProposal: (summary: string, yaml: string) => void, selection: () => Record<string, unknown>): AssistantToolHost {
    return {
      context: async () => {
        const s = this.s();
        return { context: s.contextName, kubernetesVersion: s.serverVersion, ...selection() };
      },
      listResources: async (kind, namespace, labelSelector) => {
        const { rest, discovery } = this.s();
        const info = resolveKind(discovery, kind);
        if (!info) throw new Error(`Unknown kind "${kind}"`);
        const ref = { apiVersion: info.apiVersion, kind: info.kind, plural: info.plural, namespaced: info.namespaced };
        const { items } = await listResources(rest, { resource: ref, namespace: info.namespaced ? namespace : undefined, labelSelector });
        return { kind: info.kind, total: items.length, items: items.slice(0, 200).map(brief) };
      },
      getResource: async (kind, name, namespace) => {
        const { rest, discovery } = this.s();
        const info = resolveKind(discovery, kind);
        if (!info) throw new Error(`Unknown kind "${kind}"`);
        const obj = await getResource(rest, { apiVersion: info.apiVersion, kind: info.kind, plural: info.plural, namespaced: info.namespaced }, info.namespaced ? namespace : undefined, name);
        return stringify(redactForAssistant(obj), { lineWidth: 0 });
      },
      events: async (namespace, kind, name) => {
        const { rest } = this.s();
        const path = namespace && isValidName(namespace) ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events';
        const sel = [kind ? `involvedObject.kind=${kind}` : '', name ? `involvedObject.name=${name}` : ''].filter(Boolean).join(',');
        const list = await rest.get(path, { query: { fieldSelector: sel || undefined, limit: 500 } });
        const items = (list.items ?? []) as KubeObject[];
        items.sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? '') - Date.parse(a.lastTimestamp ?? a.eventTime ?? ''));
        return items.slice(0, 60).map((e) => brief({ ...e, kind: 'Event' }));
      },
      podLogs: async (namespace, pod, container, tail = 200, previous = false) => {
        if (!this.settings().assistantReadLogs) throw new Error('Reading pod logs is turned off in Settings → AI Assistant.');
        if (!isValidName(namespace) || !isValidName(pod)) throw new Error('Invalid namespace or pod');
        const { rest } = this.s();
        return rest.get(`/api/v1/namespaces/${namespace}/pods/${pod}/log`, { raw: true, query: { container, tailLines: tail, previous: previous || undefined, limitBytes: 200_000 } });
      },
      metrics: async () => {
        const snap = this.monitor();
        if (snap) {
          return {
            source: snap.source,
            cluster: { cpuMillis: snap.cluster.cpuUsageMillis, cpuAllocMillis: snap.cluster.cpuAllocMillis, memBytes: snap.cluster.memUsageBytes, memAllocBytes: snap.cluster.memAllocBytes },
            nodes: snap.nodes.map((n) => ({ name: n.name, cpuMillis: n.cpuUsageMillis, memBytes: n.memUsageBytes, ready: n.ready })),
            topPods: [...snap.pods].sort((a, b) => (b.cpuUsageMillis ?? 0) - (a.cpuUsageMillis ?? 0)).slice(0, 15).map((p) => ({ pod: `${p.namespace}/${p.name}`, cpuMillis: p.cpuUsageMillis, memBytes: p.memUsageBytes, restarts: p.restarts })),
          };
        }
        const m = await readMetrics(this.s().rest);
        return m.available ? { nodes: m.nodes, topPods: Object.entries(m.pods).sort((a, b) => b[1].cpuMillis - a[1].cpuMillis).slice(0, 15) } : { error: m.error };
      },
      securitySummary: async (namespace) => {
        const r = await this.scan(namespace);
        return { score: r.score, counts: r.counts, findings: r.findings.slice(0, 25).map((f) => ({ severity: f.severity, title: f.title, target: `${f.target.kind}/${f.target.namespace ? f.target.namespace + '/' : ''}${f.target.name}`, remediation: f.remediation })) };
      },
      proposeChange: async (summary, yaml) => {
        const v = validateManifest(yaml);
        if (!v.ok) return { ok: false, issues: v.issues.filter((i) => i.severity === 'error').map((i) => i.message) };
        onProposal(summary, yaml);
        return { ok: true, issues: [] };
      },
    };
  }
}
