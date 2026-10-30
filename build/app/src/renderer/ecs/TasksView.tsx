import { useEffect, useState } from 'react';
import { arnName, taskStatus, type EcsTask } from '../../shared/ecs';
import { call, errorMessage } from '../lib/api';
import { useDialogs, useToast } from '../components/Dialogs';
import { YamlEditor } from '../components/YamlEditor';
import { useSelection } from '../lib/selection';
import { DataTable, LoadState, NoCluster, Props, ReadOnlyNote, useLoad } from './common';
import { EcsLogPanel } from './LogPanel';
import { ExtensionActions } from '../components/ExtensionActions';
import { StatusBadge, taskCols, taskLabel, useEcs, when } from './shared';

type Tab = 'overview' | 'logs' | 'shell' | 'json';
export type ExecTarget = { cluster: string; task: string; container: string; title: string };

export function EcsTasksView({ dark, service, select, onExec }: { dark: boolean; service?: string; select?: string; onExec: (t: ExecTarget) => void }) {
  const { cluster, setView } = useEcs();
  const [desired, setDesired] = useState<'RUNNING' | 'STOPPED' | 'ALL'>('ALL');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(select ?? null);
  const tasks = useLoad(() => (cluster ? call('ecs:tasks', cluster, { serviceName: service, desiredStatus: desired }) : Promise.resolve([])), [cluster, service, desired], 10000);
  const { setSelection } = useSelection();
  useEffect(() => setSelected(select ?? null), [select, cluster]);
  const sel = tasks.data?.find((t) => t.arn === selected);
  useEffect(() => {
    setSelection(sel ? { kind: 'ECS task', name: sel.id } : null);
    return () => setSelection(null);
  }, [sel, setSelection]);

  if (!cluster) return <NoCluster />;
  return (
    <div className={`resource-view ${sel ? 'with-details' : ''}`}>
      <div className="list-pane">
        <div className="view-header">
          <h1>Tasks{service ? ` · ${service}` : ''}</h1>
          <span className="count">{tasks.data?.length ?? 0}</span>
          {service && (
            <button className="btn btn-sm" onClick={() => setView({ type: 'tasks' })}>
              All services
            </button>
          )}
          <div className="spacer" />
          <div className="segmented" role="radiogroup" aria-label="Task state">
            {(['ALL', 'RUNNING', 'STOPPED'] as const).map((d) => (
              <button key={d} role="radio" aria-checked={desired === d} className={desired === d ? 'active' : ''} onClick={() => setDesired(d)}>
                {d === 'ALL' ? 'All' : d === 'RUNNING' ? 'Running' : 'Stopped'}
              </button>
            ))}
          </div>
          <input className="search" placeholder="Filter by id, service, revision…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tasks" />
          <button className="btn btn-sm" onClick={() => void tasks.reload()}>
            Refresh
          </button>
        </div>
        <p className="muted ecs-hint">ECS keeps stopped tasks for about an hour; their stop reason explains crashes and failed health checks.</p>
        <LoadState loading={tasks.loading && !tasks.data} error={tasks.error} what="tasks" />
        {tasks.data && (
          <DataTable
            rows={tasks.data}
            cols={taskCols}
            rowKey={(t) => t.arn}
            selected={selected}
            onSelect={(t) => setSelected(t.arn)}
            filter={filter}
            match={(t, f) => [t.id, t.serviceName ?? '', t.group ?? '', arnName(t.taskDefinition), t.lastStatus, t.privateIp ?? ''].some((x) => x.toLowerCase().includes(f))}
            empty={filter ? 'No tasks match the filter.' : 'No tasks.'}
            initialSort={{ key: 'age', dir: 1 }}
            testId="ecs-task-row"
          />
        )}
      </div>
      {sel && <TaskDetails key={sel.arn} task={sel} dark={dark} onClose={() => setSelected(null)} onChanged={() => void tasks.reload()} onExec={onExec} />}
    </div>
  );
}

function TaskDetails({ task: t, dark, onClose, onChanged, onExec }: { task: EcsTask; dark: boolean; onClose: () => void; onChanged: () => void; onExec: (t: ExecTarget) => void }) {
  const { cluster, readOnly, setView } = useEcs();
  const [tab, setTab] = useState<Tab>('overview');
  const { confirm } = useDialogs();
  const toast = useToast();
  const stop = async () => {
    if (!(await confirm({ title: 'Stop task', message: `Stop task ${t.id}?${t.serviceName ? ` Service ${t.serviceName} will start a replacement to keep its desired count.` : ' It is not part of a service, so nothing replaces it.'}`, danger: true, confirmLabel: 'Stop task', typeToConfirm: t.serviceName ? undefined : t.id.slice(0, 8) })))
      return;
    try {
      await call('ecs:stopTask', cluster, t.arn, 'Stopped from K8sConsole');
      toast('success', `Stopping task ${t.id.slice(0, 12)}`);
      onChanged();
    } catch (err) {
      toast('error', `Stop failed: ${errorMessage(err)}`);
    }
  };
  const containers = t.containers.map((c) => c.name);
  return (
    <aside className="details" aria-label="Task details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-tag">Task</span>
          <h2 className="mono" title={t.arn}>
            {t.id}
          </h2>
          <StatusBadge status={taskStatus(t)} label={taskLabel(t)} />
        </div>
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="details-actions">
        <button className="btn btn-sm btn-danger" onClick={() => void stop()} disabled={readOnly || t.lastStatus === 'STOPPED' || t.desiredStatus === 'STOPPED'} title={readOnly ? 'Read-only connection' : undefined}>
          Stop
        </button>
        {t.serviceName && (
          <button className="btn btn-sm" onClick={() => setView({ type: 'services', select: t.serviceName })}>
            Service
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setView({ type: 'taskdefs', family: arnName(t.taskDefinition).split(':')[0] })}>
          Task definition
        </button>
        <ReadOnlyNote />
        <ExtensionActions kind="EcsTask" values={{ task: t.id, cluster: arnName(cluster), name: t.id, service: t.serviceName, region: t.arn.split(':')[3] ?? '' }} />
      </div>
      <nav className="tabs" role="tablist">
        {(
          [
            ['overview', 'Overview'],
            ['logs', 'Logs'],
            ['shell', 'Shell'],
            ['json', 'JSON'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="details-body">
        {tab === 'overview' && <TaskOverview t={t} />}
        {tab === 'logs' && <EcsLogPanel cluster={cluster} taskArn={t.arn} containers={containers} title={`task-${t.id}`} />}
        {tab === 'shell' && <ExecTab t={t} onExec={onExec} />}
        {tab === 'json' && <YamlEditor value={JSON.stringify(t, null, 2)} readOnly dark={dark} language="json" />}
      </div>
    </aside>
  );
}

function TaskOverview({ t }: { t: EcsTask }) {
  return (
    <div>
      {t.stoppedReason && <div className={taskStatus(t) === 'error' ? 'inline-error' : 'inline-warn'}>Stopped: {t.stoppedReason}{t.stopCode ? ` (${t.stopCode})` : ''}</div>}
      <Props
        items={[
          ['Status', `${t.lastStatus} (desired ${t.desiredStatus})${t.health ? ` · health ${t.health}` : ''}`],
          ['Service', t.serviceName],
          ['Group', !t.serviceName ? t.group : undefined],
          ['Task definition', <span className="mono">{arnName(t.taskDefinition)}</span>],
          ['Launch', t.launchType ?? t.capacityProvider],
          ['Size', t.cpu ? `${Number(t.cpu) / 1024} vCPU · ${t.memory} MB` : undefined],
          ['Zone', t.az],
          ['Private IP', t.privateIp],
          ['Network interface', t.eni],
          ['Container instance', t.containerInstanceArn ? arnName(t.containerInstanceArn) : undefined],
          ['ECS Exec', t.enableExecuteCommand ? 'enabled' : 'disabled'],
          ['Created', when(t.createdAt)],
          ['Started', when(t.startedAt)],
          ['Stopped', when(t.stoppedAt)],
        ]}
      />
      <h3 className="sub-h">Containers</h3>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Health</th>
            <th>Exit</th>
            <th>Image</th>
          </tr>
        </thead>
        <tbody>
          {t.containers.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>{c.lastStatus}</td>
              <td>{c.health ?? '–'}</td>
              <td title={c.reason}>
                {c.exitCode ?? '–'}
                {c.reason ? ` · ${c.reason}` : ''}
              </td>
              <td className="mono cell-wrap">{c.image}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExecTab({ t, onExec }: { t: EcsTask; onExec: (x: ExecTarget) => void }) {
  const { cluster } = useEcs();
  const [container, setContainer] = useState(t.containers[0]?.name ?? '');
  const info = useLoad(() => call('ecs:execInfo', cluster, t.arn, container), [cluster, t.arn, container]);
  return (
    <div>
      <p className="muted">ECS Exec opens an interactive shell inside a running container through AWS Systems Manager. K8sConsole connects directly with your AWS connection: no aws CLI or Session Manager plugin needed.</p>
      {t.containers.length > 1 && (
        <label className="field">
          <span>Container</span>
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {t.containers.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
      )}
      <LoadState loading={info.loading} error={info.error} what="ECS Exec status" />
      {info.data && !info.data.available && <div className="inline-warn" data-testid="ecs-exec-unavailable">{info.data.reason}</div>}
      {info.data?.available && (
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => onExec({ cluster, task: t.arn, container, title: `${t.serviceName ?? t.id.slice(0, 8)}/${container}` })}>
            Open shell in terminal
          </button>
        </div>
      )}
    </div>
  );
}
