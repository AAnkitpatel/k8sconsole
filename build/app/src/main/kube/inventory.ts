import type { ApiResourceInfo, KubeObject, ResourceRef } from '../../shared/types';
import type { RbacData } from '../../shared/rbac';
import type { ScanInput } from '../../shared/security';
import { listResources } from './resources';
import { KubeApiError, type KubeRest } from './rest';

/** Kinds (by preferred group) that make up the relationship graph of a namespace. */
const GRAPH_KINDS: Array<[string, string]> = [
  ['networking.k8s.io', 'Ingress'],
  ['gateway.networking.k8s.io', 'HTTPRoute'],
  ['', 'Service'],
  ['networking.k8s.io', 'NetworkPolicy'],
  ['autoscaling', 'HorizontalPodAutoscaler'],
  ['apps', 'Deployment'],
  ['apps', 'StatefulSet'],
  ['apps', 'DaemonSet'],
  ['batch', 'CronJob'],
  ['apps', 'ReplicaSet'],
  ['batch', 'Job'],
  ['', 'Pod'],
  ['', 'ConfigMap'],
  ['', 'Secret'],
  ['', 'PersistentVolumeClaim'],
  ['', 'ServiceAccount'],
];

export function refFor(discovery: ApiResourceInfo[], group: string, kind: string): ResourceRef | null {
  const d = discovery.find((x) => x.group === group && x.kind === kind && x.verbs.includes('list'));
  return d ? { apiVersion: d.apiVersion, kind: d.kind, plural: d.plural, namespaced: d.namespaced } : null;
}

/** Lists one kind; missing permissions or kinds yield an empty list and a note instead of failing. */
async function safeList(rest: KubeRest, ref: ResourceRef | null, namespace: string | undefined, notes: string[]): Promise<KubeObject[]> {
  if (!ref) return [];
  try {
    const items = (await listResources(rest, { resource: ref, namespace: ref.namespaced ? namespace : undefined })).items;
    // Secrets are only needed as graph nodes: drop their data immediately.
    if (ref.kind === 'Secret') return items.map((s) => ({ apiVersion: s.apiVersion, kind: s.kind, metadata: { ...s.metadata, managedFields: undefined }, type: s.type }));
    return items;
  } catch (err) {
    if (err instanceof KubeApiError && (err.code === 403 || err.code === 404)) {
      notes.push(`${ref.kind}: ${err.code === 403 ? 'not permitted' : 'not available'}`);
      return [];
    }
    throw err;
  }
}

export async function graphInventory(rest: KubeRest, discovery: ApiResourceInfo[], namespace: string | undefined): Promise<{ objects: KubeObject[]; notes: string[] }> {
  const notes: string[] = [];
  const lists = await Promise.all(GRAPH_KINDS.map(([g, k]) => safeList(rest, refFor(discovery, g, k), namespace, notes)));
  const objects = lists.flat();
  // Cluster-scoped objects referenced from the namespace: nodes running its pods and bound PVs.
  const nodeNames = new Set(objects.filter((o) => o.kind === 'Pod' && o.spec?.nodeName).map((o) => o.spec.nodeName as string));
  const pvNames = new Set(objects.filter((o) => o.kind === 'PersistentVolumeClaim' && o.spec?.volumeName).map((o) => o.spec.volumeName as string));
  const [nodes, pvs] = await Promise.all([
    nodeNames.size ? safeList(rest, refFor(discovery, '', 'Node'), undefined, notes) : Promise.resolve([]),
    pvNames.size ? safeList(rest, refFor(discovery, '', 'PersistentVolume'), undefined, notes) : Promise.resolve([]),
  ]);
  objects.push(...nodes.filter((n) => nodeNames.has(n.metadata.name)), ...pvs.filter((p) => pvNames.has(p.metadata.name)));
  return { objects, notes };
}

export async function rbacInventory(rest: KubeRest, discovery: ApiResourceInfo[]): Promise<{ data: RbacData; notes: string[] }> {
  const notes: string[] = [];
  const g = 'rbac.authorization.k8s.io';
  const [roles, clusterRoles, roleBindings, clusterRoleBindings] = await Promise.all([
    safeList(rest, refFor(discovery, g, 'Role'), undefined, notes),
    safeList(rest, refFor(discovery, g, 'ClusterRole'), undefined, notes),
    safeList(rest, refFor(discovery, g, 'RoleBinding'), undefined, notes),
    safeList(rest, refFor(discovery, g, 'ClusterRoleBinding'), undefined, notes),
  ]);
  return { data: { roles, clusterRoles, roleBindings, clusterRoleBindings }, notes };
}

export async function scanInventory(rest: KubeRest, discovery: ApiResourceInfo[], namespace: string | undefined): Promise<{ input: ScanInput; notes: string[] }> {
  const notes: string[] = [];
  const workloadKinds: Array<[string, string]> = [
    ['apps', 'Deployment'],
    ['apps', 'StatefulSet'],
    ['apps', 'DaemonSet'],
    ['batch', 'CronJob'],
    ['batch', 'Job'],
    ['apps', 'ReplicaSet'],
    ['', 'Pod'],
  ];
  const [workloads, rbac, namespaces, networkPolicies, services] = await Promise.all([
    Promise.all(workloadKinds.map(([g, k]) => safeList(rest, refFor(discovery, g, k), namespace, notes))).then((l) => l.flat()),
    rbacInventory(rest, discovery),
    safeList(rest, refFor(discovery, '', 'Namespace'), undefined, notes),
    safeList(rest, refFor(discovery, 'networking.k8s.io', 'NetworkPolicy'), namespace, notes),
    safeList(rest, refFor(discovery, '', 'Service'), namespace, notes),
  ]);
  notes.push(...rbac.notes);
  const inNs = <T extends KubeObject>(l: T[]) => (namespace ? l.filter((o) => !o.metadata.namespace || o.metadata.namespace === namespace) : l);
  return {
    input: {
      workloads,
      roles: [...inNs(rbac.data.roles), ...rbac.data.clusterRoles],
      bindings: [...inNs(rbac.data.roleBindings), ...rbac.data.clusterRoleBindings],
      namespaces: namespace ? namespaces.filter((n) => n.metadata.name === namespace) : namespaces,
      networkPolicies,
      services,
    },
    notes,
  };
}
