import { summarizePod, summarizeWorkload } from './format';
import type { KubeObject } from './types';

export type NodeStatus = 'ok' | 'warn' | 'error' | 'pending' | 'done' | 'unknown';
export type EdgeType = 'owns' | 'selects' | 'routes' | 'mounts' | 'binds' | 'uses' | 'runs-on' | 'scales' | 'guards';

export interface GraphNode {
  id: string;
  kind: string;
  apiVersion: string;
  name: string;
  namespace?: string;
  status: NodeStatus;
  detail?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface ResourceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Set when the graph was cut to stay readable. */
  truncated?: number;
}

/** Column (left → right) used by the layered layout: traffic → services → workloads → pods → config/storage → infrastructure. */
export const KIND_RANK: Record<string, number> = {
  Ingress: 0,
  HTTPRoute: 0,
  Gateway: 0,
  Service: 1,
  NetworkPolicy: 1,
  HorizontalPodAutoscaler: 2,
  Deployment: 2,
  StatefulSet: 2,
  DaemonSet: 2,
  CronJob: 2,
  ReplicaSet: 3,
  Job: 3,
  Pod: 4,
  ConfigMap: 5,
  Secret: 5,
  PersistentVolumeClaim: 5,
  ServiceAccount: 5,
  PersistentVolume: 6,
  Node: 6,
  // Amazon ECS
  LoadBalancer: 0,
  TargetGroup: 1,
  SecurityGroup: 1,
  EcsService: 2,
  Task: 4,
  TaskDefinition: 5,
};

export const nodeId = (kind: string, namespace: string | undefined, name: string) => `${kind}/${namespace ?? ''}/${name}`;

function matches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([k, v]) => labels?.[k] === v);
}

/** Evaluates a LabelSelector (matchLabels + matchExpressions). An empty selector matches everything. */
export function selectorMatches(sel: any, labels: Record<string, string> = {}): boolean {
  if (!sel) return false;
  const ml: Record<string, string> = sel.matchLabels ?? {};
  if (!Object.entries(ml).every(([k, v]) => labels[k] === v)) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    const val = labels[e.key];
    if (e.operator === 'In' && !(has && (e.values ?? []).includes(val))) return false;
    if (e.operator === 'NotIn' && has && (e.values ?? []).includes(val)) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

function statusOf(o: KubeObject): { status: NodeStatus; detail?: string } {
  switch (o.kind) {
    case 'Pod': {
      const s = summarizePod(o);
      return { status: s.severity === 'done' ? 'done' : s.severity, detail: s.status };
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
    case 'DaemonSet': {
      const s = summarizeWorkload(o);
      return { status: s.severity, detail: s.ready };
    }
    case 'Job': {
      const c = (o.status?.conditions ?? []).find((x: any) => x.status === 'True');
      return c?.type === 'Failed' ? { status: 'error', detail: 'Failed' } : c?.type === 'Complete' ? { status: 'done', detail: 'Complete' } : { status: 'pending', detail: 'Running' };
    }
    case 'PersistentVolumeClaim':
      return { status: o.status?.phase === 'Bound' ? 'ok' : 'pending', detail: o.status?.phase };
    case 'Node': {
      const ready = (o.status?.conditions ?? []).find((c: any) => c.type === 'Ready')?.status === 'True';
      return { status: ready ? (o.spec?.unschedulable ? 'warn' : 'ok') : 'error', detail: ready ? 'Ready' : 'NotReady' };
    }
    case 'Service':
      return { status: 'ok', detail: o.spec?.type };
    default:
      return { status: 'ok' };
  }
}

/** Pod-level references: ConfigMaps, Secrets and PVCs used through volumes, envFrom and env valueFrom. */
export function podReferences(spec: any): { configMaps: Set<string>; secrets: Set<string>; pvcs: Set<string> } {
  const out = { configMaps: new Set<string>(), secrets: new Set<string>(), pvcs: new Set<string>() };
  for (const v of spec?.volumes ?? []) {
    if (v.configMap?.name) out.configMaps.add(v.configMap.name);
    if (v.secret?.secretName) out.secrets.add(v.secret.secretName);
    if (v.persistentVolumeClaim?.claimName) out.pvcs.add(v.persistentVolumeClaim.claimName);
    for (const s of v.projected?.sources ?? []) {
      if (s.configMap?.name) out.configMaps.add(s.configMap.name);
      if (s.secret?.name) out.secrets.add(s.secret.name);
    }
  }
  for (const c of [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]) {
    for (const ef of c.envFrom ?? []) {
      if (ef.configMapRef?.name) out.configMaps.add(ef.configMapRef.name);
      if (ef.secretRef?.name) out.secrets.add(ef.secretRef.name);
    }
    for (const e of c.env ?? []) {
      if (e.valueFrom?.configMapKeyRef?.name) out.configMaps.add(e.valueFrom.configMapKeyRef.name);
      if (e.valueFrom?.secretKeyRef?.name) out.secrets.add(e.valueFrom.secretKeyRef.name);
    }
  }
  for (const s of spec?.imagePullSecrets ?? []) if (s.name) out.secrets.add(s.name);
  return out;
}

/** Builds the relationship graph for a set of objects (one namespace plus related cluster-scoped objects). */
export function buildResourceGraph(objects: KubeObject[]): ResourceGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const byUid = new Map<string, string>();
  const add = (o: KubeObject) => {
    const id = nodeId(o.kind!, o.metadata.namespace, o.metadata.name);
    if (!nodes.has(id)) nodes.set(id, { id, kind: o.kind!, apiVersion: o.apiVersion ?? 'v1', name: o.metadata.name, namespace: o.metadata.namespace, ...statusOf(o) });
    if (o.metadata.uid) byUid.set(o.metadata.uid, id);
    return id;
  };
  const edge = (from: string, to: string, type: EdgeType) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const k = `${from}|${to}|${type}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to, type });
  };
  for (const o of objects) add(o);
  const find = (kind: string, ns: string | undefined, name: string) => {
    const id = nodeId(kind, ns, name);
    return nodes.has(id) ? id : null;
  };
  const pods = objects.filter((o) => o.kind === 'Pod');

  for (const o of objects) {
    const id = nodeId(o.kind!, o.metadata.namespace, o.metadata.name);
    const ns = o.metadata.namespace;
    for (const ref of o.metadata.ownerReferences ?? []) {
      // Kind+name identifies the owner; the UID map covers owners whose kind is unknown here.
      const owner = find(ref.kind, ns, ref.name) ?? (ref.uid ? byUid.get(ref.uid) : undefined);
      if (owner) edge(owner, id, 'owns');
    }
    switch (o.kind) {
      case 'Service':
        for (const p of pods) if (p.metadata.namespace === ns && matches(o.spec?.selector, p.metadata.labels)) edge(id, nodeId('Pod', ns, p.metadata.name), 'selects');
        break;
      case 'Ingress': {
        const svcs = new Set<string>();
        if (o.spec?.defaultBackend?.service?.name) svcs.add(o.spec.defaultBackend.service.name);
        for (const r of o.spec?.rules ?? []) for (const p of r.http?.paths ?? []) if (p.backend?.service?.name) svcs.add(p.backend.service.name);
        for (const s of svcs) {
          const t = find('Service', ns, s);
          if (t) edge(id, t, 'routes');
        }
        break;
      }
      case 'HTTPRoute':
        for (const r of o.spec?.rules ?? [])
          for (const b of r.backendRefs ?? []) {
            const t = (!b.kind || b.kind === 'Service') && find('Service', b.namespace ?? ns, b.name);
            if (t) edge(id, t, 'routes');
          }
        break;
      case 'Pod': {
        const refs = podReferences(o.spec);
        for (const c of refs.configMaps) {
          const t = find('ConfigMap', ns, c);
          if (t) edge(id, t, 'mounts');
        }
        for (const s of refs.secrets) {
          const t = find('Secret', ns, s);
          if (t) edge(id, t, 'mounts');
        }
        for (const c of refs.pvcs) {
          const t = find('PersistentVolumeClaim', ns, c);
          if (t) edge(id, t, 'mounts');
        }
        const sa = find('ServiceAccount', ns, o.spec?.serviceAccountName ?? 'default');
        if (sa) edge(id, sa, 'uses');
        if (o.spec?.nodeName) {
          const n = find('Node', undefined, o.spec.nodeName);
          if (n) edge(id, n, 'runs-on');
        }
        break;
      }
      case 'PersistentVolumeClaim':
        if (o.spec?.volumeName) {
          const pv = find('PersistentVolume', undefined, o.spec.volumeName);
          if (pv) edge(id, pv, 'binds');
        }
        break;
      case 'HorizontalPodAutoscaler': {
        const t = o.spec?.scaleTargetRef && find(o.spec.scaleTargetRef.kind, ns, o.spec.scaleTargetRef.name);
        if (t) edge(id, t, 'scales');
        break;
      }
      case 'NetworkPolicy':
        for (const p of pods) if (p.metadata.namespace === ns && selectorMatches(o.spec?.podSelector ?? {}, p.metadata.labels)) edge(id, nodeId('Pod', ns, p.metadata.name), 'guards');
        break;
    }
  }
  return { nodes: [...nodes.values()], edges };
}

/** Sub-graph within `depth` hops of `rootId`, following edges in both directions. */
export function neighborhood(g: ResourceGraph, rootId: string, depth = 2, maxNodes = 120): ResourceGraph {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const keep = new Set<string>([rootId]);
  let frontier = [rootId];
  let truncated = 0;
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const n of adj.get(id) ?? []) {
        if (keep.has(n)) continue;
        // Nodes are infrastructure hubs; don't expand through them or the whole cluster comes back.
        if (keep.size >= maxNodes) {
          truncated++;
          continue;
        }
        keep.add(n);
        if (!n.startsWith('Node/')) next.push(n);
      }
    frontier = next;
  }
  return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)), truncated: truncated || undefined };
}

/** Collapses large pod sets: keeps up to `perOwner` pods per owner and replaces the rest by a summary node. */
export function collapsePods(g: ResourceGraph, perOwner = 6): ResourceGraph {
  const owners = new Map<string, string[]>();
  for (const e of g.edges) if (e.type === 'owns' && e.to.startsWith('Pod/')) (owners.get(e.from) ?? owners.set(e.from, []).get(e.from)!).push(e.to);
  const drop = new Set<string>();
  const extra: GraphNode[] = [];
  const extraEdges: GraphEdge[] = [];
  for (const [owner, pods] of owners) {
    if (pods.length <= perOwner) continue;
    const hidden = pods.slice(perOwner);
    hidden.forEach((p) => drop.add(p));
    const ownerNode = g.nodes.find((n) => n.id === owner)!;
    const id = `More/${ownerNode.namespace ?? ''}/${ownerNode.name}`;
    const statuses = g.nodes.filter((n) => hidden.includes(n.id)).map((n) => n.status);
    extra.push({ id, kind: 'Pod', apiVersion: 'v1', name: `+${hidden.length} more pods`, namespace: ownerNode.namespace, status: statuses.includes('error') ? 'error' : statuses.includes('warn') ? 'warn' : 'ok' });
    extraEdges.push({ from: owner, to: id, type: 'owns' });
  }
  if (!drop.size) return g;
  return {
    nodes: [...g.nodes.filter((n) => !drop.has(n.id)), ...extra],
    edges: [...g.edges.filter((e) => !drop.has(e.from) && !drop.has(e.to)), ...extraEdges],
    truncated: (g.truncated ?? 0) + drop.size,
  };
}

/** Drops ReplicaSets kept only as rollout history (scaled to zero, no pods). */
export function hideIdleReplicaSets(g: ResourceGraph): ResourceGraph {
  const owning = new Set(g.edges.filter((e) => e.type === 'owns' && (e.to.startsWith('Pod/') || e.to.startsWith('More/'))).map((e) => e.from));
  const idle = new Set(g.nodes.filter((n) => n.kind === 'ReplicaSet' && n.detail === '0/0' && !owning.has(n.id)).map((n) => n.id));
  if (!idle.size) return g;
  return { nodes: g.nodes.filter((n) => !idle.has(n.id)), edges: g.edges.filter((e) => !idle.has(e.from) && !idle.has(e.to)), truncated: g.truncated };
}
