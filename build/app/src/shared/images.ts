// Image vulnerability scanning: Trivy Operator reports (read from the cluster) and Trivy CLI results in one shape.

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

export interface ImageVuln {
  id: string;
  pkg: string;
  installed: string;
  fixed?: string;
  severity: Severity;
  title?: string;
  url?: string;
  score?: number;
}

export interface ImageScan {
  image: string;
  source: 'trivy-operator' | 'trivy';
  scannedAt?: string;
  counts: Record<Severity, number>;
  /** How many vulnerabilities have a fixed version available. */
  fixable: number;
  vulns: ImageVuln[];
  error?: string;
}

/** Where an image runs: Kubernetes workloads/containers or ECS task definitions. */
export interface ImageUse {
  image: string;
  usedBy: string[];
}

/** Image references: registry/repo[:tag][@sha256:digest], no spaces or shell characters. */
export const isValidImageRef = (s: unknown): s is string => typeof s === 'string' && s.length <= 512 && /^[a-z0-9][a-z0-9._\-/:@]*$/i.test(s) && !s.includes('..') && !s.startsWith('-');

const sev = (s: unknown): Severity => (SEVERITIES.includes(String(s).toUpperCase() as Severity) ? (String(s).toUpperCase() as Severity) : 'UNKNOWN');
const emptyCounts = (): Record<Severity, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
const order = (a: ImageVuln, b: ImageVuln) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id);

function finish(image: string, source: ImageScan['source'], vulns: ImageVuln[], scannedAt?: string): ImageScan {
  const seen = new Set<string>();
  const unique = vulns.filter((v) => {
    const k = `${v.id}|${v.pkg}|${v.installed}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const counts = emptyCounts();
  for (const v of unique) counts[v.severity]++;
  return { image, source, scannedAt, counts, fixable: unique.filter((v) => v.fixed).length, vulns: unique.sort(order) };
}

/** A Trivy Operator VulnerabilityReport (aquasecurity.github.io/v1alpha1). */
export function fromOperatorReport(r: any): ImageScan {
  const rep = r?.report ?? {};
  const a = rep.artifact ?? {};
  const server = rep.registry?.server;
  const repo = a.repository ?? '';
  const image = `${server && server !== 'index.docker.io' ? `${server}/` : ''}${repo}${a.tag ? `:${a.tag}` : ''}${!a.tag && a.digest ? `@${a.digest}` : ''}`;
  const vulns: ImageVuln[] = (rep.vulnerabilities ?? []).map((v: any) => ({
    id: String(v.vulnerabilityID ?? ''),
    pkg: String(v.resource ?? ''),
    installed: String(v.installedVersion ?? ''),
    fixed: v.fixedVersion || undefined,
    severity: sev(v.severity),
    title: v.title || undefined,
    url: v.primaryLink || undefined,
    score: typeof v.score === 'number' ? v.score : undefined,
  }));
  return finish(image, 'trivy-operator', vulns, rep.updateTimestamp ?? r?.metadata?.creationTimestamp);
}

/** `trivy image --format json` output. */
export function fromTrivyJson(image: string, j: any): ImageScan {
  const vulns: ImageVuln[] = [];
  for (const res of j?.Results ?? []) {
    for (const v of res?.Vulnerabilities ?? []) {
      const cvss = v.CVSS ? Object.values(v.CVSS as Record<string, any>).map((c) => c?.V3Score ?? c?.V2Score).find((x) => typeof x === 'number') : undefined;
      vulns.push({ id: String(v.VulnerabilityID ?? ''), pkg: String(v.PkgName ?? ''), installed: String(v.InstalledVersion ?? ''), fixed: v.FixedVersion || undefined, severity: sev(v.Severity), title: v.Title || undefined, url: v.PrimaryURL || undefined, score: cvss as number | undefined });
    }
  }
  return finish(image, 'trivy', vulns, j?.CreatedAt);
}

/** Images used by pods (containers and init containers), with the workloads that run them. */
export function imagesFromPods(pods: Array<{ metadata: { namespace?: string; name: string }; spec?: any; workload?: string }>): ImageUse[] {
  const m = new Map<string, Set<string>>();
  for (const p of pods) {
    for (const c of [...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? []), ...(p.spec?.ephemeralContainers ?? [])]) {
      if (!c?.image) continue;
      const who = `${p.metadata.namespace ? `${p.metadata.namespace}/` : ''}${p.workload ?? `Pod/${p.metadata.name}`}`;
      (m.get(c.image) ?? m.set(c.image, new Set()).get(c.image)!).add(who);
    }
  }
  return [...m].map(([image, s]) => ({ image, usedBy: [...s].sort() })).sort((a, b) => a.image.localeCompare(b.image));
}

/** Matches scans to images; operator reports are keyed by repository and tag, so digests and registry prefixes are tolerated. */
export function sameImage(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^docker\.io\//, '').replace(/^library\//, '').replace(/@sha256:[a-f0-9]+$/, '').replace(/:latest$/, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`) || (x.includes(':') ? x : `${x}:latest`) === (y.includes(':') ? y : `${y}:latest`);
}

export function totalCounts(scans: ImageScan[]): Record<Severity, number> {
  const c = emptyCounts();
  for (const s of scans) for (const k of SEVERITIES) c[k] += s.counts[k];
  return c;
}
