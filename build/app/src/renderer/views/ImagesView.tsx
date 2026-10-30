import { useMemo, useState } from 'react';
import { SEVERITIES, totalCounts, type ImageScan, type ImageUse, type Severity } from '../../shared/images';
import { call, errorMessage } from '../lib/api';
import { useToast } from '../components/Dialogs';
import { DataTable, LoadState, useLoad } from '../ecs/common';

type Row = ImageUse & { scan?: ImageScan };
const SEV_CLASS: Record<Severity, string> = { CRITICAL: 'sev-critical', HIGH: 'sev-high', MEDIUM: 'sev-medium', LOW: 'sev-low', UNKNOWN: 'sev-low' };

function Counts({ scan }: { scan?: ImageScan }) {
  if (!scan) return <span className="muted">not scanned</span>;
  const shown = SEVERITIES.filter((s) => s !== 'UNKNOWN' && scan.counts[s] > 0);
  if (!shown.length) return <span className="badge badge-ok">no known vulnerabilities</span>;
  return (
    <span className="chips">
      {shown.map((s) => (
        <span key={s} className={`sev-chip ${SEV_CLASS[s]}`}>
          {scan.counts[s]} {s.toLowerCase()}
        </span>
      ))}
    </span>
  );
}

/** Image vulnerabilities for Kubernetes (namespace) or Amazon ECS (cluster). */
export function ImagesView({ source, namespace, cluster }: { source: 'kubernetes' | 'ecs'; namespace?: string; cluster?: string }) {
  const r = useLoad(() => (source === 'ecs' ? (cluster ? call('images:ecs', cluster) : Promise.resolve(null)) : call('images:list', namespace || undefined)), [source, namespace, cluster]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scans, setScans] = useState<Record<string, ImageScan>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const toast = useToast();

  const rows: Row[] = useMemo(() => (r.data?.images ?? []).map((i) => ({ ...i, scan: scans[i.image] ?? i.scan })), [r.data, scans]);
  const scanned = rows.filter((x) => x.scan);
  const totals = totalCounts(scanned.map((x) => x.scan!));
  const operator = r.data && 'operator' in r.data ? r.data.operator : false;
  const trivy = r.data?.trivyPath;

  const scan = async (image: string) => {
    setBusy((b) => ({ ...b, [image]: true }));
    try {
      const s = await call('images:scan', image, source);
      setScans((x) => ({ ...x, [image]: s }));
    } catch (err) {
      toast('error', `Scan of ${image} failed: ${errorMessage(err)}`);
    } finally {
      setBusy((b) => ({ ...b, [image]: false }));
    }
  };
  const scanAll = async () => {
    for (const i of rows.filter((x) => !x.scan)) await scan(i.image);
  };
  const sel = rows.find((x) => x.image === selected);

  return (
    <div className={`resource-view platform-view ${sel ? 'with-details' : ''}`} data-testid="images-view">
      <div className="list-pane">
        <div className="view-header">
          <h1>Image Vulnerabilities</h1>
          <span className="count">{rows.length}</span>
          <span className="muted">{source === 'ecs' ? 'images in this cluster’s task definitions' : namespace ? `images running in ${namespace}` : 'images running in the cluster'}</span>
          <div className="spacer" />
          <input className="search" placeholder="Filter images or workloads…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter images" />
          {trivy && (
            <button className="btn btn-sm btn-primary" onClick={() => void scanAll()} disabled={!rows.some((x) => !x.scan) || Object.values(busy).some(Boolean)} data-testid="scan-all">
              Scan unscanned images
            </button>
          )}
          <button className="btn btn-sm" onClick={() => void r.reload()}>
            Refresh
          </button>
        </div>
        {r.data && (
          <div className="cards platform-cards">
            <div className="card">
              <div className="card-title">Images scanned</div>
              <div className="card-value">
                {scanned.length}/{rows.length}
              </div>
              <div className="card-sub">{operator ? 'Trivy Operator reports' : ''}{operator && trivy ? ' + ' : ''}{trivy ? 'local Trivy' : ''}{!operator && !trivy ? 'no scanner found' : ''}</div>
            </div>
            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
              <div key={s} className={`card sev-card ${SEV_CLASS[s]}`}>
                <div className="card-title">{s.toLowerCase()}</div>
                <div className="card-value" data-testid={`images-${s.toLowerCase()}`}>
                  {totals[s]}
                </div>
              </div>
            ))}
          </div>
        )}
        {r.data && !operator && !trivy && (
          <div className="inline-warn" data-testid="images-no-scanner">
            No vulnerability scanner is available. Either install the <b>Trivy Operator</b> in the cluster (it scans running images and K8sConsole reads its reports, agent-free for this app), or install the <b>trivy</b> CLI on this computer (trivy.dev) and scan images from here.
          </div>
        )}
        <LoadState loading={r.loading && !r.data} error={r.error} what="images" />
        {r.data?.notes.map((n) => (
          <div key={n} className="inline-warn">
            {n}
          </div>
        ))}
        {r.data && (
          <DataTable
            rows={rows}
            rowKey={(x) => x.image}
            selected={selected}
            onSelect={(x) => setSelected(x.image)}
            filter={filter}
            match={(x, f) => x.image.toLowerCase().includes(f) || x.usedBy.some((u) => u.toLowerCase().includes(f))}
            initialSort={{ key: 'risk', dir: -1 }}
            testId="image-row"
            cols={[
              { key: 'image', title: 'Image', render: (x) => <span className="mono cell-wrap">{x.image}</span>, sort: (x) => x.image },
              { key: 'risk', title: 'Vulnerabilities', render: (x) => <Counts scan={x.scan} />, sort: (x) => (x.scan ? x.scan.counts.CRITICAL * 1e6 + x.scan.counts.HIGH * 1e3 + x.scan.counts.MEDIUM : -1) },
              { key: 'fix', title: 'Fixable', render: (x) => (x.scan ? x.scan.fixable : ''), sort: (x) => x.scan?.fixable ?? -1 },
              { key: 'used', title: 'Used by', render: (x) => <span className="cell-wrap muted">{x.usedBy.slice(0, 3).join(', ')}{x.usedBy.length > 3 ? ` +${x.usedBy.length - 3}` : ''}</span> },
              {
                key: 'act',
                title: '',
                render: (x) =>
                  trivy ? (
                    <span onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm" disabled={busy[x.image]} onClick={() => void scan(x.image)} data-testid="scan-image">
                        {busy[x.image] ? 'Scanning…' : x.scan ? 'Rescan' : 'Scan'}
                      </button>
                    </span>
                  ) : null,
              },
            ]}
            empty={filter ? 'No images match.' : 'No images found.'}
          />
        )}
      </div>
      {sel && (
        <aside className="details" aria-label="Image details">
          <header className="details-header">
            <div className="details-title">
              <span className="kind-tag">Image</span>
              <h2 className="mono" title={sel.image}>
                {sel.image}
              </h2>
            </div>
            <button className="icon-btn" aria-label="Close details" onClick={() => setSelected(null)}>
              ×
            </button>
          </header>
          <div className="details-body">
            <p>
              <Counts scan={sel.scan} />
            </p>
            {sel.scan && (
              <p className="muted">
                {sel.scan.source === 'trivy-operator' ? 'From the Trivy Operator' : 'Scanned with Trivy on this computer'}
                {sel.scan.scannedAt ? ` · ${new Date(sel.scan.scannedAt).toLocaleString()}` : ''} · {sel.scan.fixable} of {sel.scan.vulns.length} have a fix
              </p>
            )}
            <h3 className="sub-h">Used by</h3>
            <ul className="plain-list">
              {sel.usedBy.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            {sel.scan && sel.scan.vulns.length > 0 && (
              <>
                <h3 className="sub-h">Vulnerabilities</h3>
                <table className="mini-table" data-testid="vuln-table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>ID</th>
                      <th>Package</th>
                      <th>Installed</th>
                      <th>Fixed in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sel.scan.vulns.slice(0, 500).map((v) => (
                      <tr key={`${v.id}|${v.pkg}|${v.installed}`} title={v.title}>
                        <td>
                          <span className={`sev-chip ${SEV_CLASS[v.severity]}`}>{v.severity.toLowerCase()}</span>
                        </td>
                        <td>{v.url ? <button className="link" onClick={() => void call('app:openExternal', v.url!)}>{v.id}</button> : v.id}</td>
                        <td className="mono">{v.pkg}</td>
                        <td className="mono">{v.installed}</td>
                        <td className="mono">{v.fixed ?? '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sel.scan.vulns.length > 500 && <p className="muted">Showing the 500 most severe of {sel.scan.vulns.length}.</p>}
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
