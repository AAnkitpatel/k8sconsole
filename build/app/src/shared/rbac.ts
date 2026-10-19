import type { KubeObject } from './types';

export interface Subject {
  kind: 'User' | 'Group' | 'ServiceAccount';
  name: string;
  namespace?: string;
}

export interface PolicyRule {
  verbs: string[];
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

export interface EffectiveRule extends PolicyRule {
  /** '*' for cluster-wide (ClusterRoleBinding), otherwise the namespace. */
  scope: string;
  via: { bindingKind: string; binding: string; bindingNamespace?: string; roleKind: string; role: string };
}

export interface RbacData {
  roles: KubeObject[];
  clusterRoles: KubeObject[];
  roleBindings: KubeObject[];
  clusterRoleBindings: KubeObject[];
}

export const subjectKey = (s: Subject) => `${s.kind}:${s.kind === 'ServiceAccount' ? `${s.namespace}/` : ''}${s.name}`;

/** Groups a subject belongs to implicitly (service accounts and every authenticated identity). */
export function implicitGroups(s: Subject): string[] {
  const g = ['system:authenticated'];
  if (s.kind === 'ServiceAccount') g.push('system:serviceaccounts', `system:serviceaccounts:${s.namespace}`);
  return g;
}

function bindingMatches(bindingSubject: any, s: Subject, bindingNs?: string): boolean {
  if (bindingSubject.kind === 'Group') {
    if (s.kind === 'Group') return bindingSubject.name === s.name;
    return implicitGroups(s).includes(bindingSubject.name);
  }
  if (bindingSubject.kind !== s.kind) return false;
  if (s.kind === 'ServiceAccount') return bindingSubject.name === s.name && (bindingSubject.namespace ?? bindingNs) === s.namespace;
  return bindingSubject.name === s.name;
}

function rolesFor(ref: any, ns: string | undefined, data: RbacData): KubeObject | undefined {
  if (ref?.kind === 'ClusterRole') return data.clusterRoles.find((r) => r.metadata.name === ref.name);
  return data.roles.find((r) => r.metadata.name === ref?.name && r.metadata.namespace === ns);
}

/** All rules that apply to a subject, with the binding that grants each. */
export function effectiveRules(s: Subject, data: RbacData): EffectiveRule[] {
  const out: EffectiveRule[] = [];
  for (const b of data.clusterRoleBindings) {
    if (!(b.subjects ?? []).some((x: any) => bindingMatches(x, s))) continue;
    const role = rolesFor(b.roleRef, undefined, data);
    for (const r of role?.rules ?? []) out.push({ ...r, scope: '*', via: { bindingKind: 'ClusterRoleBinding', binding: b.metadata.name, roleKind: b.roleRef.kind, role: b.roleRef.name } });
  }
  for (const b of data.roleBindings) {
    const ns = b.metadata.namespace!;
    if (!(b.subjects ?? []).some((x: any) => bindingMatches(x, s, ns))) continue;
    const role = rolesFor(b.roleRef, ns, data);
    for (const r of role?.rules ?? []) out.push({ ...r, scope: ns, via: { bindingKind: 'RoleBinding', binding: b.metadata.name, bindingNamespace: ns, roleKind: b.roleRef.kind, role: b.roleRef.name } });
  }
  return out;
}

const has = (list: string[] | undefined, v: string) => !!list && (list.includes('*') || list.includes(v));

/** Whether a rule permits `verb` on group/resource[/subresource] (optionally a named object). */
export function ruleAllows(r: PolicyRule, verb: string, group: string, resource: string, name?: string): boolean {
  if (!has(r.verbs, verb)) return false;
  if (!has(r.apiGroups, group)) return false;
  const base = resource.split('/')[0];
  const resOk = has(r.resources, resource) || (r.resources ?? []).includes(`${base}/*`) || (!resource.includes('/') && has(r.resources, base));
  if (!resOk) return false;
  if (r.resourceNames && r.resourceNames.length) return !!name && r.resourceNames.includes(name);
  return true;
}

export function allows(rules: EffectiveRule[], verb: string, group: string, resource: string, namespace: string | undefined, name?: string): EffectiveRule | null {
  for (const r of rules) {
    if (r.scope !== '*' && r.scope !== namespace) continue;
    if (ruleAllows(r, verb, group, resource, name)) return r;
  }
  return null;
}

export const STANDARD_VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection'] as const;

/** Verb matrix for a list of resources in one namespace (or cluster-wide when namespace is undefined). */
export function permissionMatrix(rules: EffectiveRule[], resources: Array<{ group: string; resource: string }>, namespace: string | undefined): Array<{ group: string; resource: string; verbs: Record<string, boolean> }> {
  return resources.map((res) => ({
    ...res,
    verbs: Object.fromEntries(STANDARD_VERBS.map((v) => [v, !!allows(rules, v, res.group, res.resource, namespace)])),
  }));
}

/** Every subject named in any binding, de-duplicated. */
export function knownSubjects(data: RbacData): Subject[] {
  const map = new Map<string, Subject>();
  for (const b of [...data.clusterRoleBindings, ...data.roleBindings]) {
    for (const s of b.subjects ?? []) {
      if (!['User', 'Group', 'ServiceAccount'].includes(s.kind)) continue;
      const subj: Subject = { kind: s.kind, name: s.name, namespace: s.kind === 'ServiceAccount' ? (s.namespace ?? b.metadata.namespace) : undefined };
      map.set(subjectKey(subj), subj);
    }
  }
  return [...map.values()].sort((a, b) => subjectKey(a).localeCompare(subjectKey(b)));
}

export interface WhoCanEntry {
  subject: Subject;
  via: EffectiveRule['via'];
  scope: string;
}

/** Subjects allowed to perform verb on group/resource in namespace, with the granting binding. */
export function whoCan(data: RbacData, verb: string, group: string, resource: string, namespace: string | undefined, name?: string): WhoCanEntry[] {
  const out: WhoCanEntry[] = [];
  const consider = (b: KubeObject, scope: string, bindingNs?: string) => {
    if (scope !== '*' && scope !== namespace) return;
    const role = rolesFor(b.roleRef, bindingNs, data);
    const rule = (role?.rules ?? []).find((r: PolicyRule) => ruleAllows(r, verb, group, resource, name));
    if (!rule) return;
    for (const s of b.subjects ?? []) {
      if (!['User', 'Group', 'ServiceAccount'].includes(s.kind)) continue;
      out.push({
        subject: { kind: s.kind, name: s.name, namespace: s.kind === 'ServiceAccount' ? (s.namespace ?? bindingNs) : undefined },
        scope,
        via: { bindingKind: b.kind!, binding: b.metadata.name, bindingNamespace: bindingNs, roleKind: b.roleRef.kind, role: b.roleRef.name },
      });
    }
  };
  for (const b of data.clusterRoleBindings) consider(b, '*');
  for (const b of data.roleBindings) consider(b, b.metadata.namespace!, b.metadata.namespace);
  return out.sort((a, b) => subjectKey(a.subject).localeCompare(subjectKey(b.subject)));
}

/** Builds Role/ClusterRole and binding manifests from the access editor's form state. */
export function roleManifest(input: { kind: 'Role' | 'ClusterRole'; name: string; namespace?: string; rules: PolicyRule[] }): KubeObject {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: input.kind,
    metadata: { name: input.name, ...(input.kind === 'Role' ? { namespace: input.namespace } : {}) },
    rules: input.rules.map((r) => ({
      apiGroups: r.apiGroups ?? [''],
      resources: r.resources ?? [],
      ...(r.resourceNames?.length ? { resourceNames: r.resourceNames } : {}),
      verbs: r.verbs,
    })),
  };
}

export function bindingManifest(input: { kind: 'RoleBinding' | 'ClusterRoleBinding'; name: string; namespace?: string; roleKind: 'Role' | 'ClusterRole'; roleName: string; subjects: Subject[] }): KubeObject {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: input.kind,
    metadata: { name: input.name, ...(input.kind === 'RoleBinding' ? { namespace: input.namespace } : {}) },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: input.roleKind, name: input.roleName },
    subjects: input.subjects.map((s) =>
      s.kind === 'ServiceAccount' ? { kind: 'ServiceAccount', name: s.name, namespace: s.namespace } : { kind: s.kind, name: s.name, apiGroup: 'rbac.authorization.k8s.io' },
    ),
  };
}
