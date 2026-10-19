import { useEffect, useMemo, useState } from 'react';
import { arnName } from '../../shared/ecs';
import { call, errorMessage } from '../lib/api';
import { Modal, useDialogs, useToast } from '../components/Dialogs';
import { YamlEditor } from '../components/YamlEditor';
import { LoadState, ReadOnlyNote, useLoad } from './common';
import { useEcs, when } from './shared';

export function EcsTaskDefsView({ dark, family: initialFamily }: { dark: boolean; family?: string }) {
  const { readOnly, setView } = useEcs();
  const [filter, setFilter] = useState('');
  const [family, setFamily] = useState(initialFamily ?? '');
  const families = useLoad(() => call('ecs:families'), []);
  const revisions = useLoad(() => (family ? call('ecs:revisions', family) : Promise.resolve([] as string[])), [family]);
  // The chosen revision only counts while it belongs to the loaded family; otherwise the newest is shown.
  const [picked, setPicked] = useState('');
  const revision = picked && revisions.data?.includes(picked) ? picked : (revisions.data?.[0] ?? '');
  const td = useLoad(() => (revision ? call('ecs:taskDefinition', revision) : Promise.resolve(null)), [revision]);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();
  const toast = useToast();

  useEffect(() => setFamily(initialFamily ?? ''), [initialFamily]);
  useEffect(() => {
    if (!family && families.data?.length) setFamily(families.data[0].family);
  }, [families.data, family]);
  useEffect(() => setText(td.data?.json ?? ''), [td.data]);

  const dirty = !!td.data && text !== td.data.json;
  const shown = useMemo(() => (families.data ?? []).filter((f) => f.family.toLowerCase().includes(filter.trim().toLowerCase())), [families.data, filter]);

  const register = async () => {
    if (!(await confirm({ title: 'Register new revision', message: `Register your edited copy as a new revision of ${family}? Running services keep their current revision until you deploy the new one.`, confirmLabel: 'Register' }))) return;
    setBusy(true);
    try {
      const r = await call('ecs:registerTaskDefinition', text);
      toast('success', `Registered ${arnName(r.arn)}`);
      await revisions.reload();
      setPicked(r.arn);
    } catch (err) {
      toast('error', `Register failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const deregister = async () => {
    if (!(await confirm({ title: 'Deregister revision', message: `Deregister ${arnName(revision)}? Services already running it keep running, but it cannot be used for new tasks or deployments.`, danger: true, confirmLabel: 'Deregister', typeToConfirm: arnName(revision) }))) return;
    try {
      await call('ecs:deregisterTaskDefinition', revision);
      toast('success', `Deregistered ${arnName(revision)}`);
      await revisions.reload();
    } catch (err) {
      toast('error', `Deregister failed: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="crd-view ecs-taskdefs">
      <div className="crd-list">
        <input className="search" placeholder="Filter families…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter task definition families" />
        <LoadState loading={families.loading} error={families.error} what="task definitions" />
        {shown.map((f) => (
          <button key={f.family} className={`crd-item ${f.family === family ? 'active' : ''}`} onClick={() => setFamily(f.family)} data-testid="ecs-family">
            {f.family} <span className="muted">:{f.latestRevision}</span>
          </button>
        ))}
        {families.data && !shown.length && <div className="empty">No task definitions.</div>}
      </div>
      <div className="crd-content">
        <div className="view-header">
          <h1>{family || 'Task definitions'}</h1>
          {revisions.data && revisions.data.length > 0 && (
            <select value={revision} onChange={(e) => setPicked(e.target.value)} aria-label="Revision">
              {revisions.data.map((a) => (
                <option key={a} value={a}>
                  revision {a.slice(a.lastIndexOf(':') + 1)}
                </option>
              ))}
            </select>
          )}
          {td.data?.registeredAt && <span className="muted">registered {when(td.data.registeredAt)}</span>}
          <ReadOnlyNote />
          <div className="spacer" />
          <button className="btn btn-sm" onClick={() => setRunning(true)} disabled={readOnly || !revision} title={readOnly ? 'Read-only connection' : 'Run a one-off task from this revision'}>
            Run task
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => void register()} disabled={readOnly || !dirty || busy} title={readOnly ? 'Read-only connection' : dirty ? 'Register the edited JSON as a new revision' : 'Edit the JSON to register a new revision'}>
            Register new revision
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => void deregister()} disabled={readOnly || !revision}>
            Deregister
          </button>
          <button className="btn btn-sm" onClick={() => setView({ type: 'services' })}>
            Services
          </button>
        </div>
        <p className="muted ecs-hint">
          Edit the JSON and register it to create a new revision (read-only fields such as the ARN and revision number are dropped automatically). Then use <b>Deploy revision</b> on a service to roll it out.
        </p>
        <LoadState loading={(revisions.loading || td.loading) && !!family} error={revisions.error ?? td.error} what="revision" />
        {td.data && (
          <div className="ecs-td-editor">
            <YamlEditor value={text} onChange={setText} dark={dark} language="json" readOnly={readOnly} />
          </div>
        )}
      </div>
      {running && td.data && <RunTaskDialog revision={revision} json={td.data.json} onClose={() => setRunning(false)} />}
    </div>
  );
}

function RunTaskDialog({ revision, json, onClose }: { revision: string; json: string; onClose: () => void }) {
  const { cluster, setView } = useEcs();
  const services = useLoad(() => call('ecs:services', cluster), [cluster]);
  const containers = useMemo(() => {
    try {
      return (JSON.parse(json).containerDefinitions ?? []).map((c: any) => String(c.name)) as string[];
    } catch {
      return [];
    }
  }, [json]);
  const family = arnName(revision).split(':')[0];
  const [count, setCount] = useState(1);
  const [fromService, setFromService] = useState('');
  const [command, setCommand] = useState('');
  const [container, setContainer] = useState(containers[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (!fromService && services.data?.length) setFromService(services.data.find((s) => arnName(s.taskDefinition).startsWith(`${family}:`))?.name ?? services.data[0].name);
  }, [services.data, fromService, family]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const cmd = command.trim() ? command.trim().match(/"[^"]*"|'[^']*'|\S+/g)!.map((x) => x.replace(/^["']|["']$/g, '')) : undefined;
      const tasks = await call('ecs:runTask', { clusterArn: cluster, taskDefinition: revision, count, fromService: fromService || undefined, commandOverride: cmd ? { container, command: cmd } : undefined });
      toast('success', `Started ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
      onClose();
      setView({ type: 'tasks', select: tasks[0]?.arn });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Run ${arnName(revision)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !fromService}>
            Run task
          </button>
        </>
      }
    >
      <p className="muted">Starts a standalone task (not managed by a service). It uses the launch type, subnets and security groups of the service you pick.</p>
      <div className="deploy-grid">
        <label className="field">
          <span>Network settings from service</span>
          <select value={fromService} onChange={(e) => setFromService(e.target.value)}>
            {services.data?.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Count</span>
          <input type="number" min={1} max={10} value={count} onChange={(e) => setCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
        </label>
        <label className="field">
          <span>Container</span>
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Command override (optional)</span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npm run migrate" spellCheck={false} />
        </label>
      </div>
      <LoadState loading={services.loading} error={services.error} what="services" />
      {error && <div className="inline-error">{error}</div>}
    </Modal>
  );
}
