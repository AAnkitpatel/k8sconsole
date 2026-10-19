import { useEffect, useMemo, useState } from 'react';
import { stringify } from 'yaml';
import { bindingManifest, roleManifest, STANDARD_VERBS, subjectKey, type EffectiveRule, type PolicyRule, type Subject, type WhoCanEntry } from '../../shared/rbac';
import { call, errorMessage } from '../lib/api';
import { useDialogs, useToast } from '../components/Dialogs';

type Tab = 'who' | 'subject' | 'self' | 'editor';
type Res = { group: string; resource: string; namespaced: boolean };
const resLabel = (r: { group: string; resource: string }) => (r.group ? `${r.resource}.${r.group}` : r.resource);

function SubjectText({ s }: { s: Subject }) {
  return (
    <span>
      <span className="tag">{s.kind}</span> {s.kind === 'ServiceAccount' ? `${s.namespace}/` : ''}
      {s.name}
    </span>
  );
}

function WhoCan({ resources, namespace }: { resources: Res[]; namespace: string }) {
  const [verb, setVerb] = useState('delete');
  const [res, setRes] = useState('/pods');
  const [rows, setRows] = useState<WhoCanEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    const [group, resource] = res.split('/');
    call('access:whoCan', verb, group, resource, namespace || undefined)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, [namespace]);
  return (
    <div>
      <div className="toolbar">
        <span>Who can</span>
        <select value={verb} onChange={(e) => setVerb(e.target.value)} aria-label="Verb">
          {[...STANDARD_VERBS, 'escalate', 'bind', 'impersonate'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select value={res} onChange={(e) => setRes(e.target.value)} aria-label="Resource">
          {resources.map((r) => (
            <option key={`${r.group}/${r.resource}`} value={`${r.group}/${r.resource}`}>
              {resLabel(r)}
            </option>
          ))}
        </select>
        <span>{namespace ? `in ${namespace}` : 'cluster-wide'}</span>
        <button className="btn btn-sm btn-primary" onClick={run}>
          Check
        </button>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {rows && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Scope</th>
              <th>Granted by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <SubjectText s={r.subject} />
                </td>
                <td>{r.scope === '*' ? 'cluster-wide' : r.scope}</td>
                <td className="mono">
                  {r.via.bindingKind} {r.via.binding} → {r.via.roleKind} {r.via.role}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows?.length === 0 && <div className="empty">Nobody is granted this by RBAC bindings.</div>}
      <p className="muted">Computed from Roles, ClusterRoles and their bindings, including implicit service-account groups. Other authorizers (e.g. webhooks) are not reflected.</p>
    </div>
  );
}

function SubjectPermissions({ subjects, namespace }: { subjects: Subject[]; namespace: string }) {
  const [key, setKey] = useState('');
  const [custom, setCustom] = useState({ kind: 'User' as Subject['kind'], name: '', namespace: '' });
  const [data, setData] = useState<{ rules: EffectiveRule[]; matrix: Array<{ group: string; resource: string; verbs: Record<string, boolean> }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const subject: Subject | null = key === '__custom' ? (custom.name ? { kind: custom.kind, name: custom.name, namespace: custom.kind === 'ServiceAccount' ? custom.namespace : undefined } : null) : (subjects.find((s) => subjectKey(s) === key) ?? null);
  const load = () => {
    if (!subject) return;
    call('access:permissions', subject, namespace || undefined)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [key, namespace]);
  return (
    <div>
      <div className="toolbar">
        <select value={key} onChange={(e) => setKey(e.target.value)} aria-label="Subject">
          <option value="">Choose a subject…</option>
          {subjects.map((s) => (
            <option key={subjectKey(s)} value={subjectKey(s)}>
              {s.kind}: {s.kind === 'ServiceAccount' ? `${s.namespace}/` : ''}
              {s.name}
            </option>
          ))}
          <option value="__custom">Other subject…</option>
        </select>
        {key === '__custom' && (
          <>
            <select value={custom.kind} onChange={(e) => setCustom({ ...custom, kind: e.target.value as Subject['kind'] })}>
              <option>User</option>
              <option>Group</option>
              <option>ServiceAccount</option>
            </select>
            {custom.kind === 'ServiceAccount' && <input placeholder="namespace" value={custom.namespace} onChange={(e) => setCustom({ ...custom, namespace: e.target.value })} />}
            <input placeholder="name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
            <button className="btn btn-sm btn-primary" onClick={load} disabled={!custom.name}>
              Show
            </button>
          </>
        )}
        <span className="muted">{namespace ? `effective in ${namespace}` : 'cluster-scoped resources'}</span>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {data && (
        <>
          <div className="table-wrap perm-matrix">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Resource</th>
                  {STANDARD_VERBS.map((v) => (
                    <th key={v}>{v}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.matrix.map((m) => (
                  <tr key={`${m.group}/${m.resource}`}>
                    <td className="mono">{resLabel(m)}</td>
                    {STANDARD_VERBS.map((v) => (
                      <td key={v} className={m.verbs[v] ? 'perm-yes' : 'perm-no'} aria-label={m.verbs[v] ? 'allowed' : 'denied'}>
                        {m.verbs[v] ? '✓' : '·'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {data.matrix.length === 0 && <div className="empty">No permissions here.</div>}
          </div>
          <h3 className="sub-h">Granting bindings</h3>
          <ul className="plain-list mono">
            {[...new Set(data.rules.map((r) => `${r.via.bindingKind} ${r.via.bindingNamespace ? r.via.bindingNamespace + '/' : ''}${r.via.binding} → ${r.via.roleKind} ${r.via.role}`))].map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function MyAccess({ resources, namespace }: { resources: Res[]; namespace: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof call<'access:self'>>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verb, setVerb] = useState('create');
  const [res, setRes] = useState('apps/deployments');
  const [check, setCheck] = useState<{ allowed: boolean; reason?: string } | null>(null);
  useEffect(() => {
    call('access:self', namespace || undefined)
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, [namespace]);
  return (
    <div>
      {error && <div className="inline-error">{error}</div>}
      {data && (
        <p>
          Signed in as <b>{data.user ?? 'unknown user'}</b>
          {data.groups?.length ? <span className="muted"> · groups {data.groups.join(', ')}</span> : null}
          {data.incomplete && <span className="badge badge-warn"> list may be incomplete</span>}
        </p>
      )}
      <div className="toolbar">
        <span>Can I</span>
        <select value={verb} onChange={(e) => setVerb(e.target.value)}>
          {STANDARD_VERBS.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select value={res} onChange={(e) => setRes(e.target.value)} aria-label="Resource to check">
          {resources.map((r) => (
            <option key={`${r.group}/${r.resource}`} value={`${r.group}/${r.resource}`}>
              {resLabel(r)}
            </option>
          ))}
        </select>
        <span>{namespace ? `in ${namespace}` : 'cluster-wide'}?</span>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => {
            const [g, r] = res.split('/');
            call('access:check', verb, g, r, namespace || undefined)
              .then(setCheck)
              .catch((e) => setError(errorMessage(e)));
          }}
        >
          Check
        </button>
        {check && <span className={`badge badge-${check.allowed ? 'ok' : 'error'}`}>{check.allowed ? '✓ yes' : '✕ no'}</span>}
      </div>
      {data && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Verbs</th>
              <th>Resources</th>
              <th>API groups</th>
              <th>Names</th>
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r, i) => (
              <tr key={i}>
                <td>{r.verbs.join(', ')}</td>
                <td className="cell-wrap">{(r.resources ?? []).join(', ')}</td>
                <td>{(r.apiGroups ?? []).map((g) => g || 'core').join(', ')}</td>
                <td>{(r.resourceNames ?? []).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface RuleDraft {
  group: string;
  resources: string[];
  verbs: string[];
}

function RoleEditor({ resources, namespace }: { resources: Res[]; namespace: string }) {
  const [kind, setKind] = useState<'Role' | 'ClusterRole'>(namespace ? 'Role' : 'ClusterRole');
  const [name, setName] = useState('');
  const [rules, setRules] = useState<RuleDraft[]>([{ group: '', resources: ['pods'], verbs: ['get', 'list', 'watch'] }]);
  const [bind, setBind] = useState(true);
  const [subjects, setSubjects] = useState<Subject[]>([{ kind: 'ServiceAccount', name: 'default', namespace: namespace || 'default' }]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { confirm } = useDialogs();
  const toast = useToast();
  const groups = useMemo(() => [...new Set(resources.map((r) => r.group))].sort(), [resources]);

  const policyRules: PolicyRule[] = rules.filter((r) => r.resources.length && r.verbs.length).map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs }));
  const docs = name
    ? [
        roleManifest({ kind, name, namespace: namespace || 'default', rules: policyRules }),
        ...(bind && subjects.some((s) => s.name)
          ? [bindingManifest({ kind: kind === 'Role' ? 'RoleBinding' : 'ClusterRoleBinding', name: `${name}-binding`, namespace: namespace || 'default', roleKind: kind, roleName: name, subjects: subjects.filter((s) => s.name) })]
          : []),
      ]
    : [];
  const yaml = docs.map((d) => stringify(d)).join('---\n');
  const valid = /^[a-z0-9]([-a-z0-9.:]*[a-z0-9])?$/.test(name) && policyRules.length > 0;

  const apply = async (dryRun: boolean) => {
    if (!dryRun && !(await confirm({ title: 'Apply access change', message: `Create or update ${kind} ${name}${bind ? ' and its binding' : ''}? This changes who can do what in the cluster.`, confirmLabel: 'Apply' }))) return;
    try {
      const r = await call('resource:apply', yaml, { dryRun, mode: 'apply' });
      const failed = r.filter((x) => !x.ok);
      setResult(failed.length ? { ok: false, text: failed.map((f) => f.error).join('\n') } : { ok: true, text: dryRun ? 'Dry run passed.' : 'Applied.' });
      if (!failed.length && !dryRun) toast('success', `${kind} ${name} applied`);
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    }
  };

  const updateRule = (i: number, patch: Partial<RuleDraft>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="role-editor">
      <div className="toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'Role' | 'ClusterRole')} aria-label="Role kind">
          <option value="Role">Role {namespace ? `(in ${namespace})` : '(default)'}</option>
          <option value="ClusterRole">ClusterRole</option>
        </select>
        <input placeholder="role name" value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Role name" aria-invalid={!!name && !valid} />
      </div>
      <h3 className="sub-h">Rules</h3>
      {rules.map((r, i) => (
        <div key={i} className="rule-row">
          <select value={r.group} onChange={(e) => updateRule(i, { group: e.target.value, resources: [] })} aria-label="API group">
            {groups.map((g) => (
              <option key={g} value={g}>
                {g || 'core'}
              </option>
            ))}
          </select>
          <select multiple size={4} value={r.resources} onChange={(e) => updateRule(i, { resources: [...e.target.selectedOptions].map((o) => o.value) })} aria-label="Resources">
            {resources
              .filter((x) => x.group === r.group)
              .map((x) => (
                <option key={x.resource}>{x.resource}</option>
              ))}
          </select>
          <div className="verbs">
            {STANDARD_VERBS.map((v) => (
              <label key={v} className="check">
                <input type="checkbox" checked={r.verbs.includes(v)} onChange={(e) => updateRule(i, { verbs: e.target.checked ? [...r.verbs, v] : r.verbs.filter((x) => x !== v) })} /> {v}
              </label>
            ))}
          </div>
          <button className="icon-btn" aria-label="Remove rule" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setRules((rs) => [...rs, { group: '', resources: [], verbs: ['get', 'list'] }])}>
        + Add rule
      </button>
      <h3 className="sub-h">
        <label className="check">
          <input type="checkbox" checked={bind} onChange={(e) => setBind(e.target.checked)} /> Bind to subjects
        </label>
      </h3>
      {bind &&
        subjects.map((s, i) => (
          <div key={i} className="toolbar">
            <select value={s.kind} onChange={(e) => setSubjects((x) => x.map((y, j) => (j === i ? { ...y, kind: e.target.value as Subject['kind'] } : y)))}>
              <option>ServiceAccount</option>
              <option>User</option>
              <option>Group</option>
            </select>
            {s.kind === 'ServiceAccount' && <input placeholder="namespace" value={s.namespace ?? ''} onChange={(e) => setSubjects((x) => x.map((y, j) => (j === i ? { ...y, namespace: e.target.value } : y)))} />}
            <input placeholder="name" value={s.name} onChange={(e) => setSubjects((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
            <button className="icon-btn" aria-label="Remove subject" onClick={() => setSubjects((x) => x.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
      {bind && (
        <button className="btn btn-sm" onClick={() => setSubjects((x) => [...x, { kind: 'User', name: '' }])}>
          + Add subject
        </button>
      )}
      <h3 className="sub-h">Preview</h3>
      <pre className="kv-value role-preview">{yaml || 'Enter a role name to preview the manifests.'}</pre>
      <div className="toolbar">
        <button className="btn btn-sm" disabled={!valid} onClick={() => void apply(true)}>
          Dry run
        </button>
        <button className="btn btn-sm btn-primary" disabled={!valid} onClick={() => void apply(false)}>
          Apply
        </button>
        <span className="muted">Uses server-side apply: an existing role with the same name is updated.</span>
      </div>
      {result && <div className={result.ok ? 'inline-ok' : 'inline-error pre'}>{result.text}</div>}
    </div>
  );
}

export function AccessView({ namespace }: { namespace: string }) {
  const [tab, setTab] = useState<Tab>('who');
  const [overview, setOverview] = useState<{ subjects: Subject[]; resources: Res[]; notes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call('access:overview')
      .then(setOverview)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const resources = useMemo(() => (overview?.resources ?? []).filter((r) => (namespace ? r.namespaced : true)), [overview, namespace]);
  return (
    <div className="access-view">
      <div className="view-header">
        <h1>Access</h1>
        <span className="muted">{namespace ? `namespace ${namespace}` : 'cluster-wide'}</span>
      </div>
      <nav className="tabs mon-pad" role="tablist">
        {(
          [
            ['who', 'Who can…'],
            ['subject', 'Subject permissions'],
            ['self', 'My access'],
            ['editor', 'Role editor'],
          ] as Array<[Tab, string]>
        ).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {l}
          </button>
        ))}
      </nav>
      <div className="mon-pad access-body">
        {error && <div className="inline-error">{error}</div>}
        {overview?.notes.length ? <div className="inline-warn">Partial data: {overview.notes.join(' · ')}</div> : null}
        {!overview && !error && <div className="empty">Loading access data…</div>}
        {overview && tab === 'who' && <WhoCan resources={resources} namespace={namespace} />}
        {overview && tab === 'subject' && <SubjectPermissions subjects={overview.subjects} namespace={namespace} />}
        {overview && tab === 'self' && <MyAccess resources={resources} namespace={namespace} />}
        {overview && tab === 'editor' && <RoleEditor resources={overview.resources} namespace={namespace} />}
      </div>
    </div>
  );
}
