import { parseQuantity, summarizeNode, summarizePod } from '../../shared/format';
import type { KubeObject, MetricsSource, MonitorSnapshot, NodeStat, PodStat, ResourceTotals, UsageHistory } from '../../shared/types';
import { KubeApiError, type KubeRest } from './rest';

const HISTORY_SECONDS = 3600;
const SPARK_POINTS = 30;
const SUMMARY_NODE_LIMIT = 60;

/** Fixed-capacity time series store keyed by entity. */
export class SeriesStore {
  private readonly data = new Map<string, { t: number[]; cols: Record<string, number[]> }>();
  constructor(private readonly capacity: number) {}

  push(key: string, t: number, values: Record<string, number | undefined>): void {
    let s = this.data.get(key);
    if (!s) {
      s = { t: [], cols: {} };
      this.data.set(key, s);
    }
    const len = s.t.length;
    s.t.push(t);
    for (const [name, v] of Object.entries(values)) {
      const col = (s.cols[name] ??= new Array(len).fill(NaN));
      col.push(v ?? NaN);
    }
    for (const col of Object.values(s.cols)) if (col.length < s.t.length) col.push(NaN);
    if (s.t.length > this.capacity) {
      const drop = s.t.length - this.capacity;
      s.t.splice(0, drop);
      for (const col of Object.values(s.cols)) col.splice(0, drop);
    }
  }

  history(key: string): UsageHistory {
    const s = this.data.get(key);
    if (!s) return { t: [], cpu: [], mem: [] };
    return { t: [...s.t], cpu: [...(s.cols.cpu ?? [])], mem: [...(s.cols.mem ?? [])], rx: s.cols.rx && [...s.cols.rx], tx: s.cols.tx && [...s.cols.tx] };
  }

  tail(key: string, col: string, n: number): number[] {
    return (this.data.get(key)?.cols[col] ?? []).slice(-n);
  }

  prune(keep: Set<string>): void {
    for (const k of this.data.keys()) if (!keep.has(k)) this.data.delete(k);
  }
}

export interface Usage {
  cpuMillis: number;
  memBytes: number;
}

export interface NodeUsage extends Usage {
  rxBytes?: number;
  txBytes?: number;
  fsUsedBytes?: number;
  fsCapacityBytes?: number;
}

/** Parses a kubelet /stats/summary document. CPU is nanocores; network counters are cumulative bytes. */
export function parseSummary(summary: any): { node: NodeUsage; pods: Map<string, Usage> } {
  const n = summary?.node ?? {};
  const ifaces: any[] = n.network?.interfaces ?? [];
  const rx = ifaces.length ? ifaces.reduce((a, i) => a + (i.rxBytes ?? 0), 0) : n.network?.rxBytes;
  const tx = ifaces.length ? ifaces.reduce((a, i) => a + (i.txBytes ?? 0), 0) : n.network?.txBytes;
  const node: NodeUsage = {
    cpuMillis: (n.cpu?.usageNanoCores ?? 0) / 1e6,
    memBytes: n.memory?.workingSetBytes ?? 0,
    rxBytes: rx,
    txBytes: tx,
    fsUsedBytes: n.fs?.usedBytes,
    fsCapacityBytes: n.fs?.capacityBytes,
  };
  const pods = new Map<string, Usage>();
  for (const p of summary?.pods ?? []) {
    if (!p.podRef) continue;
    pods.set(`${p.podRef.namespace}/${p.podRef.name}`, { cpuMillis: (p.cpu?.usageNanoCores ?? 0) / 1e6, memBytes: p.memory?.workingSetBytes ?? 0 });
  }
  return { node, pods };
}

/** Per-second rate from two cumulative counter samples; undefined on counter reset or missing data. */
export function counterRate(prev: { v?: number; t: number } | undefined, cur: { v?: number; t: number }): number | undefined {
  if (!prev || prev.v === undefined || cur.v === undefined || cur.t <= prev.t || cur.v < prev.v) return undefined;
  return ((cur.v - prev.v) * 1000) / (cur.t - prev.t);
}

/** Sums container requests/limits of a pod (init containers use the max, as the scheduler does). */
export function podResources(pod: KubeObject): { cpuReq: number; cpuLim: number; memReq: number; memLim: number } {
  const sum = { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0 };
  for (const c of pod.spec?.containers ?? []) {
    sum.cpuReq += parseQuantity(c.resources?.requests?.cpu) * 1000 || 0;
    sum.cpuLim += parseQuantity(c.resources?.limits?.cpu) * 1000 || 0;
    sum.memReq += parseQuantity(c.resources?.requests?.memory) || 0;
    sum.memLim += parseQuantity(c.resources?.limits?.memory) || 0;
  }
  for (const c of pod.spec?.initContainers ?? []) {
    sum.cpuReq = Math.max(sum.cpuReq, parseQuantity(c.resources?.requests?.cpu) * 1000 || 0);
    sum.memReq = Math.max(sum.memReq, parseQuantity(c.resources?.requests?.memory) || 0);
  }
  return sum;
}

const isActive = (p: KubeObject) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed';

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Polls node/pod state and usage, keeping history for charts (ktop-style monitoring). */
export class MonitorCollector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private snapshot: MonitorSnapshot | null = null;
  private readonly store: SeriesStore;
  private readonly counters = new Map<string, { rx?: number; tx?: number; t: number }>();
  private summaryAllowed: boolean | null = null;
  private refs = 0;

  constructor(
    private readonly rest: KubeRest,
    private readonly emit: (s: MonitorSnapshot) => void,
    readonly intervalSec = 10,
  ) {
    this.store = new SeriesStore(Math.ceil(HISTORY_SECONDS / intervalSec));
  }

  async start(): Promise<MonitorSnapshot | null> {
    this.refs++;
    if (!this.running) {
      this.running = true;
      await this.tick();
    }
    return this.snapshot;
  }

  stop(force = false): void {
    this.refs = force ? 0 : Math.max(0, this.refs - 1);
    if (this.refs === 0) {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get current(): MonitorSnapshot | null {
    return this.snapshot;
  }

  podHistory(namespace: string, name: string): UsageHistory | null {
    return this.snapshot ? this.store.history(`pod:${namespace}/${name}`) : null;
  }

  private schedule(): void {
    if (this.running) this.timer = setTimeout(() => void this.tick(), this.intervalSec * 1000);
  }

  private async nodeSummary(name: string): Promise<{ node: NodeUsage; pods: Map<string, Usage> } | null> {
    try {
      return parseSummary(await this.rest.get(`/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`, { timeoutMs: 8000 }));
    } catch (err) {
      if (err instanceof KubeApiError && (err.code === 403 || err.code === 404)) this.summaryAllowed = false;
      return null;
    }
  }

  async tick(now = Date.now()): Promise<void> {
    try {
      const [nodesList, podsList] = await Promise.all([this.rest.get('/api/v1/nodes', { timeoutMs: 20000 }), this.rest.get('/api/v1/pods', { timeoutMs: 30000 })]);
      const nodes: KubeObject[] = nodesList.items ?? [];
      const pods: KubeObject[] = (podsList.items ?? []).filter(isActive);
      let source: MetricsSource = 'requests-only';
      let error: string | undefined;
      const nodeUsage = new Map<string, NodeUsage>();
      const podUsage = new Map<string, Usage>();

      if (this.summaryAllowed !== false && nodes.length <= SUMMARY_NODE_LIMIT) {
        const results = await mapLimit(nodes, 6, (n) => this.nodeSummary(n.metadata.name));
        results.forEach((r, i) => {
          if (!r) return;
          nodeUsage.set(nodes[i].metadata.name, r.node);
          for (const [k, v] of r.pods) podUsage.set(k, v);
        });
        if (nodeUsage.size) {
          source = 'kubelet-summary';
          this.summaryAllowed = true;
        }
      }
      if (source === 'requests-only') {
        try {
          const [nm, pm] = await Promise.all([this.rest.get('/apis/metrics.k8s.io/v1beta1/nodes', { timeoutMs: 10000 }), this.rest.get('/apis/metrics.k8s.io/v1beta1/pods', { timeoutMs: 15000 })]);
          for (const n of nm.items ?? []) nodeUsage.set(n.metadata.name, { cpuMillis: parseQuantity(n.usage?.cpu) * 1000, memBytes: parseQuantity(n.usage?.memory) });
          for (const p of pm.items ?? []) {
            let cpu = 0;
            let mem = 0;
            for (const c of p.containers ?? []) {
              cpu += parseQuantity(c.usage?.cpu) * 1000;
              mem += parseQuantity(c.usage?.memory);
            }
            podUsage.set(`${p.metadata.namespace}/${p.metadata.name}`, { cpuMillis: cpu, memBytes: mem });
          }
          source = 'metrics-server';
        } catch {
          error = 'No usage metrics: the kubelet Summary API (nodes/proxy) is not permitted and metrics-server is unavailable. Showing requests and limits only.';
        }
      }

      // Requests/limits per node.
      const perNode = new Map<string, ResourceTotals & { pods: number }>();
      const podStats: PodStat[] = [];
      const keep = new Set<string>(['cluster']);
      for (const p of pods) {
        const r = podResources(p);
        const nodeName = p.spec?.nodeName ?? '';
        const agg = perNode.get(nodeName) ?? { cpuAllocMillis: 0, memAllocBytes: 0, cpuRequestsMillis: 0, memRequestsBytes: 0, cpuLimitsMillis: 0, memLimitsBytes: 0, pods: 0 };
        agg.cpuRequestsMillis += r.cpuReq;
        agg.memRequestsBytes += r.memReq;
        agg.cpuLimitsMillis += r.cpuLim;
        agg.memLimitsBytes += r.memLim;
        agg.pods++;
        perNode.set(nodeName, agg);
        const key = `${p.metadata.namespace}/${p.metadata.name}`;
        const u = podUsage.get(key);
        const skey = `pod:${key}`;
        keep.add(skey);
        if (u) this.store.push(skey, now, { cpu: u.cpuMillis, mem: u.memBytes });
        const sum = summarizePod(p);
        podStats.push({
          namespace: p.metadata.namespace!,
          name: p.metadata.name,
          node: nodeName,
          status: sum.status,
          restarts: sum.restarts,
          cpuUsageMillis: u?.cpuMillis,
          memUsageBytes: u?.memBytes,
          cpuRequestsMillis: r.cpuReq,
          cpuLimitsMillis: r.cpuLim,
          memRequestsBytes: r.memReq,
          memLimitsBytes: r.memLim,
          spark: { cpu: this.store.tail(skey, 'cpu', SPARK_POINTS), mem: this.store.tail(skey, 'mem', SPARK_POINTS) },
        });
      }

      const nodeStats: NodeStat[] = nodes.map((n) => {
        const name = n.metadata.name;
        const u = nodeUsage.get(name);
        const agg = perNode.get(name);
        const prev = this.counters.get(name);
        const rxBps = counterRate(prev && { v: prev.rx, t: prev.t }, { v: u?.rxBytes, t: now });
        const txBps = counterRate(prev && { v: prev.tx, t: prev.t }, { v: u?.txBytes, t: now });
        if (u) this.counters.set(name, { rx: u.rxBytes, tx: u.txBytes, t: now });
        const key = `node:${name}`;
        keep.add(key);
        if (u) this.store.push(key, now, { cpu: u.cpuMillis, mem: u.memBytes, rx: rxBps, tx: txBps });
        const s = summarizeNode(n);
        return {
          name,
          ready: s.status.startsWith('Ready'),
          unschedulable: !!n.spec?.unschedulable,
          roles: s.roles,
          cpuAllocMillis: parseQuantity(n.status?.allocatable?.cpu) * 1000,
          memAllocBytes: parseQuantity(n.status?.allocatable?.memory),
          cpuRequestsMillis: agg?.cpuRequestsMillis ?? 0,
          memRequestsBytes: agg?.memRequestsBytes ?? 0,
          cpuLimitsMillis: agg?.cpuLimitsMillis ?? 0,
          memLimitsBytes: agg?.memLimitsBytes ?? 0,
          cpuUsageMillis: u?.cpuMillis,
          memUsageBytes: u?.memBytes,
          rxBps,
          txBps,
          fsUsedBytes: u?.fsUsedBytes,
          fsCapacityBytes: u?.fsCapacityBytes,
          pods: agg?.pods ?? 0,
          podCapacity: parseQuantity(n.status?.allocatable?.pods),
          history: this.store.history(key),
        };
      });

      const total = (f: (n: NodeStat) => number | undefined) => nodeStats.reduce((a, n) => a + (f(n) ?? 0), 0);
      const hasUsage = nodeStats.some((n) => n.cpuUsageMillis !== undefined);
      const hasNet = nodeStats.some((n) => n.rxBps !== undefined);
      const cluster = {
        cpuAllocMillis: total((n) => n.cpuAllocMillis),
        memAllocBytes: total((n) => n.memAllocBytes),
        cpuRequestsMillis: total((n) => n.cpuRequestsMillis),
        memRequestsBytes: total((n) => n.memRequestsBytes),
        cpuLimitsMillis: total((n) => n.cpuLimitsMillis),
        memLimitsBytes: total((n) => n.memLimitsBytes),
        cpuUsageMillis: hasUsage ? total((n) => n.cpuUsageMillis) : undefined,
        memUsageBytes: hasUsage ? total((n) => n.memUsageBytes) : undefined,
        rxBps: hasNet ? total((n) => n.rxBps) : undefined,
        txBps: hasNet ? total((n) => n.txBps) : undefined,
        pods: pods.length,
        podCapacity: total((n) => n.podCapacity),
        nodesReady: nodeStats.filter((n) => n.ready).length,
        nodesTotal: nodeStats.length,
      };
      if (hasUsage) this.store.push('cluster', now, { cpu: cluster.cpuUsageMillis, mem: cluster.memUsageBytes, rx: cluster.rxBps, tx: cluster.txBps });
      this.store.prune(keep);

      this.snapshot = { source, intervalSec: this.intervalSec, sampledAt: now, error, cluster: { ...cluster, history: this.store.history('cluster') }, nodes: nodeStats, pods: podStats };
    } catch (err) {
      this.snapshot = this.snapshot ? { ...this.snapshot, error: `Sampling failed: ${err instanceof Error ? err.message : String(err)}` } : null;
    }
    if (this.snapshot) this.emit(this.snapshot);
    this.schedule();
  }
}
