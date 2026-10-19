import type { KubeObject } from './types';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Category = 'workload' | 'access' | 'network' | 'namespace';

export interface SecurityFix {
  /** Human description of the change. */
  description: string;
  /** Strategic merge patch applied to the target object (workload template or pod-level fields). */
  patch: Record<string, unknown>;
  /** Changes that may break the workload deserve an extra warning. */
  mayBreak?: boolean;
}

export interface Finding {
  id: string;
  rule: string;
  title: string;
  severity: Severity;
  category: Category;
  target: { apiVersion: string; kind: string; namespace?: string; name: string };
  container?: string;
  detail: string;
  remediation: string;
  fix?: SecurityFix;
}

export interface SecurityReport {
  scannedAt: number;
  score: number;
  counts: Record<Severity, number>;
  findings: Finding[];
  scanned: { workloads: number; roles: number; bindings: number; namespaces: number };
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1 };

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet', 'Pod']);
const SYSTEM_NS = /^(kube-system|kube-public|kube-node-lease|local-path-storage)$/;
const DANGEROUS_CAPS = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_READ_SEARCH', 'NET_RAW', 'BPF']);
const SECRETISH_ENV = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

/** Returns the pod spec and the patch path prefix for a workload (Pod, template-based workload, or CronJob). */
export function podSpecOf(o: KubeObject): { spec: any; wrap: (podSpecPatch: Record<string, unknown>) => Record<string, unknown> } | null {
  switch (o.kind) {
    case 'Pod':
      return { spec: o.spec, wrap: (p) => ({ spec: p }) };
    case 'CronJob':
      return { spec: o.spec?.jobTemplate?.spec?.template?.spec, wrap: (p) => ({ spec: { jobTemplate: { spec: { template: { spec: p } } } } }) };
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job':
    case 'ReplicaSet':
      return { spec: o.spec?.template?.spec, wrap: (p) => ({ spec: { template: { spec: p } } }) };
    default:
      return null;
  }
}

/** Pods created by a controller are reported on the controller, not individually. */
const isControlled = (o: KubeObject) => (o.metadata.ownerReferences ?? []).some((r) => r.controller);

export function scanWorkload(o: KubeObject): Finding[] {
  const ps = podSpecOf(o);
  if (!ps?.spec) return [];
  const { spec, wrap } = ps;
  const target = { apiVersion: o.apiVersion ?? 'v1', kind: o.kind!, namespace: o.metadata.namespace, name: o.metadata.name };
  // Fixes are offered for controllers only: a bare Pod's spec is mostly immutable.
  const fixable = o.kind !== 'Pod';
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, title: string, detail: string, remediation: string, extra: Partial<Finding> = {}) =>
    out.push({ id: `${rule}:${target.kind}/${target.namespace ?? ''}/${target.name}${extra.container ? ':' + extra.container : ''}`, rule, title, severity, category: 'workload', target, detail, remediation, ...extra });
  const containerPatch = (name: string, sc: Record<string, unknown>) => wrap({ containers: [{ name, securityContext: sc }] });

  if (spec.hostNetwork) f('host-network', 'high', 'Uses the host network', 'hostNetwork: true exposes node network interfaces to the pod.', 'Remove hostNetwork unless the workload is a node-level agent.');
  if (spec.hostPID) f('host-pid', 'high', 'Shares the host PID namespace', 'hostPID: true lets the pod see and signal every process on the node.', 'Remove hostPID.');
  if (spec.hostIPC) f('host-ipc', 'high', 'Shares the host IPC namespace', 'hostIPC: true allows access to shared memory on the node.', 'Remove hostIPC.');
  const hostPaths = (spec.volumes ?? []).filter((v: any) => v.hostPath).map((v: any) => v.hostPath.path);
  if (hostPaths.length) f('host-path', 'high', 'Mounts host paths', `hostPath volumes: ${hostPaths.join(', ')}`, 'Use PersistentVolumeClaims, ConfigMaps or emptyDir instead of host paths.');
  const podRunAsNonRoot = spec.securityContext?.runAsNonRoot === true;
  const sa = spec.serviceAccountName ?? 'default';
  if (sa === 'default' && spec.automountServiceAccountToken !== false) {
    f('sa-token-automount', 'low', 'Default service account token is mounted', 'The pod uses the default ServiceAccount and mounts its API token.', 'Set automountServiceAccountToken: false, or use a dedicated ServiceAccount.', fixable ? { fix: { description: 'Set automountServiceAccountToken: false on the pod template', patch: wrap({ automountServiceAccountToken: false }), mayBreak: true } } : {});
  }
  const seccomp = spec.securityContext?.seccompProfile?.type;
  if (seccomp !== 'RuntimeDefault' && seccomp !== 'Localhost') {
    f('seccomp', 'low', 'No seccomp profile', 'The pod does not opt into the RuntimeDefault seccomp profile.', 'Set securityContext.seccompProfile.type: RuntimeDefault.', fixable ? { fix: { description: 'Set seccompProfile RuntimeDefault on the pod template', patch: wrap({ securityContext: { seccompProfile: { type: 'RuntimeDefault' } } }) } } : {});
  }

  for (const c of spec.containers ?? []) {
    const sc = c.securityContext ?? {};
    const ex = { container: c.name };
    if (sc.privileged) {
      f('privileged', 'critical', `Container ${c.name} is privileged`, 'privileged: true gives the container full access to the node.', 'Remove privileged mode.', { ...ex, ...(fixable ? { fix: { description: `Set privileged: false on ${c.name}`, patch: containerPatch(c.name, { privileged: false }), mayBreak: true } } : {}) });
    }
    if (sc.allowPrivilegeEscalation !== false) {
      f('privilege-escalation', 'medium', `Container ${c.name} allows privilege escalation`, 'allowPrivilegeEscalation is not set to false.', 'Set allowPrivilegeEscalation: false.', { ...ex, ...(fixable ? { fix: { description: `Set allowPrivilegeEscalation: false on ${c.name}`, patch: containerPatch(c.name, { allowPrivilegeEscalation: false }) } } : {}) });
    }
    if (!podRunAsNonRoot && sc.runAsNonRoot !== true && !(typeof sc.runAsUser === 'number' && sc.runAsUser > 0)) {
      f('run-as-root', 'medium', `Container ${c.name} may run as root`, 'Neither runAsNonRoot nor a non-zero runAsUser is set.', 'Set runAsNonRoot: true (the image must support a non-root user).', { ...ex, ...(fixable ? { fix: { description: `Set runAsNonRoot: true on ${c.name}`, patch: containerPatch(c.name, { runAsNonRoot: true }), mayBreak: true } } : {}) });
    }
    if (sc.readOnlyRootFilesystem !== true) {
      f('writable-root-fs', 'low', `Container ${c.name} has a writable root filesystem`, 'readOnlyRootFilesystem is not true.', 'Set readOnlyRootFilesystem: true and mount emptyDir volumes where writes are needed.', { ...ex, ...(fixable ? { fix: { description: `Set readOnlyRootFilesystem: true on ${c.name}`, patch: containerPatch(c.name, { readOnlyRootFilesystem: true }), mayBreak: true } } : {}) });
    }
    const added: string[] = sc.capabilities?.add ?? [];
    const risky = added.filter((cap) => DANGEROUS_CAPS.has(String(cap).toUpperCase().replace(/^CAP_/, '')));
    if (risky.length) f('dangerous-capabilities', 'high', `Container ${c.name} adds powerful capabilities`, `Added: ${risky.join(', ')}`, 'Remove the added capabilities or replace them with narrower ones.', ex);
    const dropped: string[] = (sc.capabilities?.drop ?? []).map((x: string) => String(x).toUpperCase());
    if (!dropped.includes('ALL')) {
      f('capabilities-not-dropped', 'low', `Container ${c.name} keeps default capabilities`, 'capabilities.drop does not include ALL.', 'Drop ALL capabilities and add back only what is required.', { ...ex, ...(fixable && !added.length ? { fix: { description: `Drop ALL capabilities on ${c.name}`, patch: containerPatch(c.name, { capabilities: { drop: ['ALL'] } }), mayBreak: true } } : {}) });
    }
    const limits = c.resources?.limits ?? {};
    if (!limits.memory) f('no-memory-limit', 'medium', `Container ${c.name} has no memory limit`, 'Without a memory limit one container can exhaust node memory.', 'Set resources.limits.memory.', ex);
    if (!c.resources?.requests?.cpu && !c.resources?.requests?.memory) f('no-requests', 'low', `Container ${c.name} has no resource requests`, 'The scheduler cannot place the pod based on its real needs.', 'Set resources.requests for cpu and memory.', ex);
    const image: string = c.image ?? '';
    const tag = image.includes('@') ? 'digest' : image.split('/').pop()!.split(':')[1];
    if (!tag || tag === 'latest') f('mutable-image-tag', 'medium', `Container ${c.name} uses a mutable image tag`, `Image "${image}" ${tag ? 'uses :latest' : 'has no tag'}.`, 'Pin a version tag or a digest.', ex);
    if (!c.livenessProbe && !c.readinessProbe && o.kind !== 'Job' && o.kind !== 'CronJob') f('no-probes', 'low', `Container ${c.name} has no health probes`, 'Neither livenessProbe nor readinessProbe is defined.', 'Add a readinessProbe (and a livenessProbe where it helps recovery).', ex);
    const literal = (c.env ?? []).filter((e: any) => e.value && SECRETISH_ENV.test(e.name)).map((e: any) => e.name);
    if (literal.length) f('secret-in-env', 'medium', `Container ${c.name} has credentials in plain env values`, `Variables: ${literal.join(', ')}`, 'Move the values into a Secret and reference it with valueFrom.secretKeyRef.', ex);
  }
  return out;
}

const isSystemSubject = (s: any) => /^system:/.test(s.name ?? '') || (s.kind === 'ServiceAccount' && SYSTEM_NS.test(s.namespace ?? ''));

export function scanRbac(roles: KubeObject[], bindings: KubeObject[]): Finding[] {
  const out: Finding[] = [];
  const t = (o: KubeObject) => ({ apiVersion: o.apiVersion ?? 'rbac.authorization.k8s.io/v1', kind: o.kind!, namespace: o.metadata.namespace, name: o.metadata.name });
  for (const r of roles) {
    if (/^system:/.test(r.metadata.name) || r.metadata.name === 'cluster-admin' || r.metadata.name === 'admin' || r.metadata.name === 'edit') continue;
    for (const rule of r.rules ?? []) {
      const wildVerb = (rule.verbs ?? []).includes('*');
      const wildRes = (rule.resources ?? []).includes('*');
      if (wildVerb || wildRes) {
        out.push({ id: `wildcard-rbac:${r.kind}/${r.metadata.namespace ?? ''}/${r.metadata.name}`, rule: 'wildcard-rbac', title: `${r.kind} ${r.metadata.name} uses wildcards`, severity: 'high', category: 'access', target: t(r), detail: `Rule grants ${wildVerb ? 'all verbs' : rule.verbs?.join(',')} on ${wildRes ? 'all resources' : rule.resources?.join(',')}.`, remediation: 'List the exact verbs and resources the subject needs.' });
        break;
      }
    }
    if ((r.rules ?? []).some((rule: any) => (rule.resources ?? []).some((x: string) => x === 'secrets') && (rule.verbs ?? []).some((v: string) => ['get', 'list', 'watch', '*'].includes(v)))) {
      out.push({ id: `secret-read:${r.kind}/${r.metadata.namespace ?? ''}/${r.metadata.name}`, rule: 'secret-read', title: `${r.kind} ${r.metadata.name} can read Secrets`, severity: 'medium', category: 'access', target: t(r), detail: 'get/list/watch on secrets exposes every credential in scope.', remediation: 'Restrict with resourceNames or remove secret access.' });
    }
  }
  for (const b of bindings) {
    const subjects = (b.subjects ?? []).filter((s: any) => !isSystemSubject(s));
    if (b.kind === 'ClusterRoleBinding' && b.roleRef?.name === 'cluster-admin' && subjects.length) {
      out.push({ id: `cluster-admin-binding:${b.metadata.name}`, rule: 'cluster-admin-binding', title: `cluster-admin granted by ${b.metadata.name}`, severity: 'critical', category: 'access', target: t(b), detail: `Subjects: ${subjects.map((s: any) => `${s.kind}:${s.namespace ? s.namespace + '/' : ''}${s.name}`).join(', ')}`, remediation: 'Grant a narrower ClusterRole or a namespaced Role.' });
    }
    const defaultSa = subjects.filter((s: any) => s.kind === 'ServiceAccount' && s.name === 'default');
    if (defaultSa.length) {
      out.push({ id: `default-sa-bound:${b.kind}/${b.metadata.namespace ?? ''}/${b.metadata.name}`, rule: 'default-sa-bound', title: `Default ServiceAccount gets permissions via ${b.metadata.name}`, severity: 'medium', category: 'access', target: t(b), detail: `Every pod without an explicit ServiceAccount in ${defaultSa.map((s: any) => s.namespace ?? b.metadata.namespace).join(', ')} inherits ${b.roleRef?.kind} ${b.roleRef?.name}.`, remediation: 'Bind a dedicated ServiceAccount instead.' });
    }
  }
  return out;
}

export function scanNetwork(namespaces: KubeObject[], policies: KubeObject[], services: KubeObject[]): Finding[] {
  const out: Finding[] = [];
  const withPolicy = new Set(policies.map((p) => p.metadata.namespace));
  for (const ns of namespaces) {
    const name = ns.metadata.name;
    if (SYSTEM_NS.test(name)) continue;
    if (!withPolicy.has(name)) {
      out.push({ id: `no-network-policy:${name}`, rule: 'no-network-policy', title: `Namespace ${name} has no NetworkPolicy`, severity: 'medium', category: 'network', target: { apiVersion: 'v1', kind: 'Namespace', name }, detail: 'All pods accept traffic from anywhere in the cluster.', remediation: 'Add a default-deny policy and allow required traffic explicitly.' });
    }
    const labels = ns.metadata.labels ?? {};
    if (!labels['pod-security.kubernetes.io/enforce']) {
      out.push({ id: `no-pod-security-level:${name}`, rule: 'no-pod-security-level', title: `Namespace ${name} has no Pod Security level`, severity: 'low', category: 'namespace', target: { apiVersion: 'v1', kind: 'Namespace', name }, detail: 'The pod-security.kubernetes.io/enforce label is not set.', remediation: 'Label the namespace with pod-security.kubernetes.io/enforce=baseline (or restricted).', fix: { description: 'Add label pod-security.kubernetes.io/enforce=baseline', patch: { metadata: { labels: { 'pod-security.kubernetes.io/enforce': 'baseline' } } }, mayBreak: true } });
    }
  }
  for (const s of services) {
    if (s.spec?.type === 'NodePort' || s.spec?.type === 'LoadBalancer') {
      out.push({ id: `exposed-service:${s.metadata.namespace}/${s.metadata.name}`, rule: 'exposed-service', title: `Service ${s.metadata.name} is exposed outside the cluster`, severity: 'low', category: 'network', target: { apiVersion: 'v1', kind: 'Service', namespace: s.metadata.namespace, name: s.metadata.name }, detail: `type: ${s.spec.type}`, remediation: 'Confirm the exposure is intended; prefer an Ingress with TLS for HTTP.' });
    }
  }
  return out;
}

export function scoreFindings(findings: Finding[]): { score: number; counts: Record<Severity, number> } {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let penalty = 0;
  for (const f of findings) {
    counts[f.severity]++;
    penalty += SEVERITY_WEIGHT[f.severity];
  }
  // Diminishing penalty so large clusters don't all sit at 0.
  const score = Math.round(100 * Math.exp(-penalty / 400));
  return { score, counts };
}

export interface ScanInput {
  workloads: KubeObject[];
  roles: KubeObject[];
  bindings: KubeObject[];
  namespaces: KubeObject[];
  networkPolicies: KubeObject[];
  services: KubeObject[];
}

export function runSecurityScan(input: ScanInput, now = Date.now()): SecurityReport {
  const workloads = input.workloads.filter((w) => WORKLOAD_KINDS.has(w.kind!) && !(w.kind === 'Pod' && isControlled(w)) && !(w.kind === 'ReplicaSet' && isControlled(w)) && !(w.kind === 'Job' && isControlled(w)));
  const findings = [
    ...workloads.flatMap(scanWorkload),
    ...scanRbac(input.roles, input.bindings),
    ...scanNetwork(input.namespaces, input.networkPolicies, input.services),
  ];
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  const { score, counts } = scoreFindings(findings);
  return { scannedAt: now, score, counts, findings, scanned: { workloads: workloads.length, roles: input.roles.length, bindings: input.bindings.length, namespaces: input.namespaces.length } };
}
