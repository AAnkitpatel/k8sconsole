import { describe, expect, it } from 'vitest';
import { validateManifest, validatePort, validateReplicas } from '../../build/app/src/shared/validation';
import { isValidName, resourcePath, splitApiVersion, RESOURCE_CATALOG } from '../../build/app/src/shared/resources';

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const v = validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  a: b\n');
    expect(v.ok).toBe(true);
    expect(v.objects[0].kind).toBe('ConfigMap');
  });
  it('accepts multiple documents and skips empty ones', () => {
    const v = validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: b}\n');
    expect(v.ok).toBe(true);
    expect(v.objects.map((o) => o.kind)).toEqual(['ConfigMap', 'Secret']);
  });
  it('reports YAML syntax errors with a line number', () => {
    const v = validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: [unclosed\n');
    expect(v.ok).toBe(false);
    expect(v.issues[0].line).toBeGreaterThan(0);
  });
  it('requires apiVersion, kind and metadata.name', () => {
    const v = validateManifest('foo: bar\n');
    expect(v.ok).toBe(false);
    const msgs = v.issues.map((i) => i.message).join(' ');
    expect(msgs).toContain('apiVersion');
    expect(msgs).toContain('kind');
    expect(msgs).toContain('metadata');
  });
  it('accepts generateName instead of name', () => {
    expect(validateManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: x-\n').ok).toBe(true);
  });
  it('rejects non-mapping documents and empty input', () => {
    expect(validateManifest('- a\n- b\n').ok).toBe(false);
    expect(validateManifest('').ok).toBe(false);
  });
  it('blocks identity changes when editing an existing object', () => {
    const exp = { kind: 'ConfigMap', name: 'x', namespace: 'ns' };
    expect(validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x, namespace: ns}\n', exp).ok).toBe(true);
    expect(validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: y, namespace: ns}\n', exp).ok).toBe(false);
    expect(validateManifest('apiVersion: v1\nkind: Secret\nmetadata: {name: x, namespace: ns}\n', exp).ok).toBe(false);
    expect(validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x, namespace: other}\n', exp).ok).toBe(false);
    expect(validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x, namespace: ns}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: z}\n', exp).ok).toBe(false);
  });
  it('rejects invalid names', () => {
    expect(validateManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: "../../etc"}\n').ok).toBe(false);
  });
});

describe('port and replica validation', () => {
  it('validates ports', () => {
    expect(validatePort('8080')).toBeNull();
    expect(validatePort(65535)).toBeNull();
    expect(validatePort('0')).not.toBeNull();
    expect(validatePort('0', { allowZero: true })).toBeNull();
    expect(validatePort('65536')).not.toBeNull();
    expect(validatePort('80a')).not.toBeNull();
    expect(validatePort('-1')).not.toBeNull();
  });
  it('validates replicas', () => {
    expect(validateReplicas('0')).toBeNull();
    expect(validateReplicas('3')).toBeNull();
    expect(validateReplicas('-1')).not.toBeNull();
    expect(validateReplicas('1.5')).not.toBeNull();
    expect(validateReplicas('20000')).not.toBeNull();
  });
});

describe('resourcePath', () => {
  const pods = { apiVersion: 'v1', plural: 'pods', namespaced: true };
  const deploys = { apiVersion: 'apps/v1', plural: 'deployments', namespaced: true };
  const nodes = { apiVersion: 'v1', plural: 'nodes', namespaced: false };
  it('builds core, group, namespaced and cluster-scoped paths', () => {
    expect(resourcePath(pods)).toBe('/api/v1/pods');
    expect(resourcePath(pods, 'default')).toBe('/api/v1/namespaces/default/pods');
    expect(resourcePath(pods, 'default', 'web-1', 'log')).toBe('/api/v1/namespaces/default/pods/web-1/log');
    expect(resourcePath(deploys, 'prod', 'api', 'scale')).toBe('/apis/apps/v1/namespaces/prod/deployments/api/scale');
    expect(resourcePath(nodes, 'ignored', 'n1')).toBe('/api/v1/nodes/n1');
  });
  it('allows RBAC-style names with colons', () => {
    expect(resourcePath({ apiVersion: 'rbac.authorization.k8s.io/v1', plural: 'clusterroles', namespaced: false }, undefined, 'system:controller:x')).toContain('system%3Acontroller%3Ax');
  });
  it('rejects path traversal and malformed input', () => {
    expect(() => resourcePath(pods, '../kube-system')).toThrow();
    expect(() => resourcePath(pods, 'default', '../../secrets')).toThrow();
    expect(() => resourcePath({ ...pods, plural: 'pods/../../x' })).toThrow();
    expect(() => resourcePath({ ...pods, apiVersion: '../v1' })).toThrow();
    expect(() => resourcePath(pods, 'default', 'p', 'attach-anything')).toThrow();
  });
  it('splits api versions and validates names', () => {
    expect(splitApiVersion('v1')).toEqual({ group: '', version: 'v1' });
    expect(splitApiVersion('apps/v1')).toEqual({ group: 'apps', version: 'v1' });
    expect(isValidName('web-1.example')).toBe(true);
    expect(isValidName('Web')).toBe(false);
    expect(isValidName('')).toBe(false);
  });
  it('has a consistent catalog', () => {
    const keys = RESOURCE_CATALOG.map((c) => `${c.apiVersion}/${c.plural}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of RESOURCE_CATALOG) expect(() => resourcePath(c, c.namespaced ? 'default' : undefined)).not.toThrow();
  });
});
