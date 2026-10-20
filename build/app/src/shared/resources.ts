import type { ResourceRef } from './types';

export type NavGroup = 'Workloads' | 'Network' | 'Storage' | 'Config' | 'Access Control' | 'Cluster';

export interface CatalogEntry extends ResourceRef {
  group: NavGroup;
  /** Label shown in the navigation. */
  title: string;
}

const e = (group: NavGroup, title: string, apiVersion: string, kind: string, plural: string, namespaced: boolean): CatalogEntry => ({
  group,
  title,
  apiVersion,
  kind,
  plural,
  namespaced,
});

/** Built-in resource kinds shown in the navigation. Availability is confirmed against API discovery at runtime. */
export const RESOURCE_CATALOG: CatalogEntry[] = [
  e('Workloads', 'Pods', 'v1', 'Pod', 'pods', true),
  e('Workloads', 'Deployments', 'apps/v1', 'Deployment', 'deployments', true),
  e('Workloads', 'StatefulSets', 'apps/v1', 'StatefulSet', 'statefulsets', true),
  e('Workloads', 'DaemonSets', 'apps/v1', 'DaemonSet', 'daemonsets', true),
  e('Workloads', 'ReplicaSets', 'apps/v1', 'ReplicaSet', 'replicasets', true),
  e('Workloads', 'Jobs', 'batch/v1', 'Job', 'jobs', true),
  e('Workloads', 'CronJobs', 'batch/v1', 'CronJob', 'cronjobs', true),
  e('Workloads', 'HPAs', 'autoscaling/v2', 'HorizontalPodAutoscaler', 'horizontalpodautoscalers', true),
  e('Workloads', 'Pod Disruption Budgets', 'policy/v1', 'PodDisruptionBudget', 'poddisruptionbudgets', true),
  e('Network', 'Services', 'v1', 'Service', 'services', true),
  e('Network', 'Endpoints', 'v1', 'Endpoints', 'endpoints', true),
  e('Network', 'EndpointSlices', 'discovery.k8s.io/v1', 'EndpointSlice', 'endpointslices', true),
  e('Network', 'Ingresses', 'networking.k8s.io/v1', 'Ingress', 'ingresses', true),
  e('Network', 'Ingress Classes', 'networking.k8s.io/v1', 'IngressClass', 'ingressclasses', false),
  e('Network', 'Network Policies', 'networking.k8s.io/v1', 'NetworkPolicy', 'networkpolicies', true),
  e('Network', 'Gateways', 'gateway.networking.k8s.io/v1', 'Gateway', 'gateways', true),
  e('Network', 'HTTPRoutes', 'gateway.networking.k8s.io/v1', 'HTTPRoute', 'httproutes', true),
  e('Storage', 'Persistent Volume Claims', 'v1', 'PersistentVolumeClaim', 'persistentvolumeclaims', true),
  e('Storage', 'Persistent Volumes', 'v1', 'PersistentVolume', 'persistentvolumes', false),
  e('Storage', 'Storage Classes', 'storage.k8s.io/v1', 'StorageClass', 'storageclasses', false),
  e('Config', 'ConfigMaps', 'v1', 'ConfigMap', 'configmaps', true),
  e('Config', 'Secrets', 'v1', 'Secret', 'secrets', true),
  e('Config', 'Resource Quotas', 'v1', 'ResourceQuota', 'resourcequotas', true),
  e('Config', 'Limit Ranges', 'v1', 'LimitRange', 'limitranges', true),
  e('Config', 'Leases', 'coordination.k8s.io/v1', 'Lease', 'leases', true),
  e('Config', 'Priority Classes', 'scheduling.k8s.io/v1', 'PriorityClass', 'priorityclasses', false),
  e('Config', 'Runtime Classes', 'node.k8s.io/v1', 'RuntimeClass', 'runtimeclasses', false),
  e('Config', 'Mutating Webhooks', 'admissionregistration.k8s.io/v1', 'MutatingWebhookConfiguration', 'mutatingwebhookconfigurations', false),
  e('Config', 'Validating Webhooks', 'admissionregistration.k8s.io/v1', 'ValidatingWebhookConfiguration', 'validatingwebhookconfigurations', false),
  e('Access Control', 'Service Accounts', 'v1', 'ServiceAccount', 'serviceaccounts', true),
  e('Access Control', 'Roles', 'rbac.authorization.k8s.io/v1', 'Role', 'roles', true),
  e('Access Control', 'Role Bindings', 'rbac.authorization.k8s.io/v1', 'RoleBinding', 'rolebindings', true),
  e('Access Control', 'Cluster Roles', 'rbac.authorization.k8s.io/v1', 'ClusterRole', 'clusterroles', false),
  e('Access Control', 'Cluster Role Bindings', 'rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', 'clusterrolebindings', false),
  e('Cluster', 'Nodes', 'v1', 'Node', 'nodes', false),
  e('Cluster', 'Namespaces', 'v1', 'Namespace', 'namespaces', false),
  e('Cluster', 'Events', 'v1', 'Event', 'events', true),
  e('Cluster', 'Custom Resource Definitions', 'apiextensions.k8s.io/v1', 'CustomResourceDefinition', 'customresourcedefinitions', false),
];

export const NAV_GROUPS: NavGroup[] = ['Workloads', 'Network', 'Storage', 'Config', 'Access Control', 'Cluster'];

export function findCatalogEntry(kind: string): CatalogEntry | undefined {
  return RESOURCE_CATALOG.find((c) => c.kind === kind);
}

/** Splits `group/version` into its parts; the core group is ''. */
export function splitApiVersion(apiVersion: string): { group: string; version: string } {
  const idx = apiVersion.indexOf('/');
  return idx === -1 ? { group: '', version: apiVersion } : { group: apiVersion.slice(0, idx), version: apiVersion.slice(idx + 1) };
}

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const PLURAL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const API_VERSION = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?v[0-9]+((alpha|beta)[0-9]+)?$/;

export function isValidName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 253 && DNS_SUBDOMAIN.test(name);
}

/**
 * Builds the REST path for a resource collection or a single object.
 * Every segment is validated so values coming from the renderer cannot traverse to other API paths.
 */
export function resourcePath(ref: Pick<ResourceRef, 'apiVersion' | 'plural' | 'namespaced'>, namespace?: string, name?: string, subresource?: string): string {
  if (!API_VERSION.test(ref.apiVersion)) throw new Error(`Invalid apiVersion: ${ref.apiVersion}`);
  if (!PLURAL.test(ref.plural)) throw new Error(`Invalid resource: ${ref.plural}`);
  const { group } = splitApiVersion(ref.apiVersion);
  let p = group ? `/apis/${ref.apiVersion}` : `/api/${ref.apiVersion}`;
  if (ref.namespaced && namespace) {
    if (!isValidName(namespace)) throw new Error(`Invalid namespace: ${namespace}`);
    p += `/namespaces/${namespace}`;
  }
  p += `/${ref.plural}`;
  if (name !== undefined) {
    // "." and ".." would address the parent path instead of an object (Kubernetes forbids them as path segment names too).
    if (name === '.' || name === '..' || (!isValidName(name) && !/^[a-zA-Z0-9:._-]+$/.test(name))) throw new Error(`Invalid name: ${name}`);
    p += `/${encodeURIComponent(name)}`;
  }
  if (subresource !== undefined) {
    if (!/^(status|scale|log|eviction|exec|portforward|proxy)$/.test(subresource)) throw new Error(`Invalid subresource: ${subresource}`);
    p += `/${subresource}`;
  }
  return p;
}
