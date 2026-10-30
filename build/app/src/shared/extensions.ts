// Extensions: declarative add-ons (JSON manifests). They add terminal commands, links and policy rules to the app.
// No third-party code ever runs inside K8sConsole: commands are only typed into the terminal for the user to run,
// links open in the browser, and rules are evaluated by the app.

export const EXTENSION_API_VERSION = 1;

export interface ExtCommand {
  id: string;
  title: string;
  /** Shell command with {{placeholders}}; inserted into a terminal, never run automatically. */
  command: string;
  /** Kubernetes kinds (or "EcsService", "EcsTask") it applies to; empty = everywhere. */
  kinds?: string[];
}

export interface ExtLink {
  id: string;
  title: string;
  /** http(s) URL template; placeholder values are URL-encoded. */
  url: string;
  kinds?: string[];
}

export type RuleCheck = 'exists' | 'absent' | 'equals' | 'not-equals' | 'matches' | 'not-matches';

export interface ExtRule {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  kinds: string[];
  /** Dotted path into the object; `[]` fans out over arrays, e.g. "spec.template.spec.containers[].image". */
  path: string;
  check: RuleCheck;
  value?: string;
  remediation?: string;
}

export interface ExtensionManifest {
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  commands: ExtCommand[];
  links: ExtLink[];
  rules: ExtRule[];
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  enabled: boolean;
  path: string;
}

export interface ExtFinding {
  extension: string;
  rule: string;
  title: string;
  severity: ExtRule['severity'];
  kind: string;
  namespace?: string;
  name: string;
  detail: string;
  remediation?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;
const KNOWN_PLACEHOLDERS = new Set(['name', 'namespace', 'kind', 'context', 'cluster', 'service', 'task', 'container', 'region']);
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const kindsOf = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9]{0,62}$/.test(k)) : undefined);

function checkPlaceholders(template: string, where: string, errors: string[]) {
  for (const m of template.matchAll(PLACEHOLDER)) if (!KNOWN_PLACEHOLDERS.has(m[1])) errors.push(`${where}: unknown placeholder {{${m[1]}}}`);
}

/** Validates an untrusted manifest; returns the cleaned manifest or the problems. */
export function validateManifest(input: unknown): { ok: true; manifest: ExtensionManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const m = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, any>;
  if (m.apiVersion !== EXTENSION_API_VERSION) errors.push(`"apiVersion" must be ${EXTENSION_API_VERSION}`);
  if (!ID.test(String(m.id ?? ''))) errors.push('"id" must be lowercase letters, digits and hyphens');
  if (!str(m.name, 80)) errors.push('"name" is required');
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version ?? ''))) errors.push('"version" must look like 1.0.0');
  if (m.homepage !== undefined && !/^https:\/\/[^\s]+$/.test(String(m.homepage))) errors.push('"homepage" must be an https URL');
  const commands: ExtCommand[] = [];
  for (const [i, c] of (Array.isArray(m.commands) ? m.commands : []).entries()) {
    const where = `commands[${i}]`;
    if (!ID.test(String(c?.id ?? '')) || !str(c?.title, 80) || !str(c?.command, 1000)) {
      errors.push(`${where}: needs "id", "title" and "command"`);
      continue;
    }
    if (/[\r\n]/.test(c.command)) errors.push(`${where}: commands must be a single line`);
    checkPlaceholders(c.command, where, errors);
    commands.push({ id: c.id, title: c.title.trim(), command: c.command.trim(), kinds: kindsOf(c.kinds) });
  }
  const links: ExtLink[] = [];
  for (const [i, l] of (Array.isArray(m.links) ? m.links : []).entries()) {
    const where = `links[${i}]`;
    if (!ID.test(String(l?.id ?? '')) || !str(l?.title, 80) || !str(l?.url, 2000)) {
      errors.push(`${where}: needs "id", "title" and "url"`);
      continue;
    }
    if (!/^https?:\/\/[^\s{}]+/.test(l.url.replace(PLACEHOLDER, 'x'))) errors.push(`${where}: "url" must be an http(s) URL`);
    checkPlaceholders(l.url, where, errors);
    links.push({ id: l.id, title: l.title.trim(), url: l.url.trim(), kinds: kindsOf(l.kinds) });
  }
  const rules: ExtRule[] = [];
  const checks: RuleCheck[] = ['exists', 'absent', 'equals', 'not-equals', 'matches', 'not-matches'];
  for (const [i, r] of (Array.isArray(m.rules) ? m.rules : []).entries()) {
    const where = `rules[${i}]`;
    const kinds = kindsOf(r?.kinds);
    if (!ID.test(String(r?.id ?? '')) || !str(r?.title, 120) || !kinds?.length || !str(r?.path, 300)) {
      errors.push(`${where}: needs "id", "title", "kinds" and "path"`);
      continue;
    }
    if (!['critical', 'high', 'medium', 'low'].includes(r.severity)) errors.push(`${where}: "severity" must be critical, high, medium or low`);
    if (!checks.includes(r.check)) errors.push(`${where}: "check" must be one of ${checks.join(', ')}`);
    if (!/^[A-Za-z0-9_\-./[\]]+$/.test(r.path) || r.path.split('.').some((s: string) => ['__proto__', 'constructor', 'prototype'].includes(s.replace('[]', '')))) errors.push(`${where}: invalid "path"`);
    if (['equals', 'not-equals', 'matches', 'not-matches'].includes(r.check) && typeof r.value !== 'string') errors.push(`${where}: "${r.check}" needs a "value"`);
    if ((r.check === 'matches' || r.check === 'not-matches') && typeof r.value === 'string') {
      if (r.value.length > 300) errors.push(`${where}: "value" is too long`);
      else
        try {
          new RegExp(r.value);
        } catch {
          errors.push(`${where}: "value" is not a valid regular expression`);
        }
    }
    rules.push({ id: r.id, title: r.title.trim(), severity: r.severity, kinds, path: r.path, check: r.check, value: r.value, remediation: typeof r.remediation === 'string' ? r.remediation.slice(0, 500) : undefined });
  }
  if (!commands.length && !links.length && !rules.length) errors.push('an extension needs at least one command, link or rule');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: { apiVersion: EXTENSION_API_VERSION, id: m.id, name: m.name.trim(), version: m.version, description: typeof m.description === 'string' ? m.description.slice(0, 500) : undefined, author: typeof m.author === 'string' ? m.author.slice(0, 120) : undefined, homepage: m.homepage, commands, links, rules },
  };
}

export type PlaceholderValues = Partial<Record<'name' | 'namespace' | 'kind' | 'context' | 'cluster' | 'service' | 'task' | 'container' | 'region', string>>;

/** Only plain identifiers are substituted into shell commands, so a resource name can never inject shell syntax. */
const SHELL_SAFE = /^[A-Za-z0-9._:/@-]{1,253}$/;

/** Fills a command template; null when a placeholder has no value or an unsafe value. */
export function renderCommand(template: string, values: PlaceholderValues): string | null {
  let ok = true;
  const out = template.replace(PLACEHOLDER, (_, k: string) => {
    const v = values[k as keyof PlaceholderValues];
    if (v === undefined || !SHELL_SAFE.test(v)) {
      ok = false;
      return '';
    }
    return v;
  });
  return ok ? out : null;
}

export function renderLink(template: string, values: PlaceholderValues): string | null {
  let ok = true;
  const out = template.replace(PLACEHOLDER, (_, k: string) => {
    const v = values[k as keyof PlaceholderValues];
    if (v === undefined) {
      ok = false;
      return '';
    }
    return encodeURIComponent(v);
  });
  if (!ok) return null;
  try {
    const u = new URL(out);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export const appliesTo = (kinds: string[] | undefined, kind: string) => !kinds?.length || kinds.includes(kind);

/** Values at a dotted path; `[]` fans out over arrays. */
export function valuesAt(obj: unknown, path: string): unknown[] {
  let cur: unknown[] = [obj];
  for (const raw of path.split('.')) {
    const fan = raw.endsWith('[]');
    const key = fan ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const c of cur) {
      if (!c || typeof c !== 'object' || !Object.prototype.hasOwnProperty.call(c, key)) continue;
      const v = (c as Record<string, unknown>)[key];
      if (fan) {
        if (Array.isArray(v)) next.push(...v);
      } else next.push(v);
    }
    cur = next;
  }
  return cur;
}

const asText = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

/** Evaluates one rule on one object; returns the finding detail when it fails. */
export function evaluateRule(rule: ExtRule, obj: { kind?: string; metadata?: any }): string | null {
  const vals = valuesAt(obj, rule.path).filter((v) => v !== undefined && v !== null);
  switch (rule.check) {
    case 'exists':
      return vals.length ? null : `${rule.path} is not set`;
    case 'absent':
      return vals.length ? `${rule.path} is set` : null;
    case 'equals': {
      const bad = vals.length ? vals.find((v) => asText(v) !== rule.value) : undefined;
      return !vals.length ? `${rule.path} is not set (expected "${rule.value}")` : bad !== undefined ? `${rule.path} is "${asText(bad)}", expected "${rule.value}"` : null;
    }
    case 'not-equals': {
      const bad = vals.find((v) => asText(v) === rule.value);
      return bad !== undefined ? `${rule.path} is "${rule.value}"` : null;
    }
    case 'matches': {
      const re = new RegExp(rule.value!);
      const bad = vals.length ? vals.find((v) => !re.test(asText(v))) : undefined;
      return !vals.length ? `${rule.path} is not set` : bad !== undefined ? `${rule.path} "${asText(bad)}" does not match ${rule.value}` : null;
    }
    case 'not-matches': {
      const re = new RegExp(rule.value!);
      const bad = vals.find((v) => re.test(asText(v)));
      return bad !== undefined ? `${rule.path} "${asText(bad)}" matches ${rule.value}` : null;
    }
  }
}

export function runRules(extensions: ExtensionManifest[], objects: Array<{ kind?: string; metadata: { name: string; namespace?: string } }>): ExtFinding[] {
  const out: ExtFinding[] = [];
  for (const ext of extensions) {
    for (const rule of ext.rules) {
      for (const o of objects) {
        if (!o.kind || !rule.kinds.includes(o.kind)) continue;
        const detail = evaluateRule(rule, o);
        if (detail) out.push({ extension: ext.id, rule: rule.id, title: rule.title, severity: rule.severity, kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name, detail, remediation: rule.remediation });
      }
    }
  }
  const order = ['critical', 'high', 'medium', 'low'];
  return out.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.name.localeCompare(b.name));
}

/** A starter manifest shown in the Extensions view and written by "Create example". */
export const EXAMPLE_EXTENSION: ExtensionManifest = {
  apiVersion: 1,
  id: 'example-team-tools',
  name: 'Example team tools',
  version: '1.0.0',
  description: 'Shows what an extension can add: terminal commands, links and policy rules.',
  author: 'K8sConsole',
  commands: [
    { id: 'describe', title: 'kubectl describe', command: 'kubectl describe {{kind}} {{name}} -n {{namespace}}', kinds: ['Deployment', 'StatefulSet', 'Pod', 'Service'] },
    { id: 'rollout-history', title: 'Rollout history', command: 'kubectl rollout history deployment/{{name}} -n {{namespace}}', kinds: ['Deployment'] },
    { id: 'ecs-describe', title: 'aws ecs describe-services', command: 'aws ecs describe-services --cluster {{cluster}} --services {{service}} --region {{region}}', kinds: ['EcsService'] },
  ],
  links: [{ id: 'k8s-docs', title: 'Kubernetes docs for this kind', url: 'https://kubernetes.io/search/?q={{kind}}', kinds: [] }],
  rules: [
    { id: 'team-label', title: 'Workload has no "team" label', severity: 'low', kinds: ['Deployment', 'StatefulSet', 'DaemonSet'], path: 'metadata.labels.team', check: 'exists', remediation: 'Add a "team" label so ownership is clear.' },
    { id: 'no-latest', title: 'Image uses the :latest tag', severity: 'medium', kinds: ['Deployment', 'StatefulSet', 'DaemonSet'], path: 'spec.template.spec.containers[].image', check: 'not-matches', value: '(:latest$)|(^[^:@]+$)', remediation: 'Pin a version tag or digest.' },
  ],
};
