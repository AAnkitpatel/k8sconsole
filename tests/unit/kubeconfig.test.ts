import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { contextsFromSource, discoverSources, importKubeconfigYaml, kubeConfigForContext, parseContextId } from '../../build/app/src/main/kube/kubeconfig';
import { SettingsStore, sanitizeSettings } from '../../build/app/src/main/settings';

export function kubeconfigYaml(opts: { server?: string; contexts?: string[]; token?: string; current?: string } = {}): string {
  const ctxs = opts.contexts ?? ['dev'];
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: c1',
    '  cluster:',
    `    server: ${opts.server ?? 'https://127.0.0.1:6443'}`,
    '    insecure-skip-tls-verify: true',
    'users:',
    '- name: u-token',
    '  user:',
    `    token: ${opts.token ?? 'SUPER-SECRET-TOKEN'}`,
    '- name: u-exec',
    '  user:',
    '    exec:',
    '      apiVersion: client.authentication.k8s.io/v1',
    '      command: /usr/local/bin/aws',
    '      args: [eks, get-token]',
    'contexts:',
    ...ctxs.flatMap((c, i) => [`- name: ${c}`, '  context:', '    cluster: c1', `    user: ${i % 2 ? 'u-exec' : 'u-token'}`, '    namespace: team-a']),
    `current-context: ${opts.current ?? ctxs[0]}`,
    '',
  ].join('\n');
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'k8sc-kc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('discoverSources', () => {
  it('collects default, env, user files, folders and managed files without duplicates', () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.kube'), { recursive: true });
    writeFileSync(join(home, '.kube', 'config'), kubeconfigYaml());
    const envFile = join(dir, 'env.yaml');
    writeFileSync(envFile, kubeconfigYaml());
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.yaml'), kubeconfigYaml());
    writeFileSync(join(folder, '.hidden'), kubeconfigYaml());
    const managed = join(dir, 'managed');
    mkdirSync(managed);
    writeFileSync(join(managed, 'm.yaml'), kubeconfigYaml());

    const sources = discoverSources({
      home,
      envKubeconfig: [envFile, join(home, '.kube', 'config'), join(dir, 'missing')].join(delimiter),
      userFiles: [envFile, join(dir, 'gone.yaml')],
      userFolders: [folder],
      managedDir: managed,
    });
    const byOrigin = Object.fromEntries(sources.map((s) => [s.path.replace(dir, '').replaceAll('\\', '/'), s.origin]));
    expect(byOrigin).toEqual({
      '/home/.kube/config': 'default',
      '/env.yaml': 'env',
      '/gone.yaml': 'user-file',
      '/folder/a.yaml': 'user-folder',
      '/managed/m.yaml': 'managed',
    });
    expect(sources.find((s) => s.path.endsWith('gone.yaml'))?.error).toBeTruthy();
  });
});

describe('contextsFromSource', () => {
  it('lists contexts with auth method descriptions and never exposes secrets', () => {
    const f = join(dir, 'kc.yaml');
    writeFileSync(f, kubeconfigYaml({ contexts: ['dev', 'prod'] }));
    const { contexts, error } = contextsFromSource({ path: f, origin: 'user-file' });
    expect(error).toBeUndefined();
    expect(contexts.map((c) => [c.name, c.authMethod, c.isCurrentInFile, c.namespace])).toEqual([
      ['dev', 'bearer token', true, 'team-a'],
      ['prod', 'exec: aws', false, 'team-a'],
    ]);
    expect(contexts[0].id).toBe(`${f}#dev`);
    expect(contexts[0].insecureSkipTlsVerify).toBe(true);
    expect(JSON.stringify(contexts)).not.toContain('SUPER-SECRET-TOKEN');
  });
  it('reports parse errors instead of throwing', () => {
    const f = join(dir, 'bad.yaml');
    writeFileSync(f, 'this: [is not: valid');
    const r = contextsFromSource({ path: f, origin: 'user-file' });
    expect(r.contexts).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});

describe('kubeConfigForContext', () => {
  it('loads only files that are known sources and selects the context', () => {
    const f = join(dir, 'kc.yaml');
    writeFileSync(f, kubeconfigYaml({ contexts: ['dev', 'prod'] }));
    const kc = kubeConfigForContext(`${f}#prod`, [{ path: f, origin: 'user-file' }]);
    expect(kc.getCurrentContext()).toBe('prod');
    expect(() => kubeConfigForContext(`${f}#prod`, [])).toThrow(/not a known source/);
    expect(() => kubeConfigForContext(`${f}#nope`, [{ path: f, origin: 'user-file' }])).toThrow(/not found/);
    expect(() => parseContextId('no-hash')).toThrow();
    expect(parseContextId('/a/b#c#d')).toEqual({ path: '/a/b#c', context: 'd' });
  });
});

describe('importKubeconfigYaml', () => {
  it('stores a valid kubeconfig with 0600 permissions and a safe unique name', () => {
    const managed = join(dir, 'managed');
    const a = importKubeconfigYaml(kubeconfigYaml(), '../../Evil Name!', managed);
    const b = importKubeconfigYaml(kubeconfigYaml(), '../../Evil Name!', managed);
    expect(a.path).toBe(join(managed, 'evil-name.yaml'));
    expect(b.path).toBe(join(managed, 'evil-name-2.yaml'));
    if (process.platform !== 'win32') expect(statSync(a.path).mode & 0o777).toBe(0o600);
    expect(a.contexts).toBe(1);
  });
  it('rejects invalid kubeconfigs', () => {
    const managed = join(dir, 'managed');
    expect(() => importKubeconfigYaml('', 'x', managed)).toThrow();
    expect(() => importKubeconfigYaml('apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\n', 'x', managed)).toThrow(/does not define any contexts/);
    expect(() => importKubeconfigYaml('apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts:\n- name: a\n  context: {cluster: missing, user: u}\n', 'x', managed)).toThrow(/unknown cluster/);
  });
});

describe('settings', () => {
  it('sanitizes untrusted values', () => {
    const s = sanitizeSettings({ theme: 'neon', logTailLines: -5, kubeconfigFiles: ['a', 3, 'a', ''], lastNamespaces: { x: 'ns', y: 4 }, unknown: true });
    expect(s.theme).toBe('dark');
    expect(s.logTailLines).toBe(500);
    expect(s.kubeconfigFiles).toEqual(['a']);
    expect(s.lastNamespaces).toEqual({ x: 'ns' });
    expect((s as any).unknown).toBeUndefined();
  });
  it('persists atomically with private permissions', () => {
    const file = join(dir, 'cfg', 'settings.json');
    const store = new SettingsStore(file);
    store.update({ theme: 'light', logTailLines: 1000 });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).theme).toBe('light');
    expect(new SettingsStore(file).get().logTailLines).toBe(1000);
  });
  it('recovers from a corrupt settings file', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{not json');
    expect(new SettingsStore(file).get().theme).toBe('dark');
  });
});
