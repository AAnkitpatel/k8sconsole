import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiResourceInfo, AppSettings, KubeObject, ResourceRef } from '../../shared/types';
import { formatAge, summarizeNode, summarizePod } from '../../shared/format';
import { validateManifest } from '../../shared/validation';
import { validatePort, validateReplicas } from '../../shared/validation';
import { call, errorMessage } from '../lib/api';
import { useWatch } from '../lib/useWatch';
import { columnsFor } from '../lib/columns';
import { useDialogs, useToast, Modal } from './Dialogs';
import { YamlEditor } from './YamlEditor';
import { LogViewer } from './LogViewer';
import { PodTerminal } from './Terminal';
import { ResourceTable, objectKey } from './ResourceTable';
import { GraphView } from './GraphView';
import { nodeId, type ResourceGraph } from '../../shared/graph';

export interface NavigateTarget {
  kind: string;
  apiVersion?: string;
  namespace?: string;
  name: string;
}

type Tab = 'overview' | 'yaml' | 'events' | 'relations' | 'logs' | 'shell';

interface Props {
  object: KubeObject;
  refInfo: ResourceRef;
  discovery: ApiResourceInfo[];
  settings: AppSettings;
  dark: boolean;
  onClose: () => void;
  onNavigate: (t: NavigateTarget) => void;
}

function KeyValues({ data, empty = 'None' }: { data?: Record<string, string>; empty?: string }) {
  const entries = Object.entries(data ?? {});
  if (!entries.length) return <span className="muted">{empty}</span>;
  return (
    <div className="chips">
      {entries.map(([k, v]) => (
        <span className="chip" key={k} title={`${k}=${v}`}>
          {k}
          {v ? `=${v}` : ''}
        </span>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Conditions({ conditions }: { conditions?: any[] }) {
  if (!conditions?.length) return null;
  return (
    <Section title="Conditions">
      <table className="mini-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Message</th>
            <th>Last transition</th>
          </tr>
        </thead>
        <tbody>
          {conditions.map((c) => (
            <tr key={c.type}>
              <td>{c.type}</td>
              <td>
                <span className={`badge badge-${c.status === 'True' ? 'ok' : 'warn'}`}>{c.status}</span>
              </td>
              <td>{c.reason}</td>
              <td className="cell-wrap">{c.message}</td>
              <td>{formatAge(c.lastTransitionTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function containerState(cs: any): string {
  if (!cs?.state) return 'Unknown';
  if (cs.state.running) return 'Running';
  if (cs.state.waiting) return `Waiting: ${cs.state.waiting.reason ?? ''}`;
  if (cs.state.terminated) return `Terminated: ${cs.state.terminated.reason ?? cs.state.terminated.exitCode}`;
  return 'Unknown';
}

function Containers({ pod }: { pod: KubeObject }) {
  const statuses: any[] = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const specs: any[] = [...(pod.spec?.initContainers ?? []).map((c: any) => ({ ...c, init: true })), ...(pod.spec?.containers ?? [])];
  return (
    <Section title="Containers">
      <table className="mini-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Image</th>
            <th>State</th>
            <th>Ready</th>
            <th>Restarts</th>
            <th>Ports</th>
          </tr>
        </thead>
        <tbody>
          {specs.map((c) => {
            const s = statuses.find((x) => x.name === c.name);
            return (
              <tr key={c.name}>
                <td>
                  {c.name}
                  {c.init && <span className="tag">init</span>}
                </td>
                <td className="cell-wrap mono">{c.image}</td>
                <td>{containerState(s)}</td>
                <td>{s?.ready ? 'Yes' : 'No'}</td>
                <td>{s?.restartCount ?? 0}</td>
                <td>{(c.ports ?? []).map((p: any) => `${p.containerPort}/${p.protocol ?? 'TCP'}${p.name ? ` (${p.name})` : ''}`).join(', ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function RelatedPods({ object, onNavigate }: { object: KubeObject; onNavigate: (t: NavigateTarget) => void }) {
  const selector: Record<string, string> | undefined = object.spec?.selector?.matchLabels ?? (object.kind === 'Service' ? object.spec?.selector : undefined);
  const labelSelector = selector && Object.keys(selector).length ? Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',') : null;
  const req = useMemo(
    () => (labelSelector ? { resource: { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true }, namespace: object.metadata.namespace, labelSelector } : null),
    [labelSelector, object.metadata.namespace],
  );
  const w = useWatch(req);
  const cols = useMemo(() => columnsFor('Pod', true).filter((c) => ['name', 'ready', 'status', 'restarts', 'node', 'age'].includes(c.key)), []);
  if (!labelSelector) return null;
  return (
    <Section title={`Pods (${w.items.length})`}>
      <ResourceTable
        items={w.items}
        columns={cols}
        ctx={{ now: Date.now(), metrics: null }}
        filter=""
        selectedKey={null}
        onSelect={(p) => onNavigate({ kind: 'Pod', namespace: p.metadata.namespace, name: p.metadata.name })}
        emptyText={w.loading ? 'Loading…' : 'No pods match the selector.'}
      />
    </Section>
  );
}

function SecretData({ data }: { data?: Record<string, string> }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const entries = Object.entries(data ?? {});
  if (!entries.length) return <span className="muted">No data</span>;
  const decode = (b64: string) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return '(binary)';
    }
  };
  return (
    <table className="mini-table">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td className="mono">{k}</td>
            <td className="cell-wrap mono">{revealed[k] ? decode(v) : '••••••••'}</td>
            <td style={{ width: 70 }}>
              <button className="btn btn-sm" onClick={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}>
                {revealed[k] ? 'Hide' : 'Reveal'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Overview({ object, onNavigate }: { object: KubeObject; onNavigate: (t: NavigateTarget) => void }) {
  const m = object.metadata;
  const kind = object.kind;
  return (
    <div className="overview">
      <Section title="Metadata">
        <dl className="props">
          <dt>Name</dt>
          <dd>{m.name}</dd>
          {m.namespace && (
            <>
              <dt>Namespace</dt>
              <dd>{m.namespace}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>
            {m.creationTimestamp} ({formatAge(m.creationTimestamp)} ago)
          </dd>
          <dt>UID</dt>
          <dd className="mono">{m.uid}</dd>
          <dt>Labels</dt>
          <dd>
            <KeyValues data={m.labels} />
          </dd>
          <dt>Annotations</dt>
          <dd>
            <KeyValues data={Object.fromEntries(Object.entries(m.annotations ?? {}).filter(([k]) => k !== 'kubectl.kubernetes.io/last-applied-configuration'))} />
          </dd>
          {m.ownerReferences?.length ? (
            <>
              <dt>Controlled by</dt>
              <dd>
                {m.ownerReferences.map((o) => (
                  <button key={o.uid} className="link" onClick={() => onNavigate({ kind: o.kind, apiVersion: o.apiVersion, namespace: m.namespace, name: o.name })}>
                    {o.kind}/{o.name}
                  </button>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      </Section>

      {kind === 'Pod' && (
        <>
          <Section title="Status">
            <dl className="props">
              <dt>Status</dt>
              <dd>{summarizePod(object).status}</dd>
              <dt>Node</dt>
              <dd>
                {object.spec?.nodeName ? (
                  <button className="link" onClick={() => onNavigate({ kind: 'Node', name: object.spec.nodeName })}>
                    {object.spec.nodeName}
                  </button>
                ) : (
                  '-'
                )}
              </dd>
              <dt>Pod IP</dt>
              <dd>{object.status?.podIP ?? '-'}</dd>
              <dt>QoS class</dt>
              <dd>{object.status?.qosClass ?? '-'}</dd>
              <dt>Service account</dt>
              <dd>{object.spec?.serviceAccountName ?? '-'}</dd>
            </dl>
          </Section>
          <Containers pod={object} />
          <Conditions conditions={object.status?.conditions} />
        </>
      )}

      {['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(kind!) && (
        <>
          <Section title="Rollout">
            <dl className="props">
              {kind !== 'DaemonSet' && (
                <>
                  <dt>Replicas</dt>
                  <dd>
                    {object.status?.readyReplicas ?? 0} ready / {object.spec?.replicas ?? 0} desired · {object.status?.updatedReplicas ?? 0} updated · {object.status?.availableReplicas ?? 0} available
                  </dd>
                </>
              )}
              {kind === 'DaemonSet' && (
                <>
                  <dt>Scheduled</dt>
                  <dd>
                    {object.status?.numberReady ?? 0} ready / {object.status?.desiredNumberScheduled ?? 0} desired
                  </dd>
                </>
              )}
              <dt>Strategy</dt>
              <dd>{object.spec?.strategy?.type ?? object.spec?.updateStrategy?.type ?? '-'}</dd>
              <dt>Selector</dt>
              <dd>
                <KeyValues data={object.spec?.selector?.matchLabels} />
              </dd>
              <dt>Images</dt>
              <dd className="mono">{(object.spec?.template?.spec?.containers ?? []).map((c: any) => c.image).join(', ')}</dd>
            </dl>
          </Section>
          <Conditions conditions={object.status?.conditions} />
          <RelatedPods object={object} onNavigate={onNavigate} />
        </>
      )}

      {kind === 'Service' && (
        <>
          <Section title="Service">
            <dl className="props">
              <dt>Type</dt>
              <dd>{object.spec?.type}</dd>
              <dt>Cluster IP</dt>
              <dd>{(object.spec?.clusterIPs ?? [object.spec?.clusterIP]).join(', ')}</dd>
              <dt>Ports</dt>
              <dd>{(object.spec?.ports ?? []).map((p: any) => `${p.name ? p.name + ' ' : ''}${p.port}→${p.targetPort}/${p.protocol ?? 'TCP'}`).join(', ')}</dd>
              <dt>Selector</dt>
              <dd>
                <KeyValues data={object.spec?.selector} />
              </dd>
            </dl>
          </Section>
          <RelatedPods object={object} onNavigate={onNavigate} />
        </>
      )}

      {kind === 'Node' && (
        <>
          <Section title="Node">
            <dl className="props">
              <dt>Status</dt>
              <dd>{summarizeNode(object).status}</dd>
              <dt>Roles</dt>
              <dd>{summarizeNode(object).roles}</dd>
              <dt>Kubelet</dt>
              <dd>{object.status?.nodeInfo?.kubeletVersion}</dd>
              <dt>OS / Arch</dt>
              <dd>
                {object.status?.nodeInfo?.osImage} ({object.status?.nodeInfo?.architecture})
              </dd>
              <dt>Kernel</dt>
              <dd>{object.status?.nodeInfo?.kernelVersion}</dd>
              <dt>Runtime</dt>
              <dd>{object.status?.nodeInfo?.containerRuntimeVersion}</dd>
              <dt>Capacity</dt>
              <dd>
                CPU {object.status?.capacity?.cpu} · Memory {object.status?.capacity?.memory} · Pods {object.status?.capacity?.pods}
              </dd>
              <dt>Allocatable</dt>
              <dd>
                CPU {object.status?.allocatable?.cpu} · Memory {object.status?.allocatable?.memory}
              </dd>
              <dt>Taints</dt>
              <dd>{(object.spec?.taints ?? []).map((t: any) => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`).join(', ') || <span className="muted">None</span>}</dd>
            </dl>
          </Section>
          <Conditions conditions={object.status?.conditions} />
        </>
      )}

      {kind === 'ConfigMap' && (
        <Section title="Data">
          {Object.entries(object.data ?? {}).map(([k, v]) => (
            <div key={k} className="kv-block">
              <div className="kv-key mono">{k}</div>
              <pre className="kv-value">{String(v)}</pre>
            </div>
          ))}
          {!Object.keys(object.data ?? {}).length && <span className="muted">No data</span>}
        </Section>
      )}

      {kind === 'Secret' && (
        <Section title={`Data (${object.type})`}>
          <SecretData data={object.data} />
        </Section>
      )}

      {kind === 'Event' && (
        <Section title="Event">
          <dl className="props">
            <dt>Type</dt>
            <dd>{object.type}</dd>
            <dt>Reason</dt>
            <dd>{object.reason}</dd>
            <dt>Message</dt>
            <dd className="cell-wrap">{object.message}</dd>
            <dt>Object</dt>
            <dd>
              <button className="link" onClick={() => onNavigate({ kind: object.involvedObject?.kind, apiVersion: object.involvedObject?.apiVersion, namespace: object.involvedObject?.namespace, name: object.involvedObject?.name })}>
                {object.involvedObject?.kind}/{object.involvedObject?.name}
              </button>
            </dd>
            <dt>Source</dt>
            <dd>{object.source?.component ?? object.reportingComponent}</dd>
            <dt>Count</dt>
            <dd>{object.count ?? 1}</dd>
          </dl>
        </Section>
      )}

      {!['Pod', 'Node', 'Service', 'ConfigMap', 'Secret', 'Event', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(kind!) && object.status?.conditions && <Conditions conditions={object.status.conditions} />}
    </div>
  );
}

function RelationsTab({ object, onNavigate }: { object: KubeObject; onNavigate: (t: NavigateTarget) => void }) {
  const [graph, setGraph] = useState<(ResourceGraph & { notes: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(2);
  useEffect(() => {
    setGraph(null);
    call('graph:object', object.kind!, object.metadata.namespace, object.metadata.name, depth)
      .then(setGraph)
      .catch((err) => setError(errorMessage(err)));
  }, [object.kind, object.metadata.namespace, object.metadata.name, depth]);
  if (error) return <div className="inline-error">{error}</div>;
  if (!graph) return <div className="empty">Mapping relationships…</div>;
  return (
    <div className="relations-tab">
      <div className="toolbar">
        <span className="muted">How this object connects to the rest of the namespace.</span>
        <div className="spacer" />
        <label className="check">
          Depth
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Depth">
            {[1, 2, 3].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
      </div>
      {graph.notes.length > 0 && <div className="inline-warn">{graph.notes.join(' · ')}</div>}
      <GraphView
        graph={graph}
        highlight={nodeId(object.kind!, object.metadata.namespace, object.metadata.name)}
        onOpen={(n) => onNavigate({ kind: n.kind, apiVersion: n.apiVersion, namespace: n.namespace, name: n.name })}
        emptyText="This kind is not part of the relationship map."
      />
    </div>
  );
}

function EventsTab({ object }: { object: KubeObject }) {
  const [events, setEvents] = useState<KubeObject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      call('resource:events', object.metadata.namespace, object.metadata.uid!)
        .then((e) => alive && (setEvents(e), setError(null)))
        .catch((err) => alive && setError(errorMessage(err)));
    void load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [object.metadata.uid, object.metadata.namespace]);
  if (error) return <div className="inline-error">{error}</div>;
  if (!events) return <div className="empty">Loading events…</div>;
  const sorted = [...events].sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? '') - Date.parse(a.lastTimestamp ?? a.eventTime ?? ''));
  if (!sorted.length) return <div className="empty">No events for this object. Events expire after about an hour.</div>;
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Reason</th>
          <th>Age</th>
          <th>Count</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((e) => (
          <tr key={e.metadata.uid}>
            <td>
              <span className={`badge badge-${e.type === 'Warning' ? 'warn' : 'ok'}`}>{e.type}</span>
            </td>
            <td>{e.reason}</td>
            <td>{formatAge(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}</td>
            <td>{e.count ?? 1}</td>
            <td className="cell-wrap">{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function YamlTab({ object, refInfo, dark, canUpdate }: { object: KubeObject; refInfo: ResourceRef; dark: boolean; canUpdate: boolean }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const { confirm } = useDialogs();
  const toast = useToast();
  const target = { ref: refInfo, namespace: object.metadata.namespace, name: object.metadata.name };

  const load = useCallback(async () => {
    try {
      const y = await call('resource:yaml', refInfo, object.metadata.namespace, object.metadata.name);
      setOriginal(y);
      setText(y);
      setMessage(null);
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refInfo.apiVersion, refInfo.plural, object.metadata.namespace, object.metadata.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = original !== null && text !== original;
  const local = validateManifest(text, { kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace });

  const run = async (dryRun: boolean) => {
    if (!local.ok) return;
    if (!dryRun && !(await confirm({ title: 'Apply changes', message: `Replace ${object.kind} ${object.metadata.name} on the cluster with the edited YAML?`, confirmLabel: 'Apply' }))) return;
    setBusy(true);
    try {
      const [r] = await call('resource:apply', text, { dryRun, mode: 'replace', original: target });
      if (r.ok) {
        setMessage({ kind: 'ok', text: dryRun ? 'Server-side dry run succeeded. The change is valid.' : 'Applied.' });
        if (!dryRun) {
          toast('success', `${object.kind} ${object.metadata.name} updated`);
          await load();
          setMessage({ kind: 'ok', text: 'Applied.' });
        }
      } else setMessage({ kind: 'error', text: r.error ?? 'Apply failed' });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (original === null && !message) return <div className="empty">Loading YAML…</div>;
  return (
    <div className="yaml-tab">
      <div className="toolbar">
        <span className={dirty ? 'dirty' : 'muted'}>{dirty ? 'Modified' : 'Unmodified'}</span>
        {!local.ok && <span className="field-error">{local.issues.find((i) => i.severity === 'error')?.message}</span>}
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => void load()} disabled={busy}>
          Reload
        </button>
        <button className="btn btn-sm" onClick={() => setText(original ?? '')} disabled={!dirty || busy}>
          Revert
        </button>
        <button className="btn btn-sm" onClick={() => void run(true)} disabled={!local.ok || busy || !canUpdate} title="Validate on the server without saving (dry run)">
          Validate
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => void run(false)} disabled={!dirty || !local.ok || busy || !canUpdate} title={canUpdate ? '' : 'This resource does not support updates'}>
          Apply
        </button>
      </div>
      {message && <div className={message.kind === 'error' ? 'inline-error' : 'inline-ok'}>{message.text}</div>}
      <YamlEditor value={text} onChange={setText} dark={dark} readOnly={!canUpdate} />
    </div>
  );
}

function PortForwardDialog({ object, onClose }: { object: KubeObject; onClose: () => void }) {
  const ports: number[] =
    object.kind === 'Service'
      ? (object.spec?.ports ?? []).filter((p: any) => (p.protocol ?? 'TCP') === 'TCP').map((p: any) => p.port)
      : (object.spec?.containers ?? []).flatMap((c: any) => (c.ports ?? []).filter((p: any) => (p.protocol ?? 'TCP') === 'TCP').map((p: any) => p.containerPort));
  const [remote, setRemote] = useState(String(ports[0] ?? ''));
  const [local, setLocal] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const remoteErr = validatePort(remote);
  const localErr = validatePort(local, { allowZero: true });
  const start = async () => {
    setBusy(true);
    try {
      const f = await call('portforward:start', {
        namespace: object.metadata.namespace!,
        targetKind: object.kind === 'Service' ? 'Service' : 'Pod',
        targetName: object.metadata.name,
        remotePort: Number(remote),
        localPort: Number(local),
      });
      toast('success', `Forwarding 127.0.0.1:${f.localPort} → ${(object.kind ?? "").toLowerCase()}/${object.metadata.name}:${f.remotePort}`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Port forward ${object.kind}/${object.metadata.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!remoteErr || !!localErr || busy} onClick={() => void start()}>
            Start
          </button>
        </>
      }
    >
      <label className="field">
        <span>Remote port</span>
        {ports.length ? (
          <select value={remote} onChange={(e) => setRemote(e.target.value)}>
            {ports.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        ) : (
          <input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="e.g. 8080" />
        )}
      </label>
      {remoteErr && remote && <div className="field-error">{remoteErr}</div>}
      <label className="field">
        <span>Local port (0 = pick a free port)</span>
        <input value={local} onChange={(e) => setLocal(e.target.value)} />
      </label>
      {localErr && <div className="field-error">{localErr}</div>}
      <p className="muted">The forward listens on 127.0.0.1 only.</p>
      {error && <div className="inline-error">{error}</div>}
    </Modal>
  );
}

export function DetailsPanel({ object, refInfo, discovery, settings, dark, onClose, onNavigate }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [pf, setPf] = useState(false);
  const { confirm, prompt } = useDialogs();
  const toast = useToast();
  const info = discovery.find((d) => d.apiVersion === refInfo.apiVersion && d.plural === refInfo.plural);
  const verbs = new Set(info?.verbs ?? ['get', 'list', 'update', 'delete']);
  const kind = object.kind!;
  const ns = object.metadata.namespace;
  const name = object.metadata.name;

  useEffect(() => {
    setTab((t) => ((t === 'logs' || t === 'shell') && kind !== 'Pod' ? 'overview' : t));
  }, [kind, name]);

  const guard = async (title: string, message: string, danger = false, typeName = false) =>
    !settings.confirmDestructiveActions && !danger ? true : confirm({ title, message, danger, confirmLabel: title, typeToConfirm: danger && typeName && settings.confirmDestructiveActions ? name : undefined });

  const act = async (label: string, fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast('success', success);
    } catch (err) {
      toast('error', `${label} failed: ${errorMessage(err)}`);
    }
  };

  const actions: ReactNode[] = [];
  if (['Deployment', 'StatefulSet', 'ReplicaSet'].includes(kind)) {
    actions.push(
      <button key="scale" className="btn btn-sm" onClick={async () => {
        const v = await prompt({ title: `Scale ${kind} ${name}`, label: 'Replicas', initial: String(object.spec?.replicas ?? 1), validate: validateReplicas, confirmLabel: 'Scale' });
        if (v !== null) await act('Scale', () => call('action:scale', refInfo, ns!, name, Number(v)), `Scaled ${name} to ${v} replicas`);
      }}>
        Scale
      </button>,
    );
  }
  if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) {
    actions.push(
      <button key="restart" className="btn btn-sm" onClick={async () => {
        if (await guard('Restart', `Perform a rolling restart of ${kind} ${name}?`)) await act('Restart', () => call('action:restart', refInfo, ns!, name), `Rolling restart of ${name} started`);
      }}>
        Restart
      </button>,
    );
  }
  if (kind === 'CronJob') {
    actions.push(
      <button key="trigger" className="btn btn-sm" onClick={async () => {
        if (await guard('Trigger', `Create a Job from CronJob ${name} now?`)) {
          try {
            const r = await call('action:triggerCronJob', ns!, name);
            toast('success', `Created Job ${r.jobName}`);
          } catch (err) {
            toast('error', `Trigger failed: ${errorMessage(err)}`);
          }
        }
      }}>
        Trigger
      </button>,
      <button key="suspend" className="btn btn-sm" onClick={() => act('Suspend', () => call('action:suspendCronJob', ns!, name, !object.spec?.suspend), object.spec?.suspend ? `Resumed ${name}` : `Suspended ${name}`)}>
        {object.spec?.suspend ? 'Resume' : 'Suspend'}
      </button>,
    );
  }
  if (kind === 'Node') {
    const unsched = !!object.spec?.unschedulable;
    actions.push(
      <button key="cordon" className="btn btn-sm" onClick={async () => {
        if (await guard(unsched ? 'Uncordon' : 'Cordon', `${unsched ? 'Allow' : 'Prevent'} scheduling of new pods on node ${name}?`)) await act('Cordon', () => call('action:cordon', name, !unsched), unsched ? `Uncordoned ${name}` : `Cordoned ${name}`);
      }}>
        {unsched ? 'Uncordon' : 'Cordon'}
      </button>,
      <button key="drain" className="btn btn-sm btn-warn" onClick={async () => {
        if (!(await confirm({ title: 'Drain node', message: `Cordon ${name} and evict all its pods (DaemonSet and mirror pods are skipped)? PodDisruptionBudgets are respected.`, danger: true, confirmLabel: 'Drain', typeToConfirm: settings.confirmDestructiveActions ? name : undefined }))) return;
        try {
          const r = await call('action:drain', name);
          toast(r.failed.length ? 'error' : 'success', `Drain: ${r.evicted.length} evicted, ${r.skipped.length} skipped, ${r.failed.length} failed${r.failed.length ? ': ' + r.failed.join('; ') : ''}`);
        } catch (err) {
          toast('error', `Drain failed: ${errorMessage(err)}`);
        }
      }}>
        Drain
      </button>,
    );
  }
  if (kind === 'Pod' || kind === 'Service') {
    actions.push(
      <button key="pf" className="btn btn-sm" onClick={() => setPf(true)}>
        Port Forward
      </button>,
    );
  }
  if (kind === 'Pod') {
    actions.push(
      <button key="evict" className="btn btn-sm" onClick={async () => {
        if (await guard('Evict', `Evict pod ${name}? The eviction respects PodDisruptionBudgets.`)) await act('Evict', () => call('action:evict', ns!, name), `Evicted ${name}`);
      }}>
        Evict
      </button>,
    );
  }
  if (verbs.has('delete')) {
    actions.push(
      <button key="delete" className="btn btn-sm btn-danger" onClick={async () => {
        const owned = kind === 'Pod' && object.metadata.ownerReferences?.some((o) => o.controller);
        if (await guard('Delete', `Delete ${kind} ${ns ? ns + '/' : ''}${name}?${owned ? ' Its controller will create a replacement pod.' : ' This cannot be undone.'}`, true, !owned)) {
          await act('Delete', () => call('resource:delete', refInfo, ns, name), `Deleted ${kind} ${name}`);
        }
      }}>
        Delete
      </button>,
    );
  }

  const tabs: Array<[Tab, string]> = [
    ['overview', 'Overview'],
    ['yaml', 'YAML'],
    ['events', 'Events'],
    ['relations', 'Relations'],
  ];
  if (kind === 'Pod') tabs.push(['logs', 'Logs'], ['shell', 'Shell']);

  return (
    <aside className="details" aria-label="Resource details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-tag">{kind}</span>
          <h2 title={name}>{name}</h2>
          {ns && <span className="muted">in {ns}</span>}
        </div>
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="details-actions">{actions}</div>
      <nav className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="details-body">
        {tab === 'overview' && <Overview object={object} onNavigate={onNavigate} />}
        {tab === 'yaml' && <YamlTab key={objectKey(object)} object={object} refInfo={refInfo} dark={dark} canUpdate={verbs.has('update')} />}
        {tab === 'events' && <EventsTab object={object} />}
        {tab === 'relations' && <RelationsTab key={objectKey(object)} object={object} onNavigate={onNavigate} />}
        {tab === 'logs' && kind === 'Pod' && <LogViewer key={objectKey(object)} pod={object} defaultTail={settings.logTailLines} defaultTimestamps={settings.logTimestamps} />}
        {tab === 'shell' && kind === 'Pod' && <PodTerminal key={objectKey(object)} pod={object} dark={dark} />}
      </div>
      {pf && <PortForwardDialog object={object} onClose={() => setPf(false)} />}
    </aside>
  );
}
