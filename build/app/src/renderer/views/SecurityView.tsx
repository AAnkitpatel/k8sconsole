import { useCallback, useEffect, useMemo, useState } from 'react';
import { stringify } from 'yaml';
import type { Finding, SecurityReport, Severity } from '../../shared/security';
import { call, errorMessage } from '../lib/api';
import { useDialogs, useToast } from '../components/Dialogs';
import type { NavigateTarget } from '../components/DetailsPanel';

const SEV: Severity[] = ['critical', 'high', 'medium', 'low'];
const SEV_ICON: Record<Severity, string> = { critical: '⛔', high: '▲', medium: '◆', low: '●' };

function FindingRow({ f, onNavigate, onFixed }: { f: Finding; onNavigate: (t: NavigateTarget) => void; onFixed: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { confirm } = useDialogs();
  const toast = useToast();

  const run = async (dryRun: boolean) => {
    if (!dryRun) {
      const ok = await confirm({
        title: 'Apply fix',
        message: `${f.fix!.description} on ${f.target.kind} ${f.target.namespace ? f.target.namespace + '/' : ''}${f.target.name}.${f.fix!.mayBreak ? ' This can stop the workload from starting if its image needs the old setting — check with a dry run and watch the rollout.' : ''} Workloads roll out new pods after the change.`,
        confirmLabel: 'Apply fix',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await call('security:fix', f, dryRun);
      setResult({ ok: r.ok, text: r.ok ? (dryRun ? 'Dry run passed: the API server accepts this change.' : 'Fix applied.') : (r.error ?? 'Failed') });
      if (r.ok && !dryRun) {
        toast('success', `Fixed: ${f.title}`);
        onFixed();
      }
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`finding sev-${f.severity}`} data-testid="finding">
      <button className="finding-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`sev-chip sev-${f.severity}`}>
          {SEV_ICON[f.severity]} {f.severity}
        </span>
        <span className="finding-title">{f.title}</span>
        <span className="muted finding-target">
          {f.target.kind} {f.target.namespace ? `${f.target.namespace}/` : ''}
          {f.target.name}
        </span>
        {f.fix && <span className="tag">fix available</span>}
      </button>
      {open && (
        <div className="finding-body">
          <p>{f.detail}</p>
          <p>
            <b>Remediation:</b> {f.remediation}
          </p>
          <button className="link" onClick={() => onNavigate({ kind: f.target.kind, apiVersion: f.target.apiVersion, namespace: f.target.namespace, name: f.target.name })}>
            Open {f.target.kind} {f.target.name}
          </button>
          {f.fix && (
            <div className="fix-box">
              <div className="fix-head">
                <b>Automatic fix:</b> {f.fix.description}
                {f.fix.mayBreak && <span className="badge badge-warn">may affect the workload</span>}
              </div>
              <pre className="kv-value">{stringify(f.fix.patch)}</pre>
              <div className="toolbar">
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(true)}>
                  Dry run
                </button>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(false)}>
                  Apply fix
                </button>
              </div>
              {result && <div className={result.ok ? 'inline-ok' : 'inline-error'}>{result.text}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SecurityView({ namespace, onNavigate }: { namespace: string; onNavigate: (t: NavigateTarget) => void }) {
  const [report, setReport] = useState<(SecurityReport & { notes: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sev, setSev] = useState<Set<Severity>>(new Set(SEV));
  const [category, setCategory] = useState<string>('all');
  const [text, setText] = useState('');

  const scan = useCallback(() => {
    setLoading(true);
    call('security:scan', namespace || undefined)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [namespace]);
  useEffect(scan, [scan]);

  const shown = useMemo(() => {
    const q = text.toLowerCase();
    return (report?.findings ?? []).filter((f) => sev.has(f.severity) && (category === 'all' || f.category === category) && (!q || `${f.title} ${f.target.name} ${f.rule}`.toLowerCase().includes(q)));
  }, [report, sev, category, text]);

  const grade = (s: number) => (s >= 90 ? 'Strong' : s >= 70 ? 'Fair' : s >= 40 ? 'Weak' : 'At risk');

  return (
    <div className="security-view">
      <div className="view-header">
        <h1>Security Scan</h1>
        <span className="muted">{namespace ? `namespace ${namespace}` : 'all namespaces'} · read-only checks of pod security, access control and network exposure</span>
        <div className="spacer" />
        <button className="btn btn-sm btn-primary" onClick={scan} disabled={loading} data-testid="rescan">
          {loading ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
      {error && <div className="inline-error mon-pad">{error}</div>}
      {report?.notes.length ? <div className="inline-warn mon-pad">Partial scan: {report.notes.join(' · ')}</div> : null}
      {report && (
        <>
          <div className="cards">
            <div className={`card score-card ${report.score >= 90 ? 'card-ok' : report.score >= 70 ? 'card-warn' : 'card-error'}`}>
              <div className="card-title">Posture score</div>
              <div className="card-value" data-testid="security-score">
                {report.score}
                <span className="muted score-of">/100</span>
              </div>
              <div className="card-sub">{grade(report.score)}</div>
            </div>
            {SEV.map((s) => (
              <button key={s} className={`card sev-card ${sev.has(s) ? '' : 'off'}`} onClick={() => setSev((x) => (x.has(s) && x.size > 1 ? new Set([...x].filter((y) => y !== s)) : new Set([...x, s])))} aria-pressed={sev.has(s)}>
                <div className="card-title">
                  {SEV_ICON[s]} {s[0].toUpperCase() + s.slice(1)}
                </div>
                <div className="card-value">{report.counts[s]}</div>
                <div className="card-sub">{sev.has(s) ? 'shown' : 'hidden'} · click to toggle</div>
              </button>
            ))}
          </div>
          <div className="toolbar mon-pad sec-filters">
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="all">All categories</option>
              <option value="workload">Workloads</option>
              <option value="access">Access control</option>
              <option value="network">Network</option>
              <option value="namespace">Namespaces</option>
            </select>
            <input className="search" placeholder="Filter findings…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter findings" />
            <span className="muted">
              {shown.length} of {report.findings.length} findings · scanned {report.scanned.workloads} workloads, {report.scanned.roles} roles, {report.scanned.bindings} bindings, {report.scanned.namespaces} namespaces
            </span>
          </div>
          <div className="findings mon-pad">
            {shown.map((f) => (
              <FindingRow key={f.id} f={f} onNavigate={onNavigate} onFixed={scan} />
            ))}
            {shown.length === 0 && <div className="empty">No findings match. {report.findings.length === 0 ? 'Nothing to fix.' : ''}</div>}
          </div>
        </>
      )}
      {!report && loading && (
        <div className="empty">
          <span className="spinner" /> Scanning…
        </div>
      )}
    </div>
  );
}
