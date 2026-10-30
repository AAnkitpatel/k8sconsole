// Main-process services for the Platform features: GitOps, cost monitoring, image vulnerability scanning and extensions.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiResourceInfo, KubeObject, MonitorSnapshot, ResourceRef } from '../shared/types';
import { gitopsPatch, gitopsRefs, toGitOpsItem, type GitOpsAction, type GitOpsItem } from '../shared/gitops';
import { costReport, workloadOf, type CostPodInput, type CostPrices, type CostReport } from '../shared/cost';
import { fromOperatorReport, fromTrivyJson, imagesFromPods, isValidImageRef, sameImage, type ImageScan, type ImageUse } from '../shared/images';
import { runRules, validateManifest, type ExtFinding, type ExtensionManifest, type InstalledExtension } from '../shared/extensions';
import { isValidName, resourcePath } from '../shared/resources';
import { parseQuantity } from '../shared/format';
import { listResources } from './kube/resources';
import { KubeApiError, type KubeRest } from './kube/rest';
import { podResources } from './kube/monitor';
import { refFor } from './kube/inventory';

const MERGE = 'application/merge-patch+json';

async function listOrEmpty(rest: KubeRest, ref: ResourceRef | null, namespace: string | undefined, notes: string[], label: string): Promise<KubeObject[]> {
  if (!ref) return [];
  try {
    return (await listResources(rest, { resource: ref, namespace: ref.namespaced ? namespace : undefined })).items;
  } catch (err) {
    if (err instanceof KubeApiError && (err.code === 403 || err.code === 404)) {
      notes.push(`${label}: ${err.code === 403 ? 'not permitted' : 'not available'}`);
      return [];
    }
    throw err;
  }
}

// ---- GitOps ----

export async function listGitOps(rest: KubeRest, discovery: ApiResourceInfo[], namespace?: string): Promise<{ items: GitOpsItem[]; engines: string[]; notes: string[] }> {
  const notes: string[] = [];
  const refs = gitopsRefs(discovery);
  const lists = await Promise.all(refs.map(async (r) => (await listOrEmpty(rest, r.ref, namespace, notes, r.label)).map((o) => toGitOpsItem(o, r.ref))));
  return { items: lists.flat(), engines: [...new Set(refs.map((r) => r.engine))], notes };
}

export async function gitopsAction(rest: KubeRest, discovery: ApiResourceInfo[], ref: ResourceRef, namespace: string, name: string, action: GitOpsAction): Promise<void> {
  const known = gitopsRefs(discovery).find((r) => r.ref.apiVersion === ref.apiVersion && r.ref.plural === ref.plural);
  if (!known) throw new Error('Not a Flux or Argo CD resource served by this cluster');
  if (!isValidName(namespace) || !isValidName(name)) throw new Error('Invalid namespace or name');
  if (known.ref.kind === 'ApplicationSet') throw new Error('ApplicationSets have no actions; act on their Applications');
  await rest.request('PATCH', resourcePath(known.ref, namespace, name), { body: gitopsPatch(known.engine, action), contentType: MERGE, query: { fieldManager: 'k8sconsole' } });
}

// ---- Cost ----

export async function clusterCost(rest: KubeRest, discovery: ApiResourceInfo[], monitor: MonitorSnapshot | null, prices: CostPrices, namespace?: string): Promise<CostReport & { notes: string[]; usageSource?: string }> {
  const notes: string[] = [];
  const pods = (await listOrEmpty(rest, refFor(discovery, '', 'Pod'), namespace, notes, 'Pods')).filter((p) => p.status?.phase === 'Running' || p.status?.phase === 'Pending');
  const usage = new Map((monitor?.pods ?? []).map((p) => [`${p.namespace}/${p.name}`, p]));
  const inputs: CostPodInput[] = pods.map((p) => {
    const r = podResources(p);
    const u = usage.get(`${p.metadata.namespace}/${p.metadata.name}`);
    const peak = (xs: number[] | undefined) => (xs && xs.filter(Number.isFinite).length ? Math.max(...xs.filter(Number.isFinite)) : undefined);
    return {
      namespace: p.metadata.namespace ?? '',
      name: p.metadata.name,
      workload: workloadOf(p as any),
      cpuReqMillis: r.cpuReq,
      memReqBytes: r.memReq,
      cpuLimMillis: r.cpuLim,
      memLimBytes: r.memLim,
      cpuUseMillis: u?.cpuUsageMillis,
      memUseBytes: u?.memUsageBytes,
      cpuPeakMillis: peak(u?.spark.cpu) ?? u?.cpuUsageMillis,
      memPeakBytes: peak(u?.spark.mem) ?? u?.memUsageBytes,
    };
  });
  let capacity: { cpuMillis: number; memBytes: number } | undefined;
  if (!namespace) {
    const nodes = await listOrEmpty(rest, refFor(discovery, '', 'Node'), undefined, notes, 'Nodes');
    if (nodes.length)
      capacity = {
        cpuMillis: nodes.reduce((a, n) => a + (parseQuantity(n.status?.allocatable?.cpu) * 1000 || 0), 0),
        memBytes: nodes.reduce((a, n) => a + (parseQuantity(n.status?.allocatable?.memory) || 0), 0),
      };
  }
  const unpriced = inputs.filter((i) => i.cpuReqMillis === 0 && i.memReqBytes === 0 && i.cpuUseMillis === undefined).length;
  if (unpriced) notes.push(`${unpriced} pod${unpriced === 1 ? ' has' : 's have'} no CPU or memory requests, so ${unpriced === 1 ? 'it costs' : 'they cost'} nothing in this estimate until live usage is known.`);
  if (!monitor) notes.push('Open Monitor once to add live usage: idle cost and rightsizing need it.');
  return { ...costReport(inputs, prices, capacity), notes, usageSource: monitor?.source };
}

// ---- Image vulnerability scanning ----

export interface ImageInventory {
  images: Array<ImageUse & { scan?: ImageScan }>;
  operator: boolean;
  trivyPath: string | null;
  notes: string[];
}

/** Images running in the namespace (or cluster), joined with Trivy Operator reports when the operator is installed. */
export async function imageInventory(rest: KubeRest, discovery: ApiResourceInfo[], namespace: string | undefined, trivyPath: string | null, cached: Map<string, ImageScan>): Promise<ImageInventory> {
  const notes: string[] = [];
  const pods = await listOrEmpty(rest, refFor(discovery, '', 'Pod'), namespace, notes, 'Pods');
  const uses = imagesFromPods(pods.map((p) => ({ ...p, workload: workloadOf(p as any) })));
  const reportRef = refFor(discovery, 'aquasecurity.github.io', 'VulnerabilityReport');
  const reports = reportRef ? (await listOrEmpty(rest, reportRef, namespace, notes, 'Trivy Operator reports')).map(fromOperatorReport) : [];
  return {
    operator: !!reportRef,
    trivyPath,
    notes,
    images: uses.map((u) => ({ ...u, scan: cached.get(u.image) ?? reports.find((r) => sameImage(r.image, u.image)) })),
  };
}

/** Runs `trivy image` on one image (no shell; argument vector only). */
export function trivyScan(trivy: string, image: string, env: Record<string, string> = {}, timeoutMs = 15 * 60_000): Promise<ImageScan> {
  if (!isValidImageRef(image)) return Promise.reject(new Error('Invalid image reference'));
  return new Promise((resolve, reject) => {
    execFile(
      trivy,
      ['image', '--format', 'json', '--quiet', '--scanners', 'vuln', '--timeout', `${Math.round(timeoutMs / 60_000)}m`, '--', image],
      { env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`trivy failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
        try {
          resolve(fromTrivyJson(image, JSON.parse(stdout)));
        } catch (e) {
          reject(new Error(`Could not read trivy output: ${(e as Error).message}`));
        }
      },
    );
  });
}

// ---- Extensions ----

export class ExtensionStore {
  constructor(private readonly dir: string) {}

  list(disabled: string[]): { installed: InstalledExtension[]; errors: Array<{ path: string; errors: string[] }> } {
    const installed: InstalledExtension[] = [];
    const errors: Array<{ path: string; errors: string[] }> = [];
    if (!existsSync(this.dir)) return { installed, errors };
    for (const entry of readdirSync(this.dir).sort()) {
      const path = join(this.dir, entry, 'extension.json');
      if (!existsSync(path)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        errors.push({ path, errors: [`Invalid JSON: ${(err as Error).message}`] });
        continue;
      }
      const v = validateManifest(parsed);
      if (!v.ok) errors.push({ path, errors: v.errors });
      else if (v.manifest.id !== entry) errors.push({ path, errors: [`The folder name must match the id "${v.manifest.id}"`] });
      else installed.push({ manifest: v.manifest, enabled: !disabled.includes(v.manifest.id), path });
    }
    return { installed, errors };
  }

  enabled(disabled: string[]): ExtensionManifest[] {
    return this.list(disabled).installed.filter((e) => e.enabled).map((e) => e.manifest);
  }

  /** Validates and installs a manifest (replacing an installed version with the same id). */
  install(json: string): ExtensionManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }
    const v = validateManifest(parsed);
    if (!v.ok) throw new Error(`Invalid extension:\n- ${v.errors.join('\n- ')}`);
    const target = join(this.dir, v.manifest.id);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'extension.json'), JSON.stringify(v.manifest, null, 2) + '\n', { mode: 0o600 });
    return v.manifest;
  }

  remove(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('Invalid extension id');
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  get folder(): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return this.dir;
  }
}

/** Evaluates enabled extensions' rules against the kinds they target in a namespace (or the whole cluster). */
export async function extensionFindings(rest: KubeRest, discovery: ApiResourceInfo[], extensions: ExtensionManifest[], namespace?: string): Promise<{ findings: ExtFinding[]; notes: string[] }> {
  const notes: string[] = [];
  const kinds = [...new Set(extensions.flatMap((e) => e.rules.flatMap((r) => r.kinds)))];
  const objects: KubeObject[] = [];
  for (const kind of kinds) {
    const d = discovery.find((x) => x.kind === kind && x.verbs.includes('list'));
    if (!d) {
      notes.push(`${kind}: not served by this cluster`);
      continue;
    }
    const items = await listOrEmpty(rest, { apiVersion: d.apiVersion, kind: d.kind, plural: d.plural, namespaced: d.namespaced }, namespace, notes, kind);
    objects.push(...items.map((o) => ({ ...o, kind: d.kind })));
  }
  return { findings: runRules(extensions, objects), notes };
}
