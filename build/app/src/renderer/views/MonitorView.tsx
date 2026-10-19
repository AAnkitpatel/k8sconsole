import { useEffect, useMemo, useState } from 'react';
import type { MonitorSnapshot, NodeStat, PodStat, UsageHistory } from '../../shared/types';
import { formatBytes, formatCpu } from '../../shared/format';
import { call, errorMessage, on } from '../lib/api';
import { LineChart, SERIES, Sparkline, UsageBar } from '../components/charts';

const RANGES = [
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '30m', sec: 1800 },
  { label: '1h', sec: 3600 },
];

const cores = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}` : `${Math.round(m)}m`);
const rate = (bps: number) => `${formatBytes(bps)}/s`;
const pctText = (v: number | undefined, cap: number) => (v === undefined || !cap ? '–' : `${((v / cap) * 100).toFixed(0)}%`);

/** Keeps only the samples inside the selected time range. */
export function sliceHistory(h: UsageHistory, sinceMs: number): UsageHistory {
  const i = h.t.findIndex((t) => t >= sinceMs);
  const from = i < 0 ? h.t.length : i;
  return { t: h.t.slice(from), cpu: h.cpu.slice(from), mem: h.mem.slice(from), rx: h.rx?.slice(from), tx: h.tx?.slice(from) };
}

function Tile({ title, value, sub, children }: { title: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="card mon-tile">
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
      {children}
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

function UsageCharts({ h, cpuCap, memCap, label, showNet }: { h: UsageHistory; cpuCap?: number; memCap?: number; label: string; showNet: boolean }) {
  return (
    <div className="mon-charts">
      <LineChart title={`${label} CPU (cores)`} t={h.t} series={[{ name: 'CPU used', values: h.cpu, color: SERIES[0] }]} format={cores} reference={cpuCap ? { value: cpuCap, label: 'allocatable' } : undefined} />
      <LineChart title={`${label} memory`} t={h.t} series={[{ name: 'Memory used', values: h.mem, color: SERIES[0] }]} format={formatBytes} reference={memCap ? { value: memCap, label: 'allocatable' } : undefined} />
      {showNet && h.rx && h.tx && (
        <LineChart
          title={`${label} network`}
          t={h.t}
          series={[
            { name: 'Receive', values: h.rx, color: SERIES[0] },
            { name: 'Transmit', values: h.tx, color: SERIES[1] },
          ]}
          format={rate}
        />
      )}
    </div>
  );
}

function PodDetail({ pod, since, onClose }: { pod: PodStat; since: number; onClose: () => void }) {
  const [h, setH] = useState<UsageHistory | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => call('monitor:podHistory', pod.namespace, pod.name).then((x) => alive && setH(x));
    void load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pod.namespace, pod.name]);
  const sliced = h ? sliceHistory(h, since) : null;
  return (
    <section className="panel mon-detail">
      <div className="mon-detail-head">
        <h3>
          Pod {pod.namespace}/{pod.name}
        </h3>
        <span className="muted">
          requests {formatCpu(pod.cpuRequestsMillis)} CPU / {formatBytes(pod.memRequestsBytes)} · limits {pod.cpuLimitsMillis ? formatCpu(pod.cpuLimitsMillis) : 'none'} CPU / {pod.memLimitsBytes ? formatBytes(pod.memLimitsBytes) : 'none'}
        </span>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {sliced && (
        <UsageCharts h={sliced} label="Pod" cpuCap={pod.cpuLimitsMillis || undefined} memCap={pod.memLimitsBytes || undefined} showNet={false} />
      )}
    </section>
  );
}

type PodSort = 'cpu' | 'mem' | 'restarts' | 'name';

export function MonitorView({ namespace }: { namespace: string }) {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState(900);
  const [node, setNode] = useState<string | null>(null);
  const [pod, setPod] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<PodSort>('cpu');

  useEffect(() => {
    const off = on('monitor:update', setSnap);
    call('monitor:start')
      .then((s) => s && setSnap(s))
      .catch((err) => setError(errorMessage(err)));
    return () => {
      off();
      void call('monitor:stop');
    };
  }, []);

  const since = (snap?.sampledAt ?? Date.now()) - range * 1000;
  const selectedNode: NodeStat | undefined = snap?.nodes.find((n) => n.name === node);

  const pods = useMemo(() => {
    if (!snap) return [];
    const f = filter.toLowerCase();
    const list = snap.pods.filter((p) => (!namespace || p.namespace === namespace) && (!node || p.node === node) && (!f || `${p.namespace}/${p.name}`.toLowerCase().includes(f)));
    const key: Record<PodSort, (p: PodStat) => number | string> = {
      cpu: (p) => -(p.cpuUsageMillis ?? p.cpuRequestsMillis / 1e6),
      mem: (p) => -(p.memUsageBytes ?? p.memRequestsBytes / 1e6),
      restarts: (p) => -p.restarts,
      name: (p) => `${p.namespace}/${p.name}`,
    };
    return list.sort((a, b) => {
      const x = key[sort](a);
      const y = key[sort](b);
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    });
  }, [snap, namespace, node, filter, sort]);

  if (error) return <div className="inline-error">{error}</div>;
  if (!snap)
    return (
      <div className="empty">
        <span className="spinner" /> Sampling cluster metrics…
      </div>
    );

  const c = snap.cluster;
  const hasUsage = c.cpuUsageMillis !== undefined;
  const hasNet = c.rxBps !== undefined;
  const ch = sliceHistory(c.history, since);
  const selectedPod = snap.pods.find((p) => `${p.namespace}/${p.name}` === pod);

  return (
    <div className="monitor-view">
      <div className="view-header">
        <h1>Monitor</h1>
        <span className="tag" title="Where usage numbers come from">
          {snap.source === 'kubelet-summary' ? 'kubelet summary API' : snap.source === 'metrics-server' ? 'metrics-server' : 'requests only'}
        </span>
        <span className="muted">every {snap.intervalSec}s · updated {new Date(snap.sampledAt).toLocaleTimeString()}</span>
        <div className="spacer" />
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.sec} role="radio" aria-checked={range === r.sec} className={range === r.sec ? 'active' : ''} onClick={() => setRange(r.sec)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {snap.error && <div className="inline-warn mon-pad">{snap.error}</div>}

      <div className="cards">
        <Tile title="CPU" value={hasUsage ? pctText(c.cpuUsageMillis, c.cpuAllocMillis) : pctText(c.cpuRequestsMillis, c.cpuAllocMillis)} sub={`${hasUsage ? cores(c.cpuUsageMillis!) + ' used · ' : ''}${cores(c.cpuRequestsMillis)} requested of ${cores(c.cpuAllocMillis)} cores`}>
          <UsageBar used={c.cpuUsageMillis} capacity={c.cpuAllocMillis} request={c.cpuRequestsMillis} limit={c.cpuLimitsMillis} label="Cluster CPU" />
        </Tile>
        <Tile title="Memory" value={hasUsage ? pctText(c.memUsageBytes, c.memAllocBytes) : pctText(c.memRequestsBytes, c.memAllocBytes)} sub={`${hasUsage ? formatBytes(c.memUsageBytes!) + ' used · ' : ''}${formatBytes(c.memRequestsBytes)} requested of ${formatBytes(c.memAllocBytes)}`}>
          <UsageBar used={c.memUsageBytes} capacity={c.memAllocBytes} request={c.memRequestsBytes} limit={c.memLimitsBytes} label="Cluster memory" />
        </Tile>
        <Tile title="Pods" value={`${c.pods}`} sub={`of ${c.podCapacity} capacity`}>
          <UsageBar used={c.pods} capacity={c.podCapacity} label="Pod capacity" />
        </Tile>
        <Tile title="Nodes" value={`${c.nodesReady}/${c.nodesTotal}`} sub="ready" />
        {hasNet && <Tile title="Network" value={rate((c.rxBps ?? 0) + (c.txBps ?? 0))} sub={`↓ ${rate(c.rxBps ?? 0)} · ↑ ${rate(c.txBps ?? 0)}`} />}
      </div>

      {hasUsage && (
        <div className="mon-pad">
          <UsageCharts h={ch} label="Cluster" cpuCap={c.cpuAllocMillis} memCap={c.memAllocBytes} showNet={hasNet} />
        </div>
      )}

      <section className="panel mon-section">
        <h3>Nodes ({snap.nodes.length})</h3>
        <div className="table-wrap">
          <table className="rtable mon-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th style={{ width: 190 }}>CPU</th>
                <th style={{ width: 190 }}>Memory</th>
                <th>Pods</th>
                {hasNet && <th>Net ↓ / ↑</th>}
                <th>Disk</th>
                <th>CPU trend</th>
              </tr>
            </thead>
            <tbody>
              {snap.nodes.map((n) => (
                <tr key={n.name} className={node === n.name ? 'selected' : ''} onClick={() => setNode(node === n.name ? null : n.name)}>
                  <td className="cell-name">
                    {n.name}
                    {n.roles !== '<none>' && <span className="tag">{n.roles}</span>}
                  </td>
                  <td>
                    <span className={`badge badge-${n.ready ? (n.unschedulable ? 'warn' : 'ok') : 'error'}`}>{n.ready ? (n.unschedulable ? 'Cordoned' : 'Ready') : 'NotReady'}</span>
                  </td>
                  <td>
                    <UsageBar used={n.cpuUsageMillis} capacity={n.cpuAllocMillis} request={n.cpuRequestsMillis} limit={n.cpuLimitsMillis} label={`${n.name} CPU`} />
                  </td>
                  <td>
                    <UsageBar used={n.memUsageBytes} capacity={n.memAllocBytes} request={n.memRequestsBytes} limit={n.memLimitsBytes} label={`${n.name} memory`} />
                  </td>
                  <td>
                    {n.pods}/{n.podCapacity}
                  </td>
                  {hasNet && <td className="mono">{n.rxBps !== undefined ? `${rate(n.rxBps)} / ${rate(n.txBps ?? 0)}` : '–'}</td>}
                  <td>{n.fsCapacityBytes ? pctText(n.fsUsedBytes, n.fsCapacityBytes) : '–'}</td>
                  <td>
                    <Sparkline values={n.history.cpu.slice(-30)} label={`${n.name} CPU trend`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedNode && hasUsage && (
        <section className="panel mon-detail">
          <div className="mon-detail-head">
            <h3>Node {selectedNode.name}</h3>
            <div className="spacer" />
            <button className="btn btn-sm" onClick={() => setNode(null)}>
              Clear node filter
            </button>
          </div>
          <UsageCharts h={sliceHistory(selectedNode.history, since)} label="Node" cpuCap={selectedNode.cpuAllocMillis} memCap={selectedNode.memAllocBytes} showNet={selectedNode.rxBps !== undefined} />
        </section>
      )}

      {selectedPod && <PodDetail pod={selectedPod} since={since} onClose={() => setPod(null)} />}

      <section className="panel mon-section">
        <div className="mon-detail-head">
          <h3>
            Pods ({pods.length}){node ? ` on ${node}` : ''}
            {namespace ? ` in ${namespace}` : ''}
          </h3>
          <div className="spacer" />
          <input className="search" placeholder="Filter pods…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter pods" />
          <select value={sort} onChange={(e) => setSort(e.target.value as PodSort)} aria-label="Sort pods">
            <option value="cpu">Sort: CPU</option>
            <option value="mem">Sort: memory</option>
            <option value="restarts">Sort: restarts</option>
            <option value="name">Sort: name</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="rtable mon-table">
            <thead>
              <tr>
                <th>Pod</th>
                <th>Status</th>
                <th>Restarts</th>
                <th>CPU</th>
                <th style={{ width: 170 }}>CPU vs limit</th>
                <th>Memory</th>
                <th style={{ width: 170 }}>Memory vs limit</th>
                <th>CPU trend</th>
                <th>Node</th>
              </tr>
            </thead>
            <tbody>
              {pods.slice(0, 300).map((p) => {
                const key = `${p.namespace}/${p.name}`;
                return (
                  <tr key={key} className={pod === key ? 'selected' : ''} onClick={() => setPod(pod === key ? null : key)}>
                    <td className="cell-name">
                      <span className="muted">{p.namespace}/</span>
                      {p.name}
                    </td>
                    <td>
                      <span className={`badge badge-${p.status === 'Running' ? 'ok' : /Completed|Succeeded/.test(p.status) ? 'done' : /Pending|Creating|Init/.test(p.status) ? 'pending' : 'error'}`}>{p.status}</span>
                    </td>
                    <td>{p.restarts}</td>
                    <td className="mono">{p.cpuUsageMillis !== undefined ? formatCpu(p.cpuUsageMillis) : '–'}</td>
                    <td>
                      <UsageBar used={p.cpuUsageMillis} capacity={p.cpuLimitsMillis || p.cpuRequestsMillis} request={p.cpuLimitsMillis ? p.cpuRequestsMillis : undefined} label={`${key} CPU vs ${p.cpuLimitsMillis ? 'limit' : 'request'}`} />
                    </td>
                    <td className="mono">{p.memUsageBytes !== undefined ? formatBytes(p.memUsageBytes) : '–'}</td>
                    <td>
                      <UsageBar used={p.memUsageBytes} capacity={p.memLimitsBytes || p.memRequestsBytes} request={p.memLimitsBytes ? p.memRequestsBytes : undefined} label={`${key} memory vs ${p.memLimitsBytes ? 'limit' : 'request'}`} />
                    </td>
                    <td>
                      <Sparkline values={p.spark.cpu} label={`${key} CPU trend`} />
                    </td>
                    <td className="muted">{p.node}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pods.length > 300 && <div className="empty">Showing the top 300 of {pods.length} pods. Filter to narrow down.</div>}
          {pods.length === 0 && <div className="empty">No pods match.</div>}
        </div>
      </section>
    </div>
  );
}
