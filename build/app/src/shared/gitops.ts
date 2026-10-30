// GitOps: Flux and Argo CD objects normalized into one shape, plus the patches behind their actions.
import type { ApiResourceInfo, KubeObject, ResourceRef } from './types';
import type { NodeStatus } from './graph';

export type GitOpsEngine = 'flux' | 'argocd';

/** The kinds the GitOps view lists, in display order. */
export const GITOPS_KINDS: Array<{ engine: GitOpsEngine; group: string; kind: string; label: string }> = [
  { engine: 'argocd', group: 'argoproj.io', kind: 'Application', label: 'Argo CD Application' },
  { engine: 'argocd', group: 'argoproj.io', kind: 'ApplicationSet', label: 'Argo CD ApplicationSet' },
  { engine: 'flux', group: 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization', label: 'Flux Kustomization' },
  { engine: 'flux', group: 'helm.toolkit.fluxcd.io', kind: 'HelmRelease', label: 'Flux HelmRelease' },
  { engine: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'GitRepository', label: 'Flux GitRepository' },
  { engine: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'OCIRepository', label: 'Flux OCIRepository' },
  { engine: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'HelmRepository', label: 'Flux HelmRepository' },
  { engine: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'HelmChart', label: 'Flux HelmChart' },
  { engine: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'Bucket', label: 'Flux Bucket' },
  { engine: 'flux', group: 'image.toolkit.fluxcd.io', kind: 'ImageUpdateAutomation', label: 'Flux ImageUpdateAutomation' },
];

export interface GitOpsItem {
  engine: GitOpsEngine;
  ref: ResourceRef;
  kind: string;
  namespace: string;
  name: string;
  /** ok = ready/synced+healthy, warn = progressing/out of sync, error = failed/degraded, pending = reconciling, done = suspended. */
  status: NodeStatus;
  /** Short state, e.g. "Synced · Healthy", "Ready", "Suspended". */
  state: string;
  message?: string;
  /** Git/OCI/Helm source as text, e.g. "https://github.com/org/repo @ main (apps/web)". */
  source?: string;
  /** Applied or fetched revision. */
  revision?: string;
  /** Where it deploys to (Argo destination or Flux target namespace). */
  destination?: string;
  suspended: boolean;
  lastChange?: string;
  /** Actions this object supports. */
  actions: Array<'reconcile' | 'suspend' | 'resume' | 'refresh' | 'sync'>;
}

/** ResourceRefs for every GitOps kind the cluster serves. */
export function gitopsRefs(discovery: ApiResourceInfo[]): Array<{ engine: GitOpsEngine; ref: ResourceRef; label: string }> {
  const out: Array<{ engine: GitOpsEngine; ref: ResourceRef; label: string }> = [];
  for (const k of GITOPS_KINDS) {
    // Prefer the newest served version of the group (discovery lists the preferred version first).
    const d = discovery.find((x) => x.group === k.group && x.kind === k.kind && x.verbs.includes('list'));
    if (d) out.push({ engine: k.engine, label: k.label, ref: { apiVersion: d.apiVersion, kind: d.kind, plural: d.plural, namespaced: d.namespaced } });
  }
  return out;
}

const cond = (o: KubeObject, type: string) => (o.status?.conditions ?? []).find((c: any) => c?.type === type);

function fluxItem(o: KubeObject, ref: ResourceRef): GitOpsItem {
  const suspended = !!o.spec?.suspend;
  const ready = cond(o, 'Ready');
  const reconciling = cond(o, 'Reconciling');
  const stalled = cond(o, 'Stalled');
  let status: NodeStatus;
  let state: string;
  if (suspended) [status, state] = ['done', 'Suspended'];
  else if (stalled?.status === 'True') [status, state] = ['error', `Stalled${stalled.reason ? ` (${stalled.reason})` : ''}`];
  else if (ready?.status === 'True') [status, state] = ['ok', 'Ready'];
  else if (reconciling?.status === 'True' || ready?.status === 'Unknown' || !ready) [status, state] = ['pending', 'Reconciling'];
  else [status, state] = ['error', `Not ready${ready.reason ? ` (${ready.reason})` : ''}`];
  const s = o.spec ?? {};
  let source: string | undefined;
  if (o.kind === 'GitRepository') source = `${s.url ?? ''}${s.ref?.branch ? ` @ ${s.ref.branch}` : s.ref?.tag ? ` @ ${s.ref.tag}` : s.ref?.semver ? ` @ ${s.ref.semver}` : ''}`;
  else if (o.kind === 'OCIRepository' || o.kind === 'HelmRepository' || o.kind === 'Bucket') source = s.url ?? s.endpoint;
  else if (o.kind === 'Kustomization') source = `${s.sourceRef?.kind ?? ''}/${s.sourceRef?.name ?? ''}${s.path ? ` (${s.path})` : ''}`;
  else if (o.kind === 'HelmRelease') source = s.chart?.spec ? `${s.chart.spec.chart}${s.chart.spec.version ? `@${s.chart.spec.version}` : ''} from ${s.chart.spec.sourceRef?.kind}/${s.chart.spec.sourceRef?.name}` : s.chartRef ? `${s.chartRef.kind}/${s.chartRef.name}` : undefined;
  else if (o.kind === 'HelmChart') source = `${s.chart ?? ''}${s.version ? `@${s.version}` : ''}`;
  const revision = o.status?.lastAppliedRevision ?? o.status?.artifact?.revision ?? o.status?.lastAttemptedRevision;
  return {
    engine: 'flux',
    ref,
    kind: o.kind!,
    namespace: o.metadata.namespace ?? '',
    name: o.metadata.name,
    status,
    state,
    message: (stalled?.status === 'True' ? stalled.message : ready?.message) || undefined,
    source,
    revision: typeof revision === 'string' ? revision : undefined,
    destination: s.targetNamespace ?? s.releaseName ?? undefined,
    suspended,
    lastChange: ready?.lastTransitionTime,
    actions: ['reconcile', suspended ? 'resume' : 'suspend'],
  };
}

function argoItem(o: KubeObject, ref: ResourceRef): GitOpsItem {
  const st = o.status ?? {};
  if (o.kind === 'ApplicationSet') {
    const err = (st.conditions ?? []).find((c: any) => c?.type === 'ErrorOccurred' && c?.status === 'True');
    const n = (st.resources ?? []).length;
    return {
      engine: 'argocd',
      ref,
      kind: 'ApplicationSet',
      namespace: o.metadata.namespace ?? '',
      name: o.metadata.name,
      status: err ? 'error' : 'ok',
      state: err ? 'Error' : `${n} application${n === 1 ? '' : 's'}`,
      message: err?.message,
      source: (o.spec?.template?.spec?.source?.repoURL as string) ?? undefined,
      suspended: false,
      actions: [],
    };
  }
  const sync = st.sync?.status ?? 'Unknown';
  const health = st.health?.status ?? 'Unknown';
  const phase = st.operationState?.phase;
  let status: NodeStatus;
  if (phase === 'Running') status = 'pending';
  else if (health === 'Degraded' || health === 'Missing' || phase === 'Failed' || phase === 'Error') status = 'error';
  else if (sync === 'OutOfSync' || health === 'Progressing' || health === 'Unknown') status = 'warn';
  else if (health === 'Suspended') status = 'done';
  else status = 'ok';
  const src = o.spec?.source ?? o.spec?.sources?.[0] ?? {};
  const dest = o.spec?.destination ?? {};
  const failedMsg = phase === 'Failed' || phase === 'Error' ? st.operationState?.message : undefined;
  const condMsg = (st.conditions ?? []).find((c: any) => /Error|Warning/.test(c?.type ?? ''))?.message;
  return {
    engine: 'argocd',
    ref,
    kind: 'Application',
    namespace: o.metadata.namespace ?? '',
    name: o.metadata.name,
    status,
    state: `${sync} · ${health}${phase === 'Running' ? ' · syncing' : ''}`,
    message: failedMsg ?? condMsg ?? st.health?.message,
    source: src.repoURL ? `${src.repoURL}${src.targetRevision ? ` @ ${src.targetRevision}` : ''}${src.path ? ` (${src.path})` : src.chart ? ` (chart ${src.chart})` : ''}` : undefined,
    revision: st.sync?.revision ?? undefined,
    destination: `${dest.name ?? dest.server ?? ''}${dest.namespace ? ` / ${dest.namespace}` : ''}` || undefined,
    suspended: !o.spec?.syncPolicy?.automated,
    lastChange: st.reconciledAt ?? st.operationState?.finishedAt,
    actions: ['refresh', 'sync'],
  };
}

export function toGitOpsItem(o: KubeObject, ref: ResourceRef): GitOpsItem {
  return ref.apiVersion.startsWith('argoproj.io/') ? argoItem(o, ref) : fluxItem(o, ref);
}

export type GitOpsAction = 'reconcile' | 'suspend' | 'resume' | 'refresh' | 'hard-refresh' | 'sync';

/** The JSON merge patch that performs an action (what the flux and argocd CLIs do through the API). */
export function gitopsPatch(engine: GitOpsEngine, action: GitOpsAction, now = new Date()): Record<string, unknown> {
  if (engine === 'flux') {
    if (action === 'reconcile') return { metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': now.toISOString() } } };
    if (action === 'suspend') return { spec: { suspend: true } };
    if (action === 'resume') return { spec: { suspend: false }, metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': now.toISOString() } } };
  } else {
    if (action === 'refresh') return { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } };
    if (action === 'hard-refresh') return { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } };
    if (action === 'sync') return { operation: { initiatedBy: { username: 'k8sconsole' }, sync: { syncStrategy: { hook: {} } } } };
  }
  throw new Error(`${action} is not supported for ${engine === 'flux' ? 'Flux' : 'Argo CD'} objects`);
}

export function gitopsSummary(items: GitOpsItem[]): { total: number; ok: number; warn: number; error: number; pending: number; suspended: number; engines: GitOpsEngine[] } {
  return {
    total: items.length,
    ok: items.filter((i) => i.status === 'ok').length,
    warn: items.filter((i) => i.status === 'warn').length,
    error: items.filter((i) => i.status === 'error').length,
    pending: items.filter((i) => i.status === 'pending').length,
    suspended: items.filter((i) => i.engine === 'flux' && i.suspended).length,
    engines: [...new Set(items.map((i) => i.engine))],
  };
}
