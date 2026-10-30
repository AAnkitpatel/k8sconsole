// Cost monitoring: estimated spend from resource requests and live usage, idle cost, and rightsizing suggestions.
// Prices are per vCPU-hour and per GiB-hour and editable in Settings; estimates, not a bill.

export const HOURS_PER_MONTH = 730;

export interface CostPrices {
  cpuHour: number;
  memGiBHour: number;
  currency: string;
}

/** AWS Fargate (Linux/x86, us-east-1) on-demand rates: a neutral, published reference for both Kubernetes and ECS. */
export const DEFAULT_PRICES: CostPrices = { cpuHour: 0.04048, memGiBHour: 0.004445, currency: 'USD' };

const GIB = 1024 ** 3;

export interface CostPodInput {
  namespace: string;
  name: string;
  /** e.g. "Deployment/web", "StatefulSet/db", "Pod/debug". */
  workload: string;
  cpuReqMillis: number;
  memReqBytes: number;
  cpuLimMillis?: number;
  memLimBytes?: number;
  cpuUseMillis?: number;
  memUseBytes?: number;
  /** Highest recent usage, for rightsizing. */
  cpuPeakMillis?: number;
  memPeakBytes?: number;
}

export interface CostLine {
  key: string;
  /** Monthly cost of what is reserved: max(request, usage) per resource. */
  monthly: number;
  cpuMonthly: number;
  memMonthly: number;
  /** Monthly cost of requested-but-unused capacity. */
  idleMonthly: number;
  cpuReqMillis: number;
  memReqBytes: number;
  cpuUseMillis?: number;
  memUseBytes?: number;
  pods: number;
}

export interface Rightsizing {
  workload: string;
  namespace: string;
  resource: 'cpu' | 'memory';
  kind: 'over-provisioned' | 'under-provisioned' | 'no-request';
  current: number;
  suggested: number;
  /** Positive = saving per month, negative = extra cost. */
  monthlyDelta: number;
  reason: string;
}

export interface CostReport {
  prices: CostPrices;
  hasUsage: boolean;
  total: CostLine;
  byNamespace: CostLine[];
  byWorkload: Array<CostLine & { namespace: string; workload: string }>;
  /** Cluster capacity cost (allocatable) and how much of it is requested. */
  capacity?: { monthly: number; allocatedMonthly: number; unallocatedMonthly: number };
  recommendations: Rightsizing[];
}

export const cpuMonthly = (millis: number, p: CostPrices) => (millis / 1000) * p.cpuHour * HOURS_PER_MONTH;
export const memMonthly = (bytes: number, p: CostPrices) => (bytes / GIB) * p.memGiBHour * HOURS_PER_MONTH;

function line(key: string, pods: CostPodInput[], p: CostPrices): CostLine {
  let cpuM = 0;
  let memM = 0;
  let idle = 0;
  let cpuReq = 0;
  let memReq = 0;
  let cpuUse = 0;
  let memUse = 0;
  let hasUse = false;
  for (const pod of pods) {
    const cu = pod.cpuUseMillis;
    const mu = pod.memUseBytes;
    cpuReq += pod.cpuReqMillis;
    memReq += pod.memReqBytes;
    if (cu !== undefined || mu !== undefined) hasUse = true;
    cpuUse += cu ?? 0;
    memUse += mu ?? 0;
    cpuM += cpuMonthly(Math.max(pod.cpuReqMillis, cu ?? 0), p);
    memM += memMonthly(Math.max(pod.memReqBytes, mu ?? 0), p);
    if (cu !== undefined) idle += cpuMonthly(Math.max(0, pod.cpuReqMillis - cu), p);
    if (mu !== undefined) idle += memMonthly(Math.max(0, pod.memReqBytes - mu), p);
  }
  return { key, monthly: cpuM + memM, cpuMonthly: cpuM, memMonthly: memM, idleMonthly: idle, cpuReqMillis: cpuReq, memReqBytes: memReq, cpuUseMillis: hasUse ? cpuUse : undefined, memUseBytes: hasUse ? memUse : undefined, pods: pods.length };
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    (m.get(k) ?? m.set(k, []).get(k)!).push(x);
  }
  return m;
}

const roundCpu = (m: number) => Math.max(10, Math.ceil(m / 10) * 10);
const roundMem = (b: number) => Math.max(16 * 1024 ** 2, Math.ceil(b / (16 * 1024 ** 2)) * 16 * 1024 ** 2);

/** Suggestions per workload, from its pods' peak usage with 30% headroom. Needs usage data. */
export function rightsize(pods: CostPodInput[], p: CostPrices): Rightsizing[] {
  const out: Rightsizing[] = [];
  for (const [k, group] of groupBy(pods, (x) => `${x.namespace}\u0000${x.workload}`)) {
    const [namespace, workload] = k.split('\u0000');
    const withUse = group.filter((x) => x.cpuPeakMillis !== undefined || x.cpuUseMillis !== undefined);
    if (!withUse.length) continue;
    const n = group.length;
    const req = { cpu: Math.max(...group.map((x) => x.cpuReqMillis)), mem: Math.max(...group.map((x) => x.memReqBytes)) };
    const peak = {
      cpu: Math.max(...withUse.map((x) => x.cpuPeakMillis ?? x.cpuUseMillis ?? 0)),
      mem: Math.max(...withUse.map((x) => x.memPeakBytes ?? x.memUseBytes ?? 0)),
    };
    const want = { cpu: roundCpu(peak.cpu * 1.3), mem: roundMem(peak.mem * 1.3) };
    for (const r of ['cpu', 'memory'] as const) {
      const cur = r === 'cpu' ? req.cpu : req.mem;
      const sug = r === 'cpu' ? want.cpu : want.mem;
      const price = (v: number) => (r === 'cpu' ? cpuMonthly(v, p) : memMonthly(v, p)) * n;
      const pk = r === 'cpu' ? peak.cpu : peak.mem;
      if (cur === 0) {
        if (pk > 0) out.push({ workload, namespace, resource: r, kind: 'no-request', current: 0, suggested: sug, monthlyDelta: -price(sug), reason: `No ${r} request: the scheduler can't plan for it and it is evicted first under pressure.` });
      } else if (pk < cur * 0.5 && cur - sug > (r === 'cpu' ? 20 : 32 * 1024 ** 2)) {
        out.push({ workload, namespace, resource: r, kind: 'over-provisioned', current: cur, suggested: sug, monthlyDelta: price(cur) - price(sug), reason: `Peak ${r} use is ${Math.round((pk / cur) * 100)}% of the request.` });
      } else if (pk > cur * 1.1) {
        out.push({ workload, namespace, resource: r, kind: 'under-provisioned', current: cur, suggested: sug, monthlyDelta: price(cur) - price(sug), reason: `Peak ${r} use is ${Math.round((pk / cur) * 100)}% of the request, so the node may be overcommitted.` });
      }
    }
  }
  return out.sort((a, b) => b.monthlyDelta - a.monthlyDelta);
}

export function costReport(pods: CostPodInput[], p: CostPrices, capacity?: { cpuMillis: number; memBytes: number }): CostReport {
  const total = line('total', pods, p);
  const byNamespace = [...groupBy(pods, (x) => x.namespace)].map(([ns, g]) => line(ns, g, p)).sort((a, b) => b.monthly - a.monthly);
  const byWorkload = [...groupBy(pods, (x) => `${x.namespace}/${x.workload}`)]
    .map(([k, g]) => ({ ...line(k, g, p), namespace: g[0].namespace, workload: g[0].workload }))
    .sort((a, b) => b.monthly - a.monthly);
  const report: CostReport = { prices: p, hasUsage: total.cpuUseMillis !== undefined, total, byNamespace, byWorkload, recommendations: rightsize(pods, p) };
  if (capacity) {
    const monthly = cpuMonthly(capacity.cpuMillis, p) + memMonthly(capacity.memBytes, p);
    const allocatedMonthly = cpuMonthly(total.cpuReqMillis, p) + memMonthly(total.memReqBytes, p);
    report.capacity = { monthly, allocatedMonthly, unallocatedMonthly: Math.max(0, monthly - allocatedMonthly) };
  }
  return report;
}

/** "Deployment/web" for pods owned through a ReplicaSet (by its pod-template-hash), else the direct owner. */
export function workloadOf(pod: { metadata: { name: string; labels?: Record<string, string>; ownerReferences?: Array<{ kind: string; name: string; controller?: boolean }> } }): string {
  const owner = pod.metadata.ownerReferences?.find((o) => o.controller) ?? pod.metadata.ownerReferences?.[0];
  if (!owner) return `Pod/${pod.metadata.name}`;
  const hash = pod.metadata.labels?.['pod-template-hash'];
  if (owner.kind === 'ReplicaSet' && hash && owner.name.endsWith(`-${hash}`)) return `Deployment/${owner.name.slice(0, -hash.length - 1)}`;
  if (owner.kind === 'Job' && /-\d{8,}$/.test(owner.name)) return `CronJob/${owner.name.replace(/-\d{8,}$/, '')}`;
  return `${owner.kind}/${owner.name}`;
}

// ---- Amazon ECS (Fargate) ----

export interface EcsCostService {
  service: string;
  launchType?: string;
  running: number;
  /** Task size in CPU units (1024 = 1 vCPU) and MiB. */
  cpuUnits: number;
  memMiB: number;
  /** Average utilization (percent of reserved) from CloudWatch, when known. */
  cpuPct?: number;
  memPct?: number;
}

export interface EcsCostLine extends EcsCostService {
  monthly: number;
  idleMonthly?: number;
  suggestion?: string;
}

const FARGATE_CPU = [256, 512, 1024, 2048, 4096, 8192, 16384];
/** Valid Fargate memory (MiB) for a CPU size. */
function fargateMemFor(cpu: number): number[] {
  const gib = (a: number, b: number, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => (a + i * step) * 1024);
  switch (cpu) {
    case 256: return [512, 1024, 2048];
    case 512: return gib(1, 4);
    case 1024: return gib(2, 8);
    case 2048: return gib(4, 16);
    case 4096: return gib(8, 30);
    case 8192: return gib(16, 60, 4);
    default: return gib(32, 120, 8);
  }
}

/** Monthly Fargate cost per service, and a smaller valid task size when utilization is low. */
export function ecsCost(services: EcsCostService[], p: CostPrices): { total: number; idle: number; lines: EcsCostLine[] } {
  const lines = services.map((s): EcsCostLine => {
    const per = cpuMonthly(s.cpuUnits / 1.024, p) + memMonthly(s.memMiB * 1024 ** 2, p);
    const monthly = per * s.running;
    const l: EcsCostLine = { ...s, monthly };
    if (s.cpuPct !== undefined && s.memPct !== undefined && s.running > 0) {
      l.idleMonthly = (cpuMonthly(s.cpuUnits / 1.024, p) * (1 - s.cpuPct / 100) + memMonthly(s.memMiB * 1024 ** 2, p) * (1 - s.memPct / 100)) * s.running;
      if ((s.launchType ?? 'FARGATE') === 'FARGATE') {
        const needCpu = (s.cpuUnits * s.cpuPct) / 100 / 0.6;
        const needMem = (s.memMiB * s.memPct) / 100 / 0.7;
        const cpu = FARGATE_CPU.find((c) => c >= needCpu) ?? s.cpuUnits;
        const mem = fargateMemFor(cpu).find((m) => m >= needMem) ?? s.memMiB;
        if (cpu * 1024 + mem < s.cpuUnits * 1024 + s.memMiB && (cpu < s.cpuUnits || mem < s.memMiB)) {
          const saving = (per - (cpuMonthly(cpu / 1.024, p) + memMonthly(mem * 1024 ** 2, p))) * s.running;
          if (saving > 0.5) l.suggestion = `${s.cpuUnits / 1024} vCPU / ${s.memMiB / 1024} GB → ${cpu / 1024} vCPU / ${mem / 1024} GB saves about ${p.currency} ${saving.toFixed(2)}/month (average use ${s.cpuPct.toFixed(0)}% CPU, ${s.memPct.toFixed(0)}% memory).`;
        }
      }
    }
    return l;
  });
  return { total: lines.reduce((a, b) => a + b.monthly, 0), idle: lines.reduce((a, b) => a + (b.idleMonthly ?? 0), 0), lines: lines.sort((a, b) => b.monthly - a.monthly) };
}

/** Small unit prices (per vCPU-hour, per GiB-hour) need more digits than monthly totals. */
export function formatRate(v: number, currency: string): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${v.toPrecision(3).replace(/\.?0+$/, '')}`;
}

export function formatMoney(v: number, currency: string): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
}
