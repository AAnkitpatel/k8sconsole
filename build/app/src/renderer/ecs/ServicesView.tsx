import { useEffect, useMemo, useState } from 'react';
import { arnName, serviceStatus, serviceSummary, type EcsService, type EcsTask } from '../../shared/ecs';
import type { AppSettings } from '../../shared/types';
import { call, errorMessage } from '../lib/api';
import { Modal, useDialogs, useToast } from '../components/Dialogs';
import { YamlEditor } from '../components/YamlEditor';
import { LineChart, SERIES } from '../components/charts';
import { useSelection } from '../lib/selection';
import { DataTable, LoadState, NoCluster, Props, ReadOnlyNote, pct, useLoad, type Col } from './common';
import { EcsLogPanel } from './LogPanel';
import { StatusBadge, ago, isWarningEvent, taskCols, useEcs, when } from './shared';

type Tab = 'overview' | 'deployments' | 'tasks' | 'events' | 'logs' | 'metrics' | 'targets' | 'json';

const SERVICE_TEMPLATE = (cluster: string) =>
  JSON.stringify(
    {
      serviceName: 'my-service',
      taskDefinition: 'my-family:1',
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-…'], securityGroups: ['sg-…'], assignPublicIp: 'DISABLED' } },
      deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, minimumHealthyPercent: 100, maximumPercent: 200 },
      enableExecuteCommand: false,
      propagateTags: 'SERVICE',
      tags: [{ key: 'managed-by', value: 'k8sconsole' }],
      _cluster: arnName(cluster),
    },
    null,
    2,
  ).replace(/,\n {2}"_cluster": "[^"]*"/, '');

export function EcsServicesView({ settings, dark, select, onExec }: { settings: AppSettings; dark: boolean; select?: string; onExec: (t: { cluster: string; task: string; container: string; title: string }) => void }) {
  const { cluster, readOnly } = useEcs();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(select ?? null);
  const [creating, setCreating] = useState(false);
  const services = useLoad(() => (cluster ? call('ecs:services', cluster) : Promise.resolve([])), [cluster], 15000);
  const { setSelection } = useSelection();

  useEffect(() => setSelected(select ?? null), [select, cluster]);
  useEffect(() => {
    setSelection(selected ? { kind: 'ECS service', name: selected } : null);
    return () => setSelection(null);
  }, [selected, setSelection]);

  const cols: Col<EcsService>[] = [
    { key: 'name', title: 'Name', render: (s) => <span className="cell-name">{s.name}</span>, sort: (s) => s.name },
    { key: 'state', title: 'Status', render: (s) => <StatusBadge status={serviceStatus(s)} label={serviceSummary(s)} />, sort: (s) => serviceStatus(s) },
    { key: 'tasks', title: 'Running', render: (s) => `${s.running} / ${s.desired}${s.pending ? ` (+${s.pending} pending)` : ''}`, sort: (s) => s.running },
    { key: 'td', title: 'Task definition', render: (s) => <span className="mono">{arnName(s.taskDefinition)}</span>, sort: (s) => arnName(s.taskDefinition) },
    { key: 'launch', title: 'Launch', render: (s) => s.launchType ?? s.capacityProviders.join(', ') ?? '', sort: (s) => s.launchType ?? '' },
    { key: 'lb', title: 'Load balancing', render: (s) => (s.loadBalancers.length ? s.loadBalancers.map((l) => `${l.containerName}:${l.containerPort}`).join(', ') : s.serviceRegistries ? 'service discovery' : '–') },
    { key: 'age', title: 'Created', render: (s) => ago(s.createdAt), sort: (s) => -(s.createdAt ?? 0) },
  ];

  if (!cluster) return <NoCluster />;
  const sel = services.data?.find((s) => s.name === selected);
  return (
    <div className={`resource-view ${sel ? 'with-details' : ''}`}>
      <div className="list-pane">
        <div className="view-header">
          <h1>Services</h1>
          <span className="count">{services.data?.length ?? 0}</span>
          <ReadOnlyNote />
          <div className="spacer" />
          <input className="search" placeholder="Filter services…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter services" />
          <button className="btn btn-sm" onClick={() => void services.reload()}>
            Refresh
          </button>
          <button className="btn btn-sm" onClick={() => setCreating(true)} disabled={readOnly} title={readOnly ? 'Read-only connection' : 'Create a service from JSON'}>
            Create
          </button>
        </div>
        <LoadState loading={services.loading && !services.data} error={services.error} what="services" />
        {services.data && (
          <DataTable
            rows={services.data}
            cols={cols}
            rowKey={(s) => s.name}
            selected={selected}
            onSelect={(s) => setSelected(s.name)}
            filter={filter}
            match={(s, f) => s.name.toLowerCase().includes(f) || s.taskDefinition.toLowerCase().includes(f)}
            empty={filter ? 'No services match the filter.' : 'This cluster has no services.'}
            testId="ecs-service-row"
          />
        )}
      </div>
      {sel && <ServiceDetails key={sel.arn} service={sel} dark={dark} settings={settings} onClose={() => setSelected(null)} onChanged={() => void services.reload()} onExec={onExec} />}
      {creating && <CreateServiceDialog dark={dark} onClose={() => setCreating(false)} onCreated={(name) => (setCreating(false), void services.reload(), setSelected(name))} />}
    </div>
  );
}

function ServiceDetails({ service: s, dark, settings, onClose, onChanged, onExec }: { service: EcsService; dark: boolean; settings: AppSettings; onClose: () => void; onChanged: () => void; onExec: (t: { cluster: string; task: string; container: string; title: string }) => void }) {
  const { cluster, readOnly, setView } = useEcs();
  const [tab, setTab] = useState<Tab>('overview');
  const [deploying, setDeploying] = useState(false);
  const { confirm, prompt } = useDialogs();
  const toast = useToast();

  const act = async (label: string, fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast('success', success);
      onChanged();
    } catch (err) {
      toast('error', `${label} failed: ${errorMessage(err)}`);
    }
  };

  const scale = async () => {
    const v = await prompt({
      title: `Scale ${s.name}`,
      label: 'Desired tasks',
      initial: String(s.desired),
      validate: (x) => (/^\d+$/.test(x.trim()) && Number(x) <= 5000 ? null : 'Enter a whole number from 0 to 5000'),
      confirmLabel: 'Scale',
    });
    if (v === null) return;
    const n = Number(v);
    if (n === 0 && !(await confirm({ title: 'Scale to zero', message: `Stop every task of ${s.name}? The service stays defined but serves nothing until scaled up again.`, danger: true, confirmLabel: 'Scale to zero', typeToConfirm: settings.confirmDestructiveActions ? s.name : undefined }))) return;
    await act('Scale', () => call('ecs:updateService', cluster, s.name, { desiredCount: n }), `${s.name}: desired count set to ${n}`);
  };

  const redeploy = async () => {
    if (await confirm({ title: 'Force new deployment', message: `Start new tasks for ${s.name} with the same task definition (${arnName(s.taskDefinition)}) and replace the running ones? Use this to pick up a new image pushed under the same tag or rotated secrets.`, confirmLabel: 'Redeploy' }))
      await act('Redeploy', () => call('ecs:updateService', cluster, s.name, { forceNewDeployment: true }), `New deployment of ${s.name} started`);
  };

  const toggleExec = async () => {
    const on = !s.enableExecuteCommand;
    if (await confirm({ title: `${on ? 'Enable' : 'Disable'} ECS Exec`, message: `${on ? 'Allow' : 'Stop allowing'} interactive shells into ${s.name}'s containers. This applies to tasks started after the change, so ECS starts a new deployment.`, confirmLabel: on ? 'Enable' : 'Disable' }))
      await act('ECS Exec', () => call('ecs:updateService', cluster, s.name, { enableExecuteCommand: on, forceNewDeployment: true }), `ECS Exec ${on ? 'enabled' : 'disabled'} for ${s.name}`);
  };

  const remove = async () => {
    const running = s.desired > 0 || s.running > 0;
    if (!(await confirm({ title: 'Delete service', message: `Delete service ${s.name}${running ? ` and stop its ${s.running} running task${s.running === 1 ? '' : 's'}` : ''}? The task definition and load balancer are kept. This cannot be undone.`, danger: true, confirmLabel: 'Delete', typeToConfirm: s.name }))) return;
    await act('Delete', () => call('ecs:deleteService', cluster, s.name, running), `Deleted service ${s.name}`);
    onClose();
  };

  const writeTitle = readOnly ? 'Read-only connection' : undefined;
  const tabs: Array<[Tab, string]> = [
    ['overview', 'Overview'],
    ['deployments', `Deployments${s.deployments.length > 1 ? ` (${s.deployments.length})` : ''}`],
    ['tasks', 'Tasks'],
    ['events', 'Events'],
    ['logs', 'Logs'],
    ['metrics', 'Metrics'],
    ['targets', 'Targets'],
    ['json', 'JSON'],
  ];
  return (
    <aside className="details" aria-label="Service details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-tag">Service</span>
          <h2 title={s.name}>{s.name}</h2>
          <StatusBadge status={serviceStatus(s)} label={serviceSummary(s)} />
        </div>
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="details-actions">
        <button className="btn btn-sm" onClick={() => void scale()} disabled={readOnly} title={writeTitle} data-testid="ecs-scale">
          Scale
        </button>
        <button className="btn btn-sm" onClick={() => void redeploy()} disabled={readOnly} title={writeTitle}>
          Redeploy
        </button>
        <button className="btn btn-sm" onClick={() => setDeploying(true)} disabled={readOnly} title={writeTitle ?? 'Deploy another task definition revision (rollback or upgrade)'}>
          Deploy revision
        </button>
        <button className="btn btn-sm" onClick={() => void toggleExec()} disabled={readOnly} title={writeTitle}>
          {s.enableExecuteCommand ? 'Disable ECS Exec' : 'Enable ECS Exec'}
        </button>
        <button className="btn btn-sm" onClick={() => setView({ type: 'taskdefs', family: arnName(s.taskDefinition).split(':')[0] })}>
          Task definition
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={readOnly} title={writeTitle}>
          Delete
        </button>
        <ReadOnlyNote />
      </div>
      <nav className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="details-body">
        {tab === 'overview' && <ServiceOverview s={s} />}
        {tab === 'deployments' && <Deployments s={s} />}
        {tab === 'tasks' && <ServiceTasks s={s} onExec={onExec} />}
        {tab === 'events' && <ServiceEvents s={s} />}
        {tab === 'logs' && <ServiceLogs s={s} />}
        {tab === 'metrics' && <ServiceMetrics s={s} />}
        {tab === 'targets' && <Targets s={s} />}
        {tab === 'json' && <YamlEditor value={JSON.stringify(s, null, 2)} readOnly dark={dark} language="json" />}
      </div>
      {deploying && <DeployRevisionDialog s={s} onClose={() => setDeploying(false)} onDone={() => (setDeploying(false), onChanged())} />}
    </aside>
  );
}

function ServiceOverview({ s }: { s: EcsService }) {
  const primary = s.deployments.find((d) => d.status === 'PRIMARY');
  return (
    <div>
      <Props
        items={[
          ['Tasks', `${s.running} running · ${s.pending} pending · ${s.desired} desired`],
          ['Task definition', <span className="mono">{arnName(s.taskDefinition)}</span>],
          ['Rollout', primary ? `${primary.rolloutState ?? primary.status}${primary.rolloutReason ? ` — ${primary.rolloutReason}` : ''}` : undefined],
          ['Launch', s.launchType ?? (s.capacityProviders.length ? `capacity providers: ${s.capacityProviders.join(', ')}` : undefined)],
          ['Platform version', s.platformVersion],
          ['Scheduling', s.schedulingStrategy],
          ['Deployment', `${s.deploymentController ?? 'ECS'} rolling · min ${s.minimumHealthyPercent ?? '–'}% · max ${s.maximumPercent ?? '–'}%`],
          ['Circuit breaker', s.circuitBreaker ? `${s.circuitBreaker.enable ? 'on' : 'off'}${s.circuitBreaker.rollback ? ', rolls back' : ''}` : 'off'],
          ['Health check grace', s.healthCheckGracePeriodSeconds !== undefined ? `${s.healthCheckGracePeriodSeconds}s` : undefined],
          ['Load balancers', s.loadBalancers.length ? s.loadBalancers.map((l) => `${l.targetGroupArn ? arnName(l.targetGroupArn.replace(/\/[0-9a-f]+$/, '')) : l.loadBalancerName} → ${l.containerName}:${l.containerPort}`).join(', ') : undefined],
          ['Subnets', s.network?.subnets.join(', ')],
          ['Security groups', s.network?.securityGroups.join(', ')],
          ['Public IP', s.network?.assignPublicIp],
          ['ECS Exec', s.enableExecuteCommand ? 'enabled' : 'disabled'],
          ['Created', when(s.createdAt)],
          ['ARN', <span className="mono cell-wrap">{s.arn}</span>],
        ]}
      />
      {Object.keys(s.tags).length > 0 && (
        <>
          <h3 className="sub-h">Tags</h3>
          <div className="chips">
            {Object.entries(s.tags).map(([k, v]) => (
              <span key={k} className="chip">
                {k}={v}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Deployments({ s }: { s: EcsService }) {
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Rollout</th>
          <th>Revision</th>
          <th>Tasks</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {s.deployments.map((d) => (
          <tr key={d.id}>
            <td>{d.status}</td>
            <td title={d.rolloutReason}>{d.rolloutState ?? '–'}</td>
            <td className="mono">{arnName(d.taskDefinition)}</td>
            <td>
              {d.running}/{d.desired}
              {d.pending ? ` +${d.pending}` : ''}
              {d.failed ? ` · ${d.failed} failed` : ''}
            </td>
            <td>{ago(d.updatedAt)} ago</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServiceTasks({ s, onExec }: { s: EcsService; onExec: (t: { cluster: string; task: string; container: string; title: string }) => void }) {
  const { cluster, setView } = useEcs();
  const tasks = useLoad(() => call('ecs:tasks', cluster, { serviceName: s.name, desiredStatus: 'ALL' }), [cluster, s.name], 15000);
  void onExec;
  return (
    <div>
      <LoadState loading={tasks.loading && !tasks.data} error={tasks.error} what="tasks" />
      {tasks.data && <DataTable<EcsTask> rows={tasks.data} cols={taskCols.filter((c) => c.key !== 'service')} rowKey={(t) => t.arn} onSelect={(t) => setView({ type: 'tasks', service: s.name, select: t.arn })} empty="No running or recently stopped tasks." testId="ecs-service-task-row" />}
    </div>
  );
}

function ServiceEvents({ s }: { s: EcsService }) {
  if (!s.events.length) return <div className="empty">No events.</div>;
  return (
    <ul className="plain-list ecs-events">
      {s.events.map((e) => (
        <li key={e.id} className={isWarningEvent(e.message) ? 'ecs-event-warn' : ''}>
          <span className="muted">{when(e.createdAt)}</span> {e.message}
        </li>
      ))}
    </ul>
  );
}

function ServiceLogs({ s }: { s: EcsService }) {
  const { cluster } = useEcs();
  const td = useLoad(() => call('ecs:taskDefinition', s.taskDefinition), [s.taskDefinition]);
  const containers = useMemo(() => {
    try {
      return (JSON.parse(td.data?.json ?? '{}').containerDefinitions ?? []).map((c: any) => String(c.name));
    } catch {
      return [];
    }
  }, [td.data]);
  if (!td.data) return <LoadState loading={td.loading} error={td.error} what="task definition" />;
  return <EcsLogPanel cluster={cluster} serviceName={s.name} containers={containers} title={`${s.name}`} />;
}

function ServiceMetrics({ s }: { s: EcsService }) {
  const { cluster } = useEcs();
  const [minutes, setMinutes] = useState(180);
  const m = useLoad(() => call('ecs:metrics', cluster, [s.name], minutes), [cluster, s.name, minutes], 60000);
  const series = m.data?.services[s.name];
  return (
    <div>
      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {[
            [60, '1h'],
            [180, '3h'],
            [1440, '24h'],
            [10080, '7d'],
          ].map(([v, l]) => (
            <button key={v} role="radio" aria-checked={minutes === v} className={minutes === v ? 'active' : ''} onClick={() => setMinutes(v as number)}>
              {l}
            </button>
          ))}
        </div>
        <span className="muted">CloudWatch AWS/ECS · average · percent of the reserved CPU and memory</span>
      </div>
      <LoadState loading={m.loading && !m.data} error={m.error} what="metrics" />
      {series && series.t.length === 0 && <div className="empty">No CloudWatch data for this period{s.running === 0 ? ' (the service has no running tasks)' : ''}.</div>}
      {series && series.t.length > 0 && (
        <>
          <LineChart title="CPU utilization" t={series.t} series={[{ name: 'CPU', values: series.cpu, color: SERIES[0] }]} format={pct} reference={{ value: 100, label: 'reserved' }} />
          <LineChart title="Memory utilization" t={series.t} series={[{ name: 'Memory', values: series.mem, color: SERIES[1] }]} format={pct} reference={{ value: 100, label: 'reserved' }} />
        </>
      )}
    </div>
  );
}

function Targets({ s }: { s: EcsService }) {
  const { cluster } = useEcs();
  const t = useLoad(() => call('ecs:targetHealth', cluster, s.name), [cluster, s.name], 20000);
  if (!s.loadBalancers.length) return <div className="empty">This service is not attached to a load balancer.</div>;
  return (
    <div>
      <LoadState loading={t.loading && !t.data} error={t.error} what="target health" />
      {t.data?.map((g) => (
        <div key={g.targetGroupArn} className="detail-section">
          <h3 className="sub-h">
            {g.targetGroupName} <span className="muted">({g.protocol} {g.port}{g.healthCheckPath ? ` · health check ${g.healthCheckPath}` : ''} · {g.loadBalancers.join(', ')})</span>
          </h3>
          {g.targets.length === 0 ? (
            <div className="muted">No registered targets.</div>
          ) : (
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Port</th>
                  <th>State</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {g.targets.map((x) => (
                  <tr key={`${x.id}:${x.port}`}>
                    <td className="mono">{x.id}</td>
                    <td>{x.port}</td>
                    <td>
                      <StatusBadge status={x.state === 'healthy' ? 'ok' : x.state === 'unhealthy' ? 'error' : 'pending'} label={x.state} />
                    </td>
                    <td className="cell-wrap">{x.description ?? x.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function DeployRevisionDialog({ s, onClose, onDone }: { s: EcsService; onClose: () => void; onDone: () => void }) {
  const { cluster } = useEcs();
  const family = arnName(s.taskDefinition).split(':')[0];
  const revs = useLoad(() => call('ecs:revisions', family), [family]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (revs.data && !pick) setPick(revs.data.find((a) => a !== s.taskDefinition) ?? revs.data[0] ?? '');
  }, [revs.data, pick, s.taskDefinition]);
  const current = Number(s.taskDefinition.slice(s.taskDefinition.lastIndexOf(':') + 1));
  const target = Number(pick.slice(pick.lastIndexOf(':') + 1));
  const deploy = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('ecs:updateService', cluster, s.name, { taskDefinition: pick });
      toast('success', `Deploying ${arnName(pick)} to ${s.name}`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Deploy a revision to ${s.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void deploy()} disabled={busy || !pick || pick === s.taskDefinition}>
            {target < current ? 'Roll back' : 'Deploy'}
          </button>
        </>
      }
    >
      <p>
        Currently running <b className="mono">{arnName(s.taskDefinition)}</b>. ECS replaces the tasks with a rolling deployment
        {s.circuitBreaker?.rollback ? ' and rolls back automatically if the new tasks fail' : ''}.
      </p>
      <LoadState loading={revs.loading} error={revs.error} what="revisions" />
      {revs.data && (
        <label className="field">
          <span>Revision</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Revision">
            {revs.data.map((a) => (
              <option key={a} value={a}>
                {arnName(a)}
                {a === s.taskDefinition ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="inline-error">{error}</div>}
    </Modal>
  );
}

function CreateServiceDialog({ dark, onClose, onCreated }: { dark: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const { cluster, clusterInfo } = useEcs();
  const [text, setText] = useState(() => SERVICE_TEMPLATE(cluster));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await call('ecs:createService', cluster, text);
      toast('success', `Created service ${s.name}`);
      onCreated(s.name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={`Create service in ${clusterInfo?.name ?? arnName(cluster)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
            Create service
          </button>
        </>
      }
    >
      <p className="muted">
        A CreateService request as JSON (the cluster is filled in for you). ECS has no dry run, so check the task definition revision, subnets and security groups before creating.
      </p>
      <div className="create-editor">
        <YamlEditor value={text} onChange={setText} dark={dark} language="json" />
      </div>
      {error && <div className="inline-error">{error}</div>}
    </Modal>
  );
}
