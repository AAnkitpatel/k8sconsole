import { useEffect, useMemo, useRef, useState } from 'react';
import { buildLanes, density, type TimelineOccurrence } from '../../shared/timeline';
import { useWatch } from '../lib/useWatch';
import type { NavigateTarget } from '../components/DetailsPanel';

const EVENTS = { apiVersion: 'v1', kind: 'Event', plural: 'events', namespaced: true };
const RANGES = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000 },
];
const LABEL_W = 240;
const LANE_H = 26;

const clock = (t: number, span: number) => new Date(t).toLocaleTimeString([], span <= 60 * 60_000 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

export function EventTimelineView({ namespace, onNavigate }: { namespace: string; onNavigate: (t: NavigateTarget) => void }) {
  const events = useWatch(useMemo(() => ({ resource: EVENTS, namespace: namespace || undefined }), [namespace]));
  const [range, setRange] = useState(RANGES[1].ms);
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [text, setText] = useState('');
  const [now, setNow] = useState(Date.now());
  const [hover, setHover] = useState<{ lane: string; occ: TimelineOccurrence; x: number; y: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver((e) => setWidth(Math.floor(e[0].contentRect.width)));
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  const since = now - range;
  const { lanes, hidden } = useMemo(() => buildLanes(events.items, { since, until: now, types: onlyWarnings ? ['Warning'] : undefined, text }), [events.items, since, now, onlyWarnings, text]);
  const buckets = useMemo(() => density(lanes, since, now, 60), [lanes, since, now]);
  const plotW = Math.max(200, width - LABEL_W - 16);
  const x = (t: number) => LABEL_W + ((Math.max(since, Math.min(now, t)) - since) / range) * plotW;
  const maxBucket = Math.max(1, ...buckets.map((b) => b.normal + b.warning));
  const totalWarnings = lanes.reduce((a, l) => a + l.warnings, 0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => since + f * range);

  return (
    <div className="timeline-view">
      <div className="view-header">
        <h1>Event Timeline</h1>
        <span className="count">{lanes.length} objects</span>
        <span className={totalWarnings ? 'badge badge-warn' : 'badge badge-ok'}>{totalWarnings} warnings</span>
        <div className="spacer" />
        <input className="search" placeholder="Filter reason, message or object…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter events" />
        <label className="check">
          <input type="checkbox" checked={onlyWarnings} onChange={(e) => setOnlyWarnings(e.target.checked)} /> Warnings only
        </label>
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.label} role="radio" aria-checked={range === r.ms} className={range === r.ms ? 'active' : ''} onClick={() => setRange(r.ms)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted mon-pad">Kubernetes keeps events for about an hour by default, so older ranges only show what the API server still retains.</p>
      <div className="timeline-body" ref={host}>
        {events.loading ? (
          <div className="empty">Loading events…</div>
        ) : (
          <svg width={width} height={70 + lanes.length * LANE_H + 10} className="timeline-svg" role="img" aria-label="Event timeline">
            {/* density strip */}
            <text x={8} y={22} className="tl-label">
              Activity
            </text>
            {buckets.map((b, i) => {
              const bw = plotW / buckets.length;
              const hN = (b.normal / maxBucket) * 34;
              const hW = (b.warning / maxBucket) * 34;
              return (
                <g key={i}>
                  {b.normal > 0 && <rect x={LABEL_W + i * bw + 1} y={44 - hN} width={Math.max(1, bw - 2)} height={hN} rx={1.5} className="tl-density-normal" />}
                  {b.warning > 0 && <rect x={LABEL_W + i * bw + 1} y={44 - hN - hW - (hN ? 2 : 0)} width={Math.max(1, bw - 2)} height={hW} rx={1.5} className="tl-density-warning" />}
                </g>
              );
            })}
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={x(t)} x2={x(t)} y1={48} y2={60 + lanes.length * LANE_H} className="tl-grid" />
                <text x={x(t)} y={60} className="tl-axis" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
                  {clock(t, range)}
                </text>
              </g>
            ))}
            {lanes.map((l, li) => {
              const y = 66 + li * LANE_H;
              return (
                <g key={l.key} className="tl-lane">
                  <rect x={0} y={y} width={width} height={LANE_H} className={li % 2 ? 'tl-row-alt' : 'tl-row'} />
                  <text x={8} y={y + 17} className="tl-object" onClick={() => onNavigate({ kind: l.kind, namespace: l.namespace, name: l.name })}>
                    <tspan className="tl-kind">{l.kind} </tspan>
                    {l.name.length > 24 ? `${l.name.slice(0, 23)}…` : l.name}
                    {l.warnings > 0 && <tspan className="tl-warn-count"> ⚠ {l.warnings}</tspan>}
                  </text>
                  {l.items.map((o) => {
                    const x1 = x(o.first);
                    const x2 = x(o.last);
                    const cls = o.type === 'Warning' ? 'tl-warning' : 'tl-normal';
                    return x2 - x1 > 4 ? (
                      <rect key={o.uid} x={x1} y={y + 8} width={x2 - x1} height={10} rx={4} className={`tl-bar ${cls}`} onMouseEnter={(e) => setHover({ lane: l.key, occ: o, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)} />
                    ) : (
                      <circle key={o.uid} cx={x2} cy={y + 13} r={5} className={`tl-dot ${cls}`} onMouseEnter={(e) => setHover({ lane: l.key, occ: o, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)} />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        )}
        {!events.loading && lanes.length === 0 && <div className="empty">No events in this range{namespace ? ` for ${namespace}` : ''}.</div>}
        {hidden > 0 && <div className="empty">{hidden} more objects with events are hidden. Narrow the filter.</div>}
        {hover && (
          <div className="tl-tooltip" style={{ left: Math.min(hover.x + 12, window.innerWidth - 380), top: hover.y + 12 }}>
            <div>
              <span className={`badge badge-${hover.occ.type === 'Warning' ? 'warn' : 'ok'}`}>{hover.occ.type === 'Warning' ? '⚠ Warning' : 'Normal'}</span> <b>{hover.occ.reason}</b>
              {hover.occ.count > 1 && <span className="muted"> ×{hover.occ.count}</span>}
            </div>
            <div className="muted">
              {new Date(hover.occ.first).toLocaleTimeString()}
              {hover.occ.last !== hover.occ.first ? ` – ${new Date(hover.occ.last).toLocaleTimeString()}` : ''}
            </div>
            <div className="cell-wrap">{hover.occ.message}</div>
          </div>
        )}
      </div>
      <div className="graph-legend mon-pad">
        <span className="legend-item">
          <span className="tl-legend tl-normal" /> Normal
        </span>
        <span className="legend-item">
          <span className="tl-legend tl-warning" /> ⚠ Warning
        </span>
        <span className="legend-item muted">Bars span first → last occurrence; dots are single occurrences. Click an object name to open it.</span>
      </div>
    </div>
  );
}
