import type { KubeObject } from './types';

/** Human age like kubectl: 45s, 12m, 3h, 5d, 2y. */
export function formatAge(timestamp: string | undefined, now: number = Date.now()): string {
  if (!timestamp) return '-';
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return '-';
  let s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 730) return `${d}d`;
  s = Math.floor(d / 365);
  return `${s}y`;
}

export interface PodSummary {
  status: string;
  ready: string;
  restarts: number;
  /** 'ok' | 'warn' | 'error' | 'pending' | 'done' for colouring. */
  severity: 'ok' | 'warn' | 'error' | 'pending' | 'done';
}

/** Derives the status column for a pod the same way `kubectl get pods` does (waiting/terminated reasons win). */
export function summarizePod(pod: KubeObject): PodSummary {
  const status = pod.status ?? {};
  const specContainers: any[] = pod.spec?.containers ?? [];
  const cs: any[] = status.containerStatuses ?? [];
  const ics: any[] = status.initContainerStatuses ?? [];
  const readyCount = cs.filter((c) => c.ready).length;
  const restarts = [...cs, ...ics].reduce((n, c) => n + (c.restartCount ?? 0), 0);
  let reason: string = status.reason || status.phase || 'Unknown';

  let initializing = false;
  ics.forEach((c, i) => {
    if (initializing) return;
    const term = c.state?.terminated;
    const wait = c.state?.waiting;
    if (term && term.exitCode === 0) return;
    initializing = true;
    if (term) reason = term.reason ? `Init:${term.reason}` : term.signal ? `Init:Signal:${term.signal}` : `Init:ExitCode:${term.exitCode}`;
    else if (wait?.reason && wait.reason !== 'PodInitializing') reason = `Init:${wait.reason}`;
    else reason = `Init:${i}/${(pod.spec?.initContainers ?? []).length}`;
  });

  if (!initializing) {
    let hasRunning = false;
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
      else if (c.state?.terminated?.reason) reason = c.state.terminated.reason;
      else if (c.state?.terminated) reason = c.state.terminated.signal ? `Signal:${c.state.terminated.signal}` : `ExitCode:${c.state.terminated.exitCode}`;
      else if (c.ready && c.state?.running) hasRunning = true;
    }
    if (reason === 'Completed' && hasRunning) reason = 'Running';
  }
  if (pod.metadata.deletionTimestamp) reason = status.reason === 'NodeLost' ? 'Unknown' : 'Terminating';

  let severity: PodSummary['severity'] = 'ok';
  if (/^(Succeeded|Completed)$/.test(reason)) severity = 'done';
  else if (/^(Pending|ContainerCreating|PodInitializing|Terminating)$/.test(reason) || reason.startsWith('Init:') && /\d+\/\d+$/.test(reason)) severity = 'pending';
  else if (reason !== 'Running') severity = 'error';
  else if (readyCount < specContainers.length) severity = 'warn';

  return { status: reason, ready: `${readyCount}/${specContainers.length || cs.length}`, restarts, severity };
}

/** Ready/desired summary for workloads. */
export function summarizeWorkload(obj: KubeObject): { ready: string; severity: 'ok' | 'warn' | 'error' } {
  const kind = obj.kind;
  const s = obj.status ?? {};
  let desired = 0;
  let ready = 0;
  if (kind === 'DaemonSet') {
    desired = s.desiredNumberScheduled ?? 0;
    ready = s.numberReady ?? 0;
  } else {
    desired = obj.spec?.replicas ?? 0;
    ready = s.readyReplicas ?? 0;
  }
  const severity = ready >= desired ? 'ok' : ready === 0 && desired > 0 ? 'error' : 'warn';
  return { ready: `${ready}/${desired}`, severity };
}

const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Parses a Kubernetes quantity string (e.g. "250m", "1.5Gi", "2e3") into a number of base units. */
export function parseQuantity(q: string | number | undefined | null): number {
  if (q === undefined || q === null || q === '') return 0;
  if (typeof q === 'number') return q;
  const m = /^([+-]?[0-9.]+)(e[+-]?[0-9]+|Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const suf = m[2] ?? '';
  if (suf.startsWith('e')) return n * 10 ** parseInt(suf.slice(1), 10);
  if (suf in BIN) return n * BIN[suf];
  return n * DEC[suf];
}

export function formatCpu(millis: number): string {
  if (!Number.isFinite(millis)) return '-';
  return millis >= 1000 ? `${(millis / 1000).toFixed(2)}` : `${Math.round(millis)}m`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/** Node readiness and role summary. */
export function summarizeNode(node: KubeObject): { status: string; roles: string; severity: 'ok' | 'warn' | 'error' } {
  const ready = (node.status?.conditions ?? []).find((c: any) => c.type === 'Ready');
  let status = ready?.status === 'True' ? 'Ready' : ready ? 'NotReady' : 'Unknown';
  if (node.spec?.unschedulable) status += ',SchedulingDisabled';
  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((l) => l.startsWith('node-role.kubernetes.io/'))
    .map((l) => l.slice('node-role.kubernetes.io/'.length))
    .join(',');
  const severity = status.startsWith('Ready') ? (node.spec?.unschedulable ? 'warn' : 'ok') : 'error';
  return { status, roles: roles || '<none>', severity };
}

/** Returns a copy of the object suitable for display/editing (optionally without managedFields). */
export function cleanForEditing(obj: KubeObject, hideManagedFields: boolean): KubeObject {
  const copy: KubeObject = JSON.parse(JSON.stringify(obj));
  if (hideManagedFields && copy.metadata) delete copy.metadata.managedFields;
  return copy;
}
