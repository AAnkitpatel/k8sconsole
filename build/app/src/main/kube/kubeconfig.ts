import { KubeConfig } from '@kubernetes/client-node';
import { existsSync, mkdirSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { ClusterContext, KubeconfigSource } from '../../shared/types';

const MAX_KUBECONFIG_BYTES = 5 * 1024 * 1024;

export interface DiscoveryInput {
  home: string;
  envKubeconfig?: string;
  userFiles: string[];
  userFolders: string[];
  managedDir: string;
}

function isCandidateFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0 && st.size <= MAX_KUBECONFIG_BYTES;
  } catch {
    return false;
  }
}

function scanFolder(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => join(dir, f))
      .filter(isCandidateFile)
      .sort();
  } catch {
    return [];
  }
}

/** Collects kubeconfig files from all configured locations, de-duplicated by absolute path. */
export function discoverSources(input: DiscoveryInput): KubeconfigSource[] {
  const seen = new Map<string, KubeconfigSource>();
  const add = (p: string, origin: KubeconfigSource['origin']) => {
    const abs = resolve(p);
    if (!seen.has(abs)) seen.set(abs, { path: abs, origin });
  };
  const def = join(input.home, '.kube', 'config');
  if (isCandidateFile(def)) add(def, 'default');
  for (const p of (input.envKubeconfig ?? '').split(delimiter).filter(Boolean)) if (isCandidateFile(p)) add(p, 'env');
  for (const p of input.userFiles) {
    if (isCandidateFile(p)) add(p, 'user-file');
    else seen.set(resolve(p), { path: resolve(p), origin: 'user-file', error: 'File not found or not readable' });
  }
  for (const d of input.userFolders) for (const p of scanFolder(d)) add(p, 'user-folder');
  for (const p of scanFolder(input.managedDir)) add(p, 'managed');
  return [...seen.values()];
}

/** Describes how a user authenticates without revealing any secret material. */
export function describeAuth(user: ReturnType<KubeConfig['getUsers']>[number] | undefined): string {
  if (!user) return 'none';
  if (user.exec) return `exec: ${String(user.exec.command ?? 'plugin').split('/').pop()}`;
  if (user.authProvider) return `auth-provider: ${user.authProvider.name}`;
  if (user.certData || user.certFile) return 'client certificate';
  if (user.token || (user as any).tokenFile) return 'bearer token';
  if (user.username) return 'basic auth';
  return 'none';
}

export function loadKubeConfigFile(path: string): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromFile(path);
  return kc;
}

export function contextsFromSource(source: KubeconfigSource): { contexts: ClusterContext[]; error?: string } {
  if (source.error) return { contexts: [], error: source.error };
  try {
    const kc = loadKubeConfigFile(source.path);
    const contexts = kc.getContexts().map<ClusterContext>((ctx) => {
      const cluster = kc.getCluster(ctx.cluster);
      const user = kc.getUser(ctx.user);
      return {
        id: `${source.path}#${ctx.name}`,
        name: ctx.name,
        cluster: ctx.cluster,
        user: ctx.user,
        namespace: ctx.namespace,
        server: cluster?.server,
        sourcePath: source.path,
        origin: source.origin,
        isCurrentInFile: kc.getCurrentContext() === ctx.name,
        authMethod: describeAuth(user ?? undefined),
        insecureSkipTlsVerify: !!cluster?.skipTLSVerify,
      };
    });
    return { contexts };
  } catch (err) {
    return { contexts: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseContextId(id: string): { path: string; context: string } {
  const idx = id.lastIndexOf('#');
  if (idx <= 0) throw new Error('Invalid context id');
  return { path: id.slice(0, idx), context: id.slice(idx + 1) };
}

/** Loads the kubeconfig for a context id. The path must belong to a currently discovered source. */
export function kubeConfigForContext(id: string, sources: KubeconfigSource[]): KubeConfig {
  const { path, context } = parseContextId(id);
  if (!sources.some((s) => s.path === path && !s.error)) throw new Error('Kubeconfig file is not a known source');
  const kc = loadKubeConfigFile(path);
  if (!kc.getContextObject(context)) throw new Error(`Context "${context}" not found in ${path}`);
  kc.setCurrentContext(context);
  return kc;
}

/** Validates pasted kubeconfig YAML and stores it in the app-managed folder with private permissions. */
export function importKubeconfigYaml(yaml: string, name: string, managedDir: string): { path: string; contexts: number } {
  if (typeof yaml !== 'string' || yaml.length === 0) throw new Error('Kubeconfig is empty');
  if (yaml.length > MAX_KUBECONFIG_BYTES) throw new Error('Kubeconfig is too large');
  const kc = new KubeConfig();
  try {
    kc.loadFromString(yaml);
  } catch (err) {
    throw new Error(`Not a valid kubeconfig: ${err instanceof Error ? err.message : String(err)}`);
  }
  const contexts = kc.getContexts();
  if (contexts.length === 0) throw new Error('The kubeconfig does not define any contexts');
  for (const ctx of contexts) {
    if (!kc.getCluster(ctx.cluster)) throw new Error(`Context "${ctx.name}" references unknown cluster "${ctx.cluster}"`);
  }
  const safe = (name || 'imported').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported';
  mkdirSync(managedDir, { recursive: true, mode: 0o700 });
  let file = join(managedDir, `${safe}.yaml`);
  for (let i = 2; existsSync(file); i++) file = join(managedDir, `${safe}-${i}.yaml`);
  writeFileSync(file, yaml, { mode: 0o600, flag: 'wx' });
  return { path: file, contexts: contexts.length };
}

/** Watches kubeconfig files and folders and calls `onChange` (debounced). */
export class KubeconfigWatcher {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: (reason: string) => void) {}

  watchPaths(paths: string[]): void {
    this.close();
    for (const p of new Set(paths)) {
      if (!existsSync(p)) continue;
      try {
        const w = watch(p, { persistent: false }, () => this.trigger(p));
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        // Unwatchable paths are ignored; the user can refresh manually.
      }
    }
  }

  private trigger(path: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(`changed: ${path}`), 400);
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
