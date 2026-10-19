import { stringify } from 'yaml';
import { resourcePath, isValidName, splitApiVersion } from '../../shared/resources';
import { cleanForEditing } from '../../shared/format';
import { validateManifest } from '../../shared/validation';
import type { ApiResourceInfo, ApplyResult, KubeObject, ListRequest, ResourceRef } from '../../shared/types';
import { KubeApiError, type KubeRest } from './rest';

export const FIELD_MANAGER = 'k8sconsole';

/** Discovers every served resource (preferred group versions), ignoring groups that fail to answer. */
export async function discoverResources(rest: KubeRest): Promise<ApiResourceInfo[]> {
  const out: ApiResourceInfo[] = [];
  const addList = (apiVersion: string, list: any) => {
    const { group, version } = splitApiVersion(apiVersion);
    for (const r of list?.resources ?? []) {
      if (typeof r.name !== 'string' || r.name.includes('/')) continue;
      out.push({ group, version, apiVersion, kind: r.kind, plural: r.name, namespaced: !!r.namespaced, verbs: r.verbs ?? [], shortNames: r.shortNames });
    }
  };
  const core = await rest.get('/api');
  for (const v of core.versions ?? []) addList(v, await rest.get(`/api/${v}`));
  const groups = await rest.get('/apis');
  await Promise.all(
    (groups.groups ?? []).map(async (g: any) => {
      const gv = g.preferredVersion?.groupVersion ?? g.versions?.[0]?.groupVersion;
      if (!gv) return;
      try {
        addList(gv, await rest.get(`/apis/${gv}`, { timeoutMs: 10000 }));
      } catch {
        // Aggregated APIs (e.g. metrics) may be unavailable; skip them.
      }
    }),
  );
  return out;
}

function withTypeMeta(items: KubeObject[], ref: ResourceRef): KubeObject[] {
  return items.map((i) => ({ apiVersion: ref.apiVersion, kind: ref.kind, ...i }));
}

export async function listResources(rest: KubeRest, req: ListRequest): Promise<{ items: KubeObject[]; resourceVersion: string }> {
  const items: KubeObject[] = [];
  let cont: string | undefined;
  let resourceVersion = '';
  do {
    const list = await rest.get(resourcePath(req.resource, req.namespace || undefined), {
      query: { limit: 500, continue: cont, labelSelector: req.labelSelector, fieldSelector: req.fieldSelector },
      timeoutMs: 60000,
    });
    items.push(...withTypeMeta(list.items ?? [], req.resource));
    cont = list.metadata?.continue || undefined;
    resourceVersion = list.metadata?.resourceVersion ?? '';
  } while (cont);
  return { items, resourceVersion };
}

export async function getResource(rest: KubeRest, ref: ResourceRef, namespace: string | undefined, name: string): Promise<KubeObject> {
  const obj = await rest.get(resourcePath(ref, namespace, name));
  return { apiVersion: ref.apiVersion, kind: ref.kind, ...obj };
}

export async function getResourceYaml(rest: KubeRest, ref: ResourceRef, namespace: string | undefined, name: string, hideManagedFields: boolean): Promise<string> {
  const obj = await getResource(rest, ref, namespace, name);
  return stringify(cleanForEditing(obj, hideManagedFields), { lineWidth: 0 });
}

export async function deleteResource(rest: KubeRest, ref: ResourceRef, namespace: string | undefined, name: string): Promise<void> {
  await rest.request('DELETE', resourcePath(ref, namespace, name), { body: { kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Background' } });
}

export async function eventsForObject(rest: KubeRest, namespace: string | undefined, uid: string): Promise<KubeObject[]> {
  if (!/^[a-f0-9-]{1,64}$/i.test(uid)) throw new Error('Invalid uid');
  const path = namespace ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events';
  if (namespace && !isValidName(namespace)) throw new Error('Invalid namespace');
  const list = await rest.get(path, { query: { fieldSelector: `involvedObject.uid=${uid}` } });
  return (list.items ?? []).map((e: any) => ({ apiVersion: 'v1', kind: 'Event', ...e }));
}

function describeApiError(err: unknown): string {
  if (err instanceof KubeApiError) {
    if (err.code === 409) return `Conflict: ${err.message}. The object changed on the server; reload it and re-apply your edits.`;
    if (err.code === 403) return `Forbidden: ${err.message}`;
    if (err.code === 422) return `Invalid: ${err.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Applies YAML: `replace` updates one existing object (optimistic concurrency via resourceVersion);
 * `create` creates every document. `dryRun` validates server-side without persisting.
 */
export async function applyYaml(
  rest: KubeRest,
  discovery: ApiResourceInfo[],
  yamlText: string,
  opts: { dryRun: boolean; mode: 'replace' | 'create' | 'apply'; defaultNamespace: string; original?: { ref: ResourceRef; namespace?: string; name: string } },
): Promise<ApplyResult[]> {
  const expected = opts.mode === 'replace' && opts.original ? { kind: opts.original.ref.kind, name: opts.original.name, namespace: opts.original.namespace } : undefined;
  const v = validateManifest(yamlText, expected);
  if (!v.ok) return [{ ok: false, dryRun: opts.dryRun, error: v.issues.filter((i) => i.severity === 'error').map((i) => (i.line ? `line ${i.line}: ` : '') + i.message).join('\n') }];
  const query = { dryRun: opts.dryRun ? 'All' : undefined, fieldManager: FIELD_MANAGER, fieldValidation: 'Strict' };
  const results: ApplyResult[] = [];
  for (const obj of v.objects) {
    const info = discovery.find((d) => d.apiVersion === obj.apiVersion && d.kind === obj.kind);
    if (!info) {
      results.push({ ok: false, dryRun: opts.dryRun, error: `The server does not serve ${obj.kind} in ${obj.apiVersion}.` });
      continue;
    }
    const ns = info.namespaced ? obj.metadata.namespace || opts.original?.namespace || opts.defaultNamespace || 'default' : undefined;
    if (info.namespaced) obj.metadata.namespace = ns;
    try {
      let saved: KubeObject;
      if (opts.mode === 'replace') {
        saved = await rest.request('PUT', resourcePath(info, ns, obj.metadata.name), { body: obj, query });
      } else if (opts.mode === 'apply') {
        // Server-side apply: create-or-update, with field ownership conflicts reported by the API server.
        if (!obj.metadata.name) throw new Error('metadata.name is required for apply');
        const { resourceVersion: _rv, managedFields: _mf, uid: _uid, creationTimestamp: _ct, ...meta } = obj.metadata;
        void _rv;
        void _mf;
        void _uid;
        void _ct;
        saved = await rest.request('PATCH', resourcePath(info, ns, obj.metadata.name), { body: { ...obj, metadata: meta }, contentType: 'application/apply-patch+yaml', query });
      } else {
        saved = await rest.request('POST', resourcePath(info, ns), { body: obj, query });
      }
      results.push({ ok: true, dryRun: opts.dryRun, object: saved });
    } catch (err) {
      results.push({ ok: false, dryRun: opts.dryRun, error: `${obj.kind}/${obj.metadata.name ?? ''}: ${describeApiError(err)}` });
    }
  }
  return results;
}

const MERGE = 'application/merge-patch+json';
const SCALABLE = new Set(['Deployment', 'StatefulSet', 'ReplicaSet']);
const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

export async function scaleWorkload(rest: KubeRest, ref: ResourceRef, namespace: string, name: string, replicas: number): Promise<void> {
  if (!SCALABLE.has(ref.kind)) throw new Error(`${ref.kind} cannot be scaled`);
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > 10000) throw new Error('Invalid replica count');
  await rest.request('PATCH', resourcePath(ref, namespace, name, 'scale'), { body: { spec: { replicas } }, contentType: MERGE, query: { fieldManager: FIELD_MANAGER } });
}

/** Rolling restart, equivalent to `kubectl rollout restart`. */
export async function restartWorkload(rest: KubeRest, ref: ResourceRef, namespace: string, name: string, now = new Date()): Promise<void> {
  if (!RESTARTABLE.has(ref.kind)) throw new Error(`${ref.kind} cannot be restarted`);
  const body = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now.toISOString() } } } } };
  await rest.request('PATCH', resourcePath(ref, namespace, name), { body, contentType: MERGE, query: { fieldManager: FIELD_MANAGER } });
}

const NODE_REF: ResourceRef = { apiVersion: 'v1', kind: 'Node', plural: 'nodes', namespaced: false };
const POD_REF: ResourceRef = { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };

export async function cordonNode(rest: KubeRest, node: string, unschedulable: boolean): Promise<void> {
  await rest.request('PATCH', resourcePath(NODE_REF, undefined, node), { body: { spec: { unschedulable } }, contentType: MERGE });
}

export async function evictPod(rest: KubeRest, namespace: string, pod: string): Promise<void> {
  await rest.request('POST', resourcePath(POD_REF, namespace, pod, 'eviction'), {
    body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod, namespace } },
  });
}

/** Cordons the node and evicts its pods, skipping DaemonSet-managed, mirror and finished pods (like `kubectl drain --ignore-daemonsets`). */
export async function drainNode(rest: KubeRest, node: string): Promise<{ evicted: string[]; skipped: string[]; failed: string[] }> {
  if (!isValidName(node)) throw new Error('Invalid node name');
  await cordonNode(rest, node, true);
  const { items } = await listResources(rest, { resource: POD_REF, fieldSelector: `spec.nodeName=${node}` });
  const evicted: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const pod of items) {
    const id = `${pod.metadata.namespace}/${pod.metadata.name}`;
    const isDaemon = (pod.metadata.ownerReferences ?? []).some((o) => o.kind === 'DaemonSet');
    const isMirror = !!pod.metadata.annotations?.['kubernetes.io/config.mirror'];
    const finished = pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed';
    if (isDaemon || isMirror || finished) {
      skipped.push(id);
      continue;
    }
    try {
      await evictPod(rest, pod.metadata.namespace!, pod.metadata.name);
      evicted.push(id);
    } catch (err) {
      failed.push(`${id}: ${describeApiError(err)}`);
    }
  }
  return { evicted, skipped, failed };
}

const CRONJOB_REF: ResourceRef = { apiVersion: 'batch/v1', kind: 'CronJob', plural: 'cronjobs', namespaced: true };
const JOB_REF: ResourceRef = { apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaced: true };

/** Builds a Job from a CronJob's template, like `kubectl create job --from=cronjob/<name>`. */
export function jobFromCronJob(cron: KubeObject, now = new Date()): KubeObject {
  const suffix = `manual-${Math.floor(now.getTime() / 1000).toString(36)}`;
  const base = cron.metadata.name.slice(0, 63 - suffix.length - 1);
  const tmpl = cron.spec?.jobTemplate ?? {};
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${base}-${suffix}`,
      namespace: cron.metadata.namespace,
      labels: { ...(tmpl.metadata?.labels ?? {}) },
      annotations: { ...(tmpl.metadata?.annotations ?? {}), 'cronjob.kubernetes.io/instantiate': 'manual' },
      ownerReferences: [
        { apiVersion: 'batch/v1', kind: 'CronJob', name: cron.metadata.name, uid: cron.metadata.uid!, controller: true, blockOwnerDeletion: true } as any,
      ],
    },
    spec: tmpl.spec,
  };
}

export async function triggerCronJob(rest: KubeRest, namespace: string, name: string): Promise<{ jobName: string }> {
  const cron = await getResource(rest, CRONJOB_REF, namespace, name);
  const job = jobFromCronJob(cron);
  const created = await rest.request('POST', resourcePath(JOB_REF, namespace), { body: job, query: { fieldManager: FIELD_MANAGER } });
  return { jobName: created.metadata.name };
}

export async function suspendCronJob(rest: KubeRest, namespace: string, name: string, suspend: boolean): Promise<void> {
  await rest.request('PATCH', resourcePath(CRONJOB_REF, namespace, name), { body: { spec: { suspend } }, contentType: MERGE });
}

export { describeApiError };
