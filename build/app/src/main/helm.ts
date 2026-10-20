import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidName } from '../shared/resources';
import type { HelmChartVersion, HelmHistoryEntry, HelmInstallRequest, HelmInstallResult, HelmRelease, HelmRepo } from '../shared/types';

export { findExecutable } from './executables';

const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function assertRelease(namespace: string, release: string) {
  if (!isValidName(namespace) || !RELEASE_NAME.test(release) || release.length > 53) throw new Error('Invalid namespace or release name');
}

const REPO_NAME = /^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/i;
const CHART_REF = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|oci:\/\/[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+)$/i;
const VERSION = /^[0-9A-Za-z.+~^<>=*|, -]{1,64}$/;

export function assertChartRef(chart: string): void {
  if (!CHART_REF.test(chart)) throw new Error('Chart must be "repo/chart" or an oci:// reference');
}

export function assertRepo(name: string, url?: string): void {
  if (!REPO_NAME.test(name) || name.length > 63) throw new Error('Invalid repository name');
  if (url !== undefined) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'oci:') throw new Error('Repository URL must be https://, http:// or oci://');
  }
}

export function assertVersion(v: string | undefined): void {
  if (v && !VERSION.test(v)) throw new Error('Invalid chart version');
}

export interface HelmTarget {
  kubeconfigPath: string;
  context: string;
}

/** Runs the helm CLI without a shell. The context is passed explicitly so the user's current-context is never changed. */
export class HelmClient {
  constructor(
    private readonly binary: string,
    private readonly target: HelmTarget,
    private readonly timeoutMs = 120000,
  ) {}

  run(args: string[]): Promise<string> {
    const full = [...args, '--kubeconfig', this.target.kubeconfigPath, '--kube-context', this.target.context];
    return new Promise((resolve, reject) => {
      execFile(this.binary, full, { timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HELM_NO_PLUGINS: '1' } }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).toString().trim().slice(0, 2000)));
        else resolve(stdout.toString());
      });
    });
  }

  async version(): Promise<string> {
    return (await new Promise<string>((resolve, reject) =>
      execFile(this.binary, ['version', '--short'], { timeout: 10000 }, (err, out) => (err ? reject(err) : resolve(out.toString()))),
    )).trim();
  }

  async list(namespace?: string): Promise<HelmRelease[]> {
    if (namespace && !isValidName(namespace)) throw new Error('Invalid namespace');
    const out = await this.run(['list', '--output', 'json', '--max', '0', ...(namespace ? ['--namespace', namespace] : ['--all-namespaces'])]);
    return out.trim() ? (JSON.parse(out) as HelmRelease[]) : [];
  }

  async history(namespace: string, release: string): Promise<HelmHistoryEntry[]> {
    assertRelease(namespace, release);
    return JSON.parse(await this.run(['history', release, '--namespace', namespace, '--output', 'json']));
  }

  values(namespace: string, release: string, all: boolean): Promise<string> {
    assertRelease(namespace, release);
    return this.run(['get', 'values', release, '--namespace', namespace, '--output', 'yaml', ...(all ? ['--all'] : [])]);
  }

  manifest(namespace: string, release: string): Promise<string> {
    assertRelease(namespace, release);
    return this.run(['get', 'manifest', release, '--namespace', namespace]);
  }

  async rollback(namespace: string, release: string, revision: number): Promise<void> {
    assertRelease(namespace, release);
    if (!Number.isInteger(revision) || revision < 1) throw new Error('Invalid revision');
    await this.run(['rollback', release, String(revision), '--namespace', namespace, '--wait=false']);
  }

  async repos(): Promise<HelmRepo[]> {
    try {
      const out = await this.run(['repo', 'list', '--output', 'json']);
      return out.trim() ? JSON.parse(out) : [];
    } catch (err) {
      // helm exits non-zero when no repositories are configured.
      if (/no repositories/i.test(String((err as Error).message))) return [];
      throw err;
    }
  }

  async repoAdd(name: string, url: string): Promise<void> {
    assertRepo(name, url);
    await this.run(['repo', 'add', name, url, '--force-update']);
  }

  async repoRemove(name: string): Promise<void> {
    assertRepo(name);
    await this.run(['repo', 'remove', name]);
  }

  async repoUpdate(): Promise<string> {
    return this.run(['repo', 'update']);
  }

  async search(query: string, allVersions = false): Promise<HelmChartVersion[]> {
    const q = String(query ?? '').trim();
    if (q.length > 128 || /[^\w./ -]/.test(q)) throw new Error('Invalid search text');
    const out = await this.run(['search', 'repo', ...(q ? [q] : []), '--output', 'json', ...(allVersions ? ['--versions'] : [])]);
    return out.trim() ? JSON.parse(out) : [];
  }

  async showReadme(chart: string, version?: string): Promise<string> {
    assertChartRef(chart);
    assertVersion(version);
    return this.run(['show', 'readme', chart, ...(version ? ['--version', version] : [])]);
  }

  async showValues(chart: string, version?: string): Promise<string> {
    assertChartRef(chart);
    assertVersion(version);
    return this.run(['show', 'values', chart, ...(version ? ['--version', version] : [])]);
  }

  /** helm install / upgrade with values from a private temp file; dryRun renders server-side without changing the cluster. */
  async installOrUpgrade(mode: 'install' | 'upgrade', req: HelmInstallRequest): Promise<HelmInstallResult> {
    assertRelease(req.namespace, req.release);
    assertChartRef(req.chart);
    assertVersion(req.version);
    const dir = mkdtempSync(join(tmpdir(), 'k8sc-helm-values-'));
    try {
      const valuesFile = join(dir, 'values.yaml');
      writeFileSync(valuesFile, req.values ?? '', { mode: 0o600 });
      const args = [mode, req.release, req.chart, '--namespace', req.namespace, '--values', valuesFile, '--output', 'json'];
      if (req.version) args.push('--version', req.version);
      if (mode === 'install' && req.createNamespace) args.push('--create-namespace');
      if (mode === 'upgrade' && req.reuseValues) args.push('--reuse-values');
      if (req.dryRun) args.push('--dry-run=server');
      const out = JSON.parse(await this.run(args));
      return { release: out.name, namespace: out.namespace, revision: out.version, status: out.info?.status ?? '', notes: out.info?.notes ?? '', manifest: out.manifest ?? '', dryRun: !!req.dryRun };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async uninstall(namespace: string, release: string): Promise<void> {
    assertRelease(namespace, release);
    await this.run(['uninstall', release, '--namespace', namespace]);
  }
}
