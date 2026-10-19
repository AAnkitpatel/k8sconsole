import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HelmChartVersion, HelmHistoryEntry, HelmInstallResult, HelmRelease, HelmRepo } from '../../shared/types';
import { call, errorMessage } from '../lib/api';
import { Modal, useDialogs, useToast } from '../components/Dialogs';
import { YamlEditor } from '../components/YamlEditor';

type Tab = 'values' | 'all-values' | 'manifest' | 'history';

/** Install or upgrade dialog: values editor, server-side dry run, then the real operation. */
function DeployDialog({
  mode,
  initial,
  dark,
  onClose,
  onDone,
}: {
  mode: 'install' | 'upgrade';
  initial: { chart: string; version?: string; release?: string; namespace: string; values?: string };
  dark: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [chart, setChart] = useState(initial.chart);
  const [version, setVersion] = useState(initial.version ?? '');
  const [versions, setVersions] = useState<HelmChartVersion[]>([]);
  const [release, setRelease] = useState(initial.release ?? '');
  const [ns, setNs] = useState(initial.namespace);
  const [createNs, setCreateNs] = useState(true);
  const [reuse, setReuse] = useState(false);
  const [values, setValues] = useState(initial.values ?? '');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<HelmInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(chart)) return;
    call('helm:search', chart, true)
      .then((v) => setVersions(v.filter((x) => x.name === chart)))
      .catch(() => setVersions([]));
  }, [chart]);

  useEffect(() => {
    if (mode !== 'install' || initial.values !== undefined || !chart) return;
    call('helm:showValues', chart, version || undefined)
      .then(setValues)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, version]);

  const valid = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(release) && release.length <= 53 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns) && !!chart;
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const req = { release, chart, version: version || undefined, namespace: ns, values, createNamespace: createNs, reuseValues: reuse, dryRun };
      const r = await call(mode === 'install' ? 'helm:install' : 'helm:upgrade', req);
      if (dryRun) setPreview(r);
      else {
        toast('success', `${mode === 'install' ? 'Installed' : 'Upgraded'} ${r.release} (revision ${r.revision}, ${r.status})`);
        onDone();
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'install' ? `Install ${chart}` : `Upgrade ${initial.release}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!valid || busy} onClick={() => void run(true)}>
            Dry run
          </button>
          <button className="btn btn-primary" disabled={!valid || busy || !preview} onClick={() => void run(false)} title={preview ? '' : 'Run a dry run first'}>
            {mode === 'install' ? 'Install' : 'Upgrade'}
          </button>
        </>
      }
    >
      <div className="deploy-grid">
        <label className="field">
          <span>Chart (repo/chart or oci://…)</span>
          <input value={chart} onChange={(e) => setChart(e.target.value.trim())} />
        </label>
        <label className="field">
          <span>Version</span>
          {versions.length ? (
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="">latest</option>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version} (app {v.app_version})
                </option>
              ))}
            </select>
          ) : (
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="latest" />
          )}
        </label>
        <label className="field">
          <span>Release name</span>
          <input value={release} onChange={(e) => setRelease(e.target.value.trim())} disabled={mode === 'upgrade'} aria-invalid={!!release && !valid} />
        </label>
        <label className="field">
          <span>Namespace</span>
          <input value={ns} onChange={(e) => setNs(e.target.value.trim())} disabled={mode === 'upgrade'} />
        </label>
      </div>
      <div className="toolbar">
        {mode === 'install' ? (
          <label className="check">
            <input type="checkbox" checked={createNs} onChange={(e) => setCreateNs(e.target.checked)} /> Create namespace if missing
          </label>
        ) : (
          <label className="check">
            <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} /> Reuse the release's current values (merge with the values below)
          </label>
        )}
      </div>
      <div className="deploy-values">
        <YamlEditor value={values} onChange={setValues} dark={dark} manifest={false} />
      </div>
      {error && <div className="inline-error pre">{error}</div>}
      {preview && (
        <div className="inline-ok">
          Dry run passed: {preview.release} would be {mode === 'install' ? 'installed' : `upgraded to revision ${preview.revision}`} ({(preview.manifest.match(/^kind:/gm) ?? []).length} objects).
          <details>
            <summary>Rendered manifest</summary>
            <pre className="kv-value">{preview.manifest}</pre>
          </details>
          {preview.notes && (
            <details>
              <summary>Chart notes</summary>
              <pre className="kv-value">{preview.notes}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}

function ReleaseDetails({ release, dark, onChanged }: { release: HelmRelease; dark: boolean; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('values');
  const [content, setContent] = useState<string | null>(null);
  const [history, setHistory] = useState<HelmHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<{ values: string; chart: string } | null>(null);
  const { confirm } = useDialogs();
  const toast = useToast();

  useEffect(() => {
    setContent(null);
    setError(null);
    const p =
      tab === 'history'
        ? call('helm:history', release.namespace, release.name).then((h) => setHistory([...h].reverse()))
        : (tab === 'manifest' ? call('helm:manifest', release.namespace, release.name) : call('helm:values', release.namespace, release.name, tab === 'all-values')).then(setContent);
    p.catch((err) => setError(errorMessage(err)));
  }, [tab, release.name, release.namespace, release.revision]);

  const rollback = async (rev: number) => {
    if (!(await confirm({ title: 'Rollback release', message: `Roll back ${release.name} to revision ${rev}?`, confirmLabel: 'Rollback' }))) return;
    try {
      await call('helm:rollback', release.namespace, release.name, rev);
      toast('success', `Rolled back ${release.name} to revision ${rev}`);
      onChanged();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const uninstall = async () => {
    if (!(await confirm({ title: 'Uninstall release', message: `Uninstall Helm release ${release.namespace}/${release.name}? All its resources will be deleted.`, danger: true, confirmLabel: 'Uninstall', typeToConfirm: release.name }))) return;
    try {
      await call('helm:uninstall', release.namespace, release.name);
      toast('success', `Uninstalled ${release.name}`);
      onChanged();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  return (
    <aside className="details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-tag">Helm</span>
          <h2>{release.name}</h2>
          <span className="muted">
            {release.chart} · rev {release.revision}
          </span>
        </div>
      </header>
      <div className="details-actions">
        <button
          className="btn btn-sm"
          onClick={async () => {
            try {
              const v = await call('helm:values', release.namespace, release.name, false);
              // helm list reports "name-version"; find the matching chart in the configured repositories.
              const base = release.chart.replace(/-v?\d+\.\d+\.\d+.*$/, '');
              const found = await call('helm:search', base).catch(() => []);
              const chart = found.find((c) => c.name.split('/')[1] === base)?.name ?? '';
              setUpgrade({ values: v.trim() === 'null' ? '' : v, chart });
            } catch (e) {
              toast('error', errorMessage(e));
            }
          }}
        >
          Upgrade
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => void uninstall()}>
          Uninstall
        </button>
      </div>
      <nav className="tabs">
        {(
          [
            ['values', 'User values'],
            ['all-values', 'All values'],
            ['manifest', 'Manifest'],
            ['history', 'History'],
          ] as Array<[Tab, string]>
        ).map(([t, l]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {l}
          </button>
        ))}
      </nav>
      <div className="details-body">
        {error && <div className="inline-error">{error}</div>}
        {tab !== 'history' && content !== null && <YamlEditor value={content} readOnly dark={dark} manifest={false} />}
        {tab === 'history' && history && (
          <table className="mini-table">
            <thead>
              <tr>
                <th>Rev</th>
                <th>Updated</th>
                <th>Status</th>
                <th>Chart</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.revision}>
                  <td>{h.revision}</td>
                  <td>{h.updated}</td>
                  <td>{h.status}</td>
                  <td>{h.chart}</td>
                  <td className="cell-wrap">{h.description}</td>
                  <td>
                    {String(h.revision) !== String(release.revision) && (
                      <button className="btn btn-sm" onClick={() => void rollback(h.revision)}>
                        Rollback
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {upgrade && (
        <DeployDialog
          mode="upgrade"
          initial={{ chart: upgrade.chart, release: release.name, namespace: release.namespace, values: upgrade.values }}
          dark={dark}
          onClose={() => setUpgrade(null)}
          onDone={onChanged}
        />
      )}
    </aside>
  );
}

function Releases({ namespace, dark }: { namespace: string; dark: boolean }) {
  const [releases, setReleases] = useState<HelmRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    call('helm:list', namespace || undefined)
      .then(setReleases)
      .catch((err) => setError(errorMessage(err)));
  }, [namespace]);
  useEffect(load, [load]);
  const rel = releases?.find((r) => `${r.namespace}/${r.name}` === selected);
  return (
    <div className={`resource-view ${rel ? 'with-details' : ''}`}>
      <div className="list-pane">
        <div className="toolbar mon-pad">
          <span className="count">{releases?.length ?? 0} releases</span>
          <div className="spacer" />
          <button className="btn btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
        {error && <div className="inline-error">{error}</div>}
        {releases && (
          <div className="table-wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Namespace</th>
                  <th>Revision</th>
                  <th>Status</th>
                  <th>Chart</th>
                  <th>App version</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={`${r.namespace}/${r.name}`} className={selected === `${r.namespace}/${r.name}` ? 'selected' : ''} onClick={() => setSelected(`${r.namespace}/${r.name}`)}>
                    <td className="cell-name">{r.name}</td>
                    <td>{r.namespace}</td>
                    <td>{r.revision}</td>
                    <td>
                      <span className={`badge badge-${r.status === 'deployed' ? 'ok' : r.status === 'failed' ? 'error' : 'pending'}`}>{r.status}</span>
                    </td>
                    <td>{r.chart}</td>
                    <td>{r.app_version}</td>
                    <td>{r.updated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {releases.length === 0 && <div className="empty">No Helm releases{namespace ? ` in ${namespace}` : ''}. Install one from the Charts tab.</div>}
          </div>
        )}
      </div>
      {rel && <ReleaseDetails release={rel} dark={dark} onChanged={load} />}
    </div>
  );
}

function Charts({ namespace, dark }: { namespace: string; dark: boolean }) {
  const [repos, setRepos] = useState<HelmRepo[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HelmChartVersion[] | null>(null);
  const [chart, setChart] = useState<HelmChartVersion | null>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [install, setInstall] = useState(false);
  const [newRepo, setNewRepo] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { confirm } = useDialogs();

  const loadRepos = useCallback(() => {
    call('helm:repos')
      .then(setRepos)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const search = useCallback(() => {
    call('helm:search', query)
      .then(setResults)
      .catch((e) => setError(errorMessage(e)));
  }, [query]);
  useEffect(loadRepos, [loadRepos]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(search, [repos]);
  useEffect(() => {
    if (!chart) return;
    setReadme(null);
    call('helm:showReadme', chart.name, chart.version)
      .then(setReadme)
      .catch((e) => setReadme(`README not available: ${errorMessage(e)}`));
  }, [chart]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast('success', ok);
      loadRepos();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const repoNames = useMemo(() => new Set((repos ?? []).map((r) => r.name)), [repos]);

  return (
    <div className="charts-pane">
      <section className="panel">
        <h3>Repositories</h3>
        <table className="mini-table">
          <tbody>
            {(repos ?? []).map((r) => (
              <tr key={r.name}>
                <td className="cell-name">{r.name}</td>
                <td className="mono cell-wrap">{r.url}</td>
                <td style={{ width: 80 }}>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      if (await confirm({ title: 'Remove repository', message: `Remove Helm repository ${r.name}?`, confirmLabel: 'Remove' })) await act(() => call('helm:repoRemove', r.name), `Removed ${r.name}`);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {repos?.length === 0 && <p className="muted">No repositories yet. Add one below (for example a chart repository URL from your vendor).</p>}
        <div className="toolbar">
          <input placeholder="name" value={newRepo.name} onChange={(e) => setNewRepo({ ...newRepo, name: e.target.value.trim() })} aria-label="Repository name" />
          <input className="search" placeholder="https://charts.example.com" value={newRepo.url} onChange={(e) => setNewRepo({ ...newRepo, url: e.target.value.trim() })} aria-label="Repository URL" />
          <button className="btn btn-sm btn-primary" disabled={busy || !newRepo.name || !newRepo.url || repoNames.has(newRepo.name)} onClick={() => void act(() => call('helm:repoAdd', newRepo.name, newRepo.url), `Added ${newRepo.name}`).then(() => setNewRepo({ name: '', url: '' }))}>
            Add repository
          </button>
          <button className="btn btn-sm" disabled={busy || !repos?.length} onClick={() => void act(() => call('helm:repoUpdate'), 'Repositories updated')}>
            Update all
          </button>
        </div>
        {error && <div className="inline-error pre">{error}</div>}
      </section>
      <section className="panel">
        <h3>Charts</h3>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input className="search" placeholder="Search charts in your repositories…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search charts" />
          <button className="btn btn-sm" type="submit">
            Search
          </button>
        </form>
        <div className="charts-split">
          <div className="table-wrap chart-list">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Chart</th>
                  <th>Version</th>
                  <th>App</th>
                </tr>
              </thead>
              <tbody>
                {(results ?? []).map((c) => (
                  <tr key={c.name} className={chart?.name === c.name ? 'selected' : ''} onClick={() => setChart(c)}>
                    <td className="cell-name" title={c.description}>
                      {c.name}
                    </td>
                    <td>{c.version}</td>
                    <td>{c.app_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {results?.length === 0 && <div className="empty">No charts found.</div>}
          </div>
          <div className="chart-detail">
            {chart ? (
              <>
                <div className="toolbar">
                  <b>{chart.name}</b>
                  <span className="muted">{chart.description}</span>
                  <div className="spacer" />
                  <button className="btn btn-sm btn-primary" onClick={() => setInstall(true)} data-testid="install-chart">
                    Install…
                  </button>
                </div>
                <pre className="kv-value chart-readme">{readme ?? 'Loading README…'}</pre>
              </>
            ) : (
              <div className="empty">Select a chart to see its README and install it.</div>
            )}
          </div>
        </div>
      </section>
      {install && chart && <DeployDialog mode="install" initial={{ chart: chart.name, version: chart.version, namespace: namespace || 'default', release: chart.name.split('/')[1] }} dark={dark} onClose={() => setInstall(false)} onDone={() => undefined} />}
    </div>
  );
}

export function HelmView({ namespace, dark }: { namespace: string; dark: boolean }) {
  const [helm, setHelm] = useState<{ available: boolean; version?: string } | null>(null);
  const [tab, setTab] = useState<'releases' | 'charts'>('releases');
  useEffect(() => {
    void call('helm:available').then(setHelm);
  }, []);
  if (!helm) return <div className="empty">Checking for Helm…</div>;
  if (!helm.available)
    return (
      <div className="empty">
        <h2>Helm CLI not found</h2>
        <p>Helm features use the Helm 3 CLI. Install helm, or set its path in Settings.</p>
      </div>
    );
  return (
    <div className="helm-view">
      <div className="view-header">
        <h1>Helm</h1>
        <span className="muted">{helm.version}</span>
      </div>
      <nav className="tabs mon-pad" role="tablist">
        <button role="tab" aria-selected={tab === 'releases'} className={tab === 'releases' ? 'active' : ''} onClick={() => setTab('releases')}>
          Releases
        </button>
        <button role="tab" aria-selected={tab === 'charts'} className={tab === 'charts' ? 'active' : ''} onClick={() => setTab('charts')} data-testid="helm-charts-tab">
          Charts &amp; repositories
        </button>
      </nav>
      {tab === 'releases' ? <Releases namespace={namespace} dark={dark} /> : <Charts namespace={namespace} dark={dark} />}
    </div>
  );
}
