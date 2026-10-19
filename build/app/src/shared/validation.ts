import { parseAllDocuments } from 'yaml';
import type { KubeObject } from './types';
import { isValidName } from './resources';

export interface ManifestIssue {
  message: string;
  line?: number;
  severity: 'error' | 'warning';
}

export interface ManifestValidation {
  ok: boolean;
  issues: ManifestIssue[];
  objects: KubeObject[];
}

/**
 * Parses and structurally validates YAML manifests before they are sent to the API server.
 * When `expected` is provided (editing an existing object), identity fields must not change.
 */
export function validateManifest(text: string, expected?: { apiVersion?: string; kind?: string; name: string; namespace?: string }): ManifestValidation {
  const issues: ManifestIssue[] = [];
  const objects: KubeObject[] = [];
  let docs;
  try {
    docs = parseAllDocuments(text, { prettyErrors: true });
  } catch (err) {
    return { ok: false, issues: [{ message: String(err), severity: 'error' }], objects };
  }
  const list = Array.isArray(docs) ? docs : [docs];
  for (const doc of list) {
    for (const err of doc.errors) {
      issues.push({ message: err.message.split('\n')[0], line: err.linePos?.[0]?.line, severity: 'error' });
    }
    if (doc.errors.length) continue;
    const value = doc.toJS();
    if (value === null || value === undefined) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ message: 'Each YAML document must be a mapping (object).', severity: 'error' });
      continue;
    }
    const obj = value as KubeObject;
    if (!obj.apiVersion || typeof obj.apiVersion !== 'string') issues.push({ message: 'Missing "apiVersion".', severity: 'error' });
    if (!obj.kind || typeof obj.kind !== 'string') issues.push({ message: 'Missing "kind".', severity: 'error' });
    if (!obj.metadata || typeof obj.metadata !== 'object') {
      issues.push({ message: 'Missing "metadata".', severity: 'error' });
    } else if (!obj.metadata.name && !(obj.metadata as any).generateName) {
      issues.push({ message: 'Missing "metadata.name".', severity: 'error' });
    } else if (obj.metadata.name && !isValidName(obj.metadata.name) && !/^[a-zA-Z0-9:._-]+$/.test(obj.metadata.name)) {
      issues.push({ message: `Invalid metadata.name "${obj.metadata.name}".`, severity: 'error' });
    }
    objects.push(obj);
  }
  if (objects.length === 0 && issues.length === 0) issues.push({ message: 'The document is empty.', severity: 'error' });

  if (expected) {
    if (objects.length !== 1) {
      issues.push({ message: 'Editing an existing resource requires exactly one YAML document.', severity: 'error' });
    } else {
      const o = objects[0];
      if (expected.kind && o.kind !== expected.kind) issues.push({ message: `kind cannot change (expected ${expected.kind}).`, severity: 'error' });
      if (o.metadata?.name !== expected.name) issues.push({ message: `metadata.name cannot change (expected ${expected.name}).`, severity: 'error' });
      if ((o.metadata?.namespace ?? undefined) !== (expected.namespace ?? undefined) && expected.namespace) {
        issues.push({ message: `metadata.namespace cannot change (expected ${expected.namespace}).`, severity: 'error' });
      }
      if (expected.apiVersion && o.apiVersion !== expected.apiVersion) {
        issues.push({ message: `apiVersion changed from ${expected.apiVersion} to ${o.apiVersion}.`, severity: 'warning' });
      }
    }
  }
  return { ok: !issues.some((i) => i.severity === 'error'), issues, objects };
}

/** Validates a port number from user input; returns an error message or null. */
export function validatePort(value: string | number, { allowZero = false } = {}): string | null {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return 'Port must contain only digits.';
  const n = Number(s);
  if (allowZero && n === 0) return null;
  if (n < 1 || n > 65535) return 'Port must be between 1 and 65535.';
  return null;
}

/** Validates replica count input for scaling. */
export function validateReplicas(value: string | number): string | null {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return 'Replicas must be a non-negative whole number.';
  if (Number(s) > 10000) return 'Replicas must be 10000 or fewer.';
  return null;
}
