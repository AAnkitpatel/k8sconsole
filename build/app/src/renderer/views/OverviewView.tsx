import { useEffect, useMemo, useState } from 'react';
import type { ClusterContext, ConnectionStatus, MetricsSnapshot } from '../../shared/types';
import { formatAge, formatBytes, formatCpu, parseQuantity, summarizeNode, summarizePod, summarizeWorkload } from '../../shared/format';
import { useWatch } from '../lib/useWatch';
import { call } from '../lib/api';
import type { NavigateTarget } from '../components/DetailsPanel';

const ref = (apiVersion: string, kind: string, plural: string, namespaced: boolean) => ({ apiVersion, kind, plural, namespaced });

function Card({ title, value, sub, severity }: { title: string; value: string | number; sub?: string; severity?: string }) {
  return (
    <div className={`card ${severity ? 'card-' + severity : ''}`}>
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

function Bar({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="usage">
      <div className="usage-label">
        <span>{label}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="usage-track" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`usage-fill ${pct > 85 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function OverviewView({ status, context, namespace, onNavigate }: { status: ConnectionStatus; context: ClusterContext | undefined; namespace: string; onNavigate: (t: NavigateTarget) => void }) {
  const nodes = useWatch(useMemo(() => ({ resource: ref('v1', 'Node', 'nodes', false) }), []));
  const pods = useWatch(useMemo(() => ({ resource: ref('v1', 'Pod', 'pods', true), namespace: namespace || undefined }), [namespace]));
  const deployments = useWatch(useMemo(() => ({ resource: ref('apps/v1', 'Deployment', 'deployments', true), namespace: namespace || undefined }), [namespace]));
  const events = useWatch(useMemo(() => ({ resource: ref('v1', 'Event', 'events', true), namespace: namespace || undefined, fieldSelector: 'type=Warning' }), [namespace]));
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => call('metrics:get').then((m) => alive && setMetrics(m)).catch(() => undefined);
    void load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const podStats = useMemo(() => {
    const s = { running: 0, pending: 0, failed: 0, succeeded: 0, restarts: 0 };
    for (const p of pods.items) {
      const sum = summarizePod(p);
      s.restarts += sum.restarts;
      if (sum.severity === 'done') s.succeeded++;
      else if (sum.severity === 'pending') s.pending++;
      else if (sum.severity === 'error') s.failed++;
      else s.running++;
    }
    return s;
  }, [pods.items]);

  const unhealthyDeployments = deployments.items.filter((d) => summarizeWorkload(d).severity !== 'ok');
  const readyNodes = nodes.items.filter((n) => summarizeNode(n).status.startsWith('Ready')).length;
  const capacity = useMemo(() => {
    let cpu = 0;
    let mem = 0;
    for (const n of nodes.items) {
      cpu += parseQuantity(n.status?.allocatable?.cpu) * 1000;
      mem += parseQuantity(n.status?.allocatable?.memory);
    }
    return { cpu, mem };
  }, [nodes.items]);
  const usage = useMemo(() => {
    if (!metrics?.available) return null;
    let cpu = 0;
    let mem = 0;
    for (const v of Object.values(metrics.nodes)) {
      cpu += v.cpuMillis;
      mem += v.memoryBytes;
    }
    return { cpu, mem };
  }, [metrics]);
  const warnings = [...events.items].sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? '') - Date.parse(a.lastTimestamp ?? a.eventTime ?? '')).slice(0, 25);

  return (
    <div className="overview-view">
      <div className="view-header">
        <h1>Cluster Overview</h1>
        <span className="muted">
          {context?.name} · {status.serverVersion} · {namespace ? `namespace ${namespace}` : 'all namespaces'}
        </span>
      </div>
      <div className="cards">
        <Card title="Nodes" value={`${readyNodes}/${nodes.items.length}`} sub="ready" severity={readyNodes < nodes.items.length ? 'warn' : 'ok'} />
        <Card title="Pods running" value={podStats.running} sub={`${podStats.pending} pending · ${podStats.succeeded} completed`} />
        <Card title="Pods failing" value={podStats.failed} sub={`${podStats.restarts} total restarts`} severity={podStats.failed ? 'error' : 'ok'} />
        <Card title="Deployments" value={`${deployments.items.length - unhealthyDeployments.length}/${deployments.items.length}`} sub="fully available" severity={unhealthyDeployments.length ? 'warn' : 'ok'} />
        <Card title="Warnings" value={events.items.length} sub="warning events" severity={events.items.length ? 'warn' : 'ok'} />
      </div>

      <div className="overview-grid">
        <section className="panel">
          <h3>Cluster capacity</h3>
          {usage ? (
            <>
              <Bar used={usage.cpu} total={capacity.cpu} label={`CPU ${formatCpu(usage.cpu)} / ${formatCpu(capacity.cpu)} cores`} />
              <Bar used={usage.mem} total={capacity.mem} label={`Memory ${formatBytes(usage.mem)} / ${formatBytes(capacity.mem)}`} />
            </>
          ) : (
            <p className="muted">
              Allocatable: {formatCpu(capacity.cpu)} CPU, {formatBytes(capacity.mem)} memory. {metrics?.error ?? 'Loading usage…'}
            </p>
          )}
          <h3>Server</h3>
          <dl className="props">
            <dt>API server</dt>
            <dd className="mono">{context?.server}</dd>
            <dt>Version</dt>
            <dd>
              {status.serverVersion} ({status.platform})
            </dd>
            <dt>Auth</dt>
            <dd>{context?.authMethod}</dd>
            {context?.insecureSkipTlsVerify && (
              <>
                <dt>TLS</dt>
                <dd>
                  <span className="badge badge-warn">insecure-skip-tls-verify</span>
                </dd>
              </>
            )}
          </dl>
        </section>

        <section className="panel">
          <h3>Unhealthy deployments</h3>
          {unhealthyDeployments.length === 0 ? (
            <p className="muted">All deployments are fully available.</p>
          ) : (
            <ul className="plain-list">
              {unhealthyDeployments.map((d) => (
                <li key={d.metadata.uid}>
                  <button className="link" onClick={() => onNavigate({ kind: 'Deployment', namespace: d.metadata.namespace, name: d.metadata.name })}>
                    {d.metadata.namespace}/{d.metadata.name}
                  </button>{' '}
                  <span className="badge badge-warn">{summarizeWorkload(d).ready}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel span-2">
          <h3>Recent warning events</h3>
          {warnings.length === 0 ? (
            <p className="muted">{events.loading ? 'Loading…' : 'No warning events.'}</p>
          ) : (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Age</th>
                  <th>Object</th>
                  <th>Reason</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {warnings.map((e) => (
                  <tr key={e.metadata.uid}>
                    <td>{formatAge(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}</td>
                    <td>
                      <button className="link" onClick={() => onNavigate({ kind: e.involvedObject?.kind, apiVersion: e.involvedObject?.apiVersion, namespace: e.involvedObject?.namespace, name: e.involvedObject?.name })}>
                        {e.involvedObject?.kind}/{e.involvedObject?.name}
                      </button>
                    </td>
                    <td>{e.reason}</td>
                    <td className="cell-wrap">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
