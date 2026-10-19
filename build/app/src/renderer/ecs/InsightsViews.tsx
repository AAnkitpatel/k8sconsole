import { useMemo, useState } from 'react';
import { arnName, serviceStatus, serviceSummary, type EcsFinding, type EcsSeverity } from '../../shared/ecs';
import type { GraphNode } from '../../shared/graph';
import { call } from '../lib/api';
import { GraphView } from '../components/GraphView';
import { LineChart, SERIES, Sparkline } from '../components/charts';
import { DataTable, LoadState, NoCluster, last, pct, useLoad } from './common';
import { StatusBadge, ago, isWarningEvent, useEcs, when } from './shared';

// ---- Overview ----

export function EcsOverviewView() {
  const { clusters, cluster, setCluster, setView, refreshClusters, status } = useEcs();
  const services = useLoad(() => (cluster ? call('ecs:services', cluster) : Promise.resolve([])), [cluster], 20000);
  const instances = useLoad(() => (cluster ? call('ecs:containerInstances', cluster) : Promise.resolve([])), [cluster]);
  const info = clusters.find((c) => c.arn === cluster);
  const attention = (services.data ?? []).filter((s) => ['warn', 'error'].includes(serviceStatus(s)));
  const warnings = useMemo(
    () =>
      (services.data ?? [])
        .flatMap((s) => s.events.filter((e) => isWarningEvent(e.message) && Date.now() - e.createdAt < 24 * 3600e3).map((e) => ({ ...e, service: s.name })))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 12),
    [services.data],
  );
  return (
    <div className="overview-view ecs-overview ecs-pad" data-testid="ecs-overview">
      <div className="view-header">
        <h1>Amazon ECS</h1>
        <span className="muted">
          account {status.account} · {status.request?.region} · {status.arn ? arnName(status.arn) : ''}
        </span>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => void refreshClusters()}>
          Refresh
        </button>
      </div>
      <h3 className="sub-h">Clusters in {status.request?.region}</h3>
      <div className="cards">
        {clusters.map((c) => (
          <button key={c.arn} className={`card ecs-cluster-card ${c.arn === cluster ? 'card-ok active' : ''}`} onClick={() => setCluster(c.arn)} data-testid="ecs-cluster-card">
            <div className="card-title">{c.name}</div>
            <div className="card-value">{c.runningTasks}</div>
            <div className="card-sub">
              running tasks · {c.activeServices} services{c.pendingTasks ? ` · ${c.pendingTasks} pending` : ''}
              {c.containerInstances ? ` · ${c.containerInstances} instances` : ''}
            </div>
          </button>
        ))}
        {clusters.length === 0 && <div className="empty">No ECS clusters in this region.</div>}
      </div>
      {info && (
        <>
          <h3 className="sub-h">{info.name}</h3>
          <div className="cards">
            <div className="card">
              <div className="card-title">Services</div>
              <div className="card-value">{info.activeServices}</div>
              <div className="card-sub">{(services.data ?? []).filter((s) => serviceStatus(s) === 'ok').length} steady</div>
            </div>
            <div className={`card ${attention.length ? 'card-warn' : 'card-ok'}`}>
              <div className="card-title">Need attention</div>
              <div className="card-value">{attention.length}</div>
              <div className="card-sub">deploying, degraded or failed</div>
            </div>
            <div className="card">
              <div className="card-title">Tasks</div>
              <div className="card-value">{info.runningTasks}</div>
              <div className="card-sub">{info.pendingTasks} pending</div>
            </div>
            <div className="card">
              <div className="card-title">Capacity</div>
              <div className="card-value">{info.containerInstances || 'Fargate'}</div>
              <div className="card-sub">{info.containerInstances ? 'container instances' : info.capacityProviders.filter((p) => !p.startsWith('FARGATE')).join(', ') || 'serverless'}</div>
            </div>
            <div className="card">
              <div className="card-title">Container Insights</div>
              <div className="card-value">{info.containerInsights ?? 'disabled'}</div>
              <div className="card-sub">{info.execLogging ? `exec logging: ${info.execLogging}` : 'exec logging: default'}</div>
            </div>
          </div>
          <LoadState loading={services.loading && !services.data} error={services.error} what="services" />
          {attention.length > 0 && (
            <>
              <h3 className="sub-h">Needs attention</h3>
              <ul className="plain-list">
                {attention.map((s) => (
                  <li key={s.name}>
                    <StatusBadge status={serviceStatus(s)} label={serviceStatus(s)} />{' '}
                    <button className="link" onClick={() => setView({ type: 'services', select: s.name })}>
                      {s.name}
                    </button>{' '}
                    <span className="muted">{serviceSummary(s)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="sub-h">Warnings in the last 24 hours</h3>
          {warnings.length === 0 ? (
            <div className="muted">No warning events.</div>
          ) : (
            <ul className="plain-list ecs-events">
              {warnings.map((e) => (
                <li key={e.id} className="ecs-event-warn">
                  <span className="muted">{ago(e.createdAt)} ago</span>{' '}
                  <button className="link" onClick={() => setView({ type: 'services', select: e.service })}>
                    {e.service}
                  </button>{' '}
                  {e.message}
                </li>
              ))}
            </ul>
          )}
          {(instances.data?.length ?? 0) > 0 && (
            <>
              <h3 className="sub-h">Container instances</h3>
              <DataTable
                rows={instances.data!}
                rowKey={(i) => i.arn}
                cols={[
                  { key: 'id', title: 'Instance', render: (i) => <span className="mono">{i.ec2InstanceId ?? arnName(i.arn)}</span>, sort: (i) => i.ec2InstanceId ?? '' },
                  { key: 'status', title: 'Status', render: (i) => <StatusBadge status={i.status === 'ACTIVE' && i.agentConnected ? 'ok' : 'warn'} label={`${i.status.toLowerCase()}${i.agentConnected ? '' : ' · agent disconnected'}`} /> },
                  { key: 'tasks', title: 'Tasks', render: (i) => `${i.runningTasks}${i.pendingTasks ? ` +${i.pendingTasks}` : ''}`, sort: (i) => i.runningTasks },
                  { key: 'cpu', title: 'CPU free', render: (i) => (i.cpuRegistered ? `${i.cpuRemaining} / ${i.cpuRegistered} units` : '') },
                  { key: 'mem', title: 'Memory free', render: (i) => (i.memRegistered ? `${i.memRemaining} / ${i.memRegistered} MiB` : '') },
                  { key: 'agent', title: 'Agent', render: (i) => i.agentVersion ?? '' },
                ]}
                empty="No container instances."
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---- Monitor ----

const peak = (v: number[] | undefined): number => {
  const f = (v ?? []).filter(Number.isFinite);
  return f.length ? Math.max(...f) : NaN;
};

const RANGES = [
  { label: '1h', min: 60 },
  { label: '3h', min: 180 },
  { label: '24h', min: 1440 },
  { label: '7d', min: 10080 },
];

export function EcsMonitorView() {
  const { cluster, setView } = useEcs();
  const [minutes, setMinutes] = useState(180);
  const services = useLoad(() => (cluster ? call('ecs:services', cluster) : Promise.resolve([])), [cluster], 30000);
  const names = useMemo(() => (services.data ?? []).map((s) => s.name), [services.data]);
  const metrics = useLoad(() => (cluster && names.length ? call('ecs:metrics', cluster, names, minutes) : Promise.resolve(null)), [cluster, names.join(','), minutes], 60000);
  if (!cluster) return <NoCluster />;
  const m = metrics.data;
  return (
    <div className="monitor-view ecs-monitor ecs-pad" data-testid="ecs-monitor">
      <div className="view-header">
        <h1>Monitor</h1>
        <span className="muted">CloudWatch AWS/ECS · average utilization of reserved CPU and memory · refreshes every minute</span>
        <div className="spacer" />
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.min} role="radio" aria-checked={minutes === r.min} className={minutes === r.min ? 'active' : ''} onClick={() => setMinutes(r.min)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <LoadState loading={(services.loading || metrics.loading) && !m} error={services.error ?? metrics.error} what="CloudWatch metrics" />
      {m?.note && <div className="muted ecs-hint">{m.note}</div>}
      {m && m.cluster.t.length > 0 && (
        <div className="mon-charts">
          <LineChart title="Cluster CPU" t={m.cluster.t} series={[{ name: 'CPU', values: m.cluster.cpu, color: SERIES[0] }]} format={pct} reference={{ value: 100, label: 'reserved' }} />
          <LineChart title="Cluster memory" t={m.cluster.t} series={[{ name: 'Memory', values: m.cluster.mem, color: SERIES[1] }]} format={pct} reference={{ value: 100, label: 'reserved' }} />
        </div>
      )}
      {services.data && (
        <DataTable
          rows={services.data}
          rowKey={(s) => s.name}
          onSelect={(s) => setView({ type: 'services', select: s.name })}
          testId="ecs-monitor-row"
          initialSort={{ key: 'cpu', dir: -1 }}
          cols={[
            { key: 'name', title: 'Service', render: (s) => s.name, sort: (s) => s.name },
            { key: 'tasks', title: 'Tasks', render: (s) => `${s.running}/${s.desired}`, sort: (s) => s.running },
            { key: 'cpu', title: 'CPU now', render: (s) => pct(last(m?.services[s.name]?.cpu ?? [])), sort: (s) => last(m?.services[s.name]?.cpu ?? []) || -1 },
            { key: 'cpuSpark', title: 'CPU trend', render: (s) => <Sparkline values={m?.services[s.name]?.cpu ?? []} color={SERIES[0]} label={`${s.name} CPU`} /> },
            { key: 'mem', title: 'Memory now', render: (s) => pct(last(m?.services[s.name]?.mem ?? [])), sort: (s) => last(m?.services[s.name]?.mem ?? []) || -1 },
            { key: 'memSpark', title: 'Memory trend', render: (s) => <Sparkline values={m?.services[s.name]?.mem ?? []} color={SERIES[1]} label={`${s.name} memory`} /> },
            { key: 'peak', title: 'Peak CPU', render: (s) => pct(peak(m?.services[s.name]?.cpu)), sort: (s) => (Number.isFinite(peak(m?.services[s.name]?.cpu)) ? peak(m?.services[s.name]?.cpu) : -1) },
          ]}
          empty="No services."
        />
      )}
    </div>
  );
}

// ---- Service map ----

export function EcsMapView() {
  const { cluster, setView } = useEcs();
  const [service, setService] = useState('');
  const services = useLoad(() => (cluster ? call('ecs:services', cluster) : Promise.resolve([])), [cluster]);
  const graph = useLoad(() => (cluster ? call('ecs:map', cluster, service || undefined) : Promise.resolve(null)), [cluster, service], 30000);
  if (!cluster) return <NoCluster />;
  const open = (n: GraphNode) => {
    if (n.kind === 'EcsService') setView({ type: 'services', select: n.name });
    else if (n.kind === 'Task' && /^[0-9a-f]{32}$/.test(n.name)) setView({ type: 'tasks', select: `${cluster.replace(':cluster/', ':task/')}/${n.name}` });
    else if (n.kind === 'TaskDefinition') setView({ type: 'taskdefs', family: n.name.split(':')[0] });
  };
  return (
    <div className="map-view" data-testid="ecs-map">
      <div className="view-header">
        <h1>Service Map</h1>
        <span className="muted">load balancer → target group → service → tasks · task definitions and security groups</span>
        <div className="spacer" />
        <select value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
          <option value="">All services</option>
          {services.data?.map((s) => (
            <option key={s.name}>{s.name}</option>
          ))}
        </select>
      </div>
      {graph.data?.notes.map((n) => (
        <div key={n} className="inline-warn">
          {n}
        </div>
      ))}
      <LoadState loading={graph.loading && !graph.data} error={graph.error} what="service map" />
      {graph.data && (
        <div className="map-body">
          <GraphView graph={graph.data} onOpen={open} emptyText="No services in this cluster." edgeLabels={{ guards: 'security group', uses: 'task definition', owns: 'runs task' }} />
        </div>
      )}
    </div>
  );
}

// ---- Events ----

export function EcsEventsView() {
  const { cluster, setView } = useEcs();
  const [filter, setFilter] = useState('');
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const events = useLoad(() => (cluster ? call('ecs:events', cluster) : Promise.resolve([])), [cluster], 20000);
  if (!cluster) return <NoCluster />;
  const f = filter.trim().toLowerCase();
  const shown = (events.data ?? []).filter((e) => (!onlyWarnings || isWarningEvent(e.message)) && (!f || e.message.toLowerCase().includes(f) || e.service.toLowerCase().includes(f)));
  return (
    <div className="timeline-view ecs-events-view ecs-pad" data-testid="ecs-events">
      <div className="view-header">
        <h1>Service events</h1>
        <span className="count">{shown.length}</span>
        <div className="spacer" />
        <label className="check">
          <input type="checkbox" checked={onlyWarnings} onChange={(e) => setOnlyWarnings(e.target.checked)} /> Warnings only
        </label>
        <input className="search" placeholder="Filter events…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter events" />
      </div>
      <LoadState loading={events.loading && !events.data} error={events.error} what="events" />
      <ul className="plain-list ecs-events">
        {shown.map((e) => (
          <li key={`${e.service}:${e.id}`} className={isWarningEvent(e.message) ? 'ecs-event-warn' : ''}>
            <span className="muted" title={when(e.createdAt)}>
              {ago(e.createdAt)} ago
            </span>{' '}
            <button className="link" onClick={() => setView({ type: 'services', select: e.service })}>
              {e.service}
            </button>{' '}
            {e.message}
          </li>
        ))}
      </ul>
      {events.data && shown.length === 0 && <div className="empty">No events{f || onlyWarnings ? ' match the filter' : ''}.</div>}
    </div>
  );
}

// ---- Security ----

const SEV: EcsSeverity[] = ['critical', 'high', 'medium', 'low'];
const SEV_ICON: Record<EcsSeverity, string> = { critical: '⛔', high: '▲', medium: '◆', low: '●' };

export function EcsSecurityView() {
  const { cluster, setView } = useEcs();
  const scan = useLoad(() => (cluster ? call('ecs:scan', cluster) : Promise.resolve(null)), [cluster]);
  const [sev, setSev] = useState<EcsSeverity | ''>('');
  if (!cluster) return <NoCluster />;
  const r = scan.data;
  const shown = (r?.findings ?? []).filter((f) => !sev || f.severity === sev);
  const open = (f: EcsFinding) => {
    if (f.targetKind === 'service') setView({ type: 'services', select: f.targetName });
    else if (f.targetKind === 'task-definition') setView({ type: 'taskdefs', family: f.targetName.split(':')[0] });
  };
  return (
    <div className="security-view ecs-pad" data-testid="ecs-security">
      <div className="view-header">
        <h1>Security Scan</h1>
        <span className="muted">services, task definitions in use, and their security groups</span>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => void scan.reload()}>
          Rescan
        </button>
      </div>
      <LoadState loading={scan.loading} error={scan.error} what="scan" />
      {r && (
        <>
          <div className="cards">
            <div className={`card score-card ${r.score >= 80 ? 'card-ok' : r.score >= 50 ? 'card-warn' : 'card-error'}`}>
              <div className="card-title">Posture score</div>
              <div className="card-value" data-testid="ecs-score">
                {r.score}
                <span className="score-of">/100</span>
              </div>
              <div className="card-sub">
                {r.scanned.services} services · {r.scanned.taskDefinitions} task definitions · {r.scanned.securityGroups} security groups
              </div>
            </div>
            {SEV.map((s) => (
              <button key={s} className={`card sev-card sev-${s} ${sev === s ? 'active' : ''}`} onClick={() => setSev((x) => (x === s ? '' : s))}>
                <div className="card-title">
                  {SEV_ICON[s]} {s}
                </div>
                <div className="card-value">{r.counts[s]}</div>
              </button>
            ))}
          </div>
          {r.notes.map((n) => (
            <div key={n} className="inline-warn">
              {n}
            </div>
          ))}
          <div className="findings">
            {shown.map((f) => (
              <EcsFindingRow key={f.id} f={f} onOpen={() => open(f)} />
            ))}
            {shown.length === 0 && <div className="empty">No findings{sev ? ` with severity ${sev}` : ''}.</div>}
          </div>
        </>
      )}
    </div>
  );
}

function EcsFindingRow({ f, onOpen }: { f: EcsFinding; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`finding sev-${f.severity}`} data-testid="finding">
      <button className="finding-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`sev-chip sev-${f.severity}`}>
          {SEV_ICON[f.severity]} {f.severity}
        </span>
        <span className="finding-title">{f.title}</span>
        <span className="muted finding-target">{f.target}</span>
      </button>
      {open && (
        <div className="finding-body">
          <p>{f.detail}</p>
          <p>
            <b>Remediation:</b> {f.remediation}
          </p>
          {(f.targetKind === 'service' || f.targetKind === 'task-definition') && (
            <button className="btn btn-sm" onClick={onOpen}>
              Open {f.targetKind === 'service' ? 'service' : 'task definition'}
            </button>
          )}
          {f.targetKind === 'task-definition' && <p className="muted">Fix it by editing the task definition, registering a new revision, then deploying that revision to the service.</p>}
        </div>
      )}
    </div>
  );
}
