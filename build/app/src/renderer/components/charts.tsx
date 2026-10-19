import { useEffect, useMemo, useRef, useState } from 'react';

/** Chart roles map to CSS variables defined per theme in app.css (validated palette slots 1–3). */
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;

export interface Series {
  name: string;
  values: number[];
  color: string;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** "Nice" axis maximum and ticks. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: step * Math.ceil(max / step), step };
}

/** Time axis label: seconds are shown when the visible span is short, so ticks never repeat. */
export const timeLabel = (t: number, spanMs: number) =>
  new Date(t).toLocaleTimeString([], spanMs < 3 * 60_000 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

/** Include the reference line in the y-scale only when it is close enough not to flatten the data. */
export function scaleMax(dataMax: number, reference?: number): { max: number; showReference: boolean } {
  const showReference = reference !== undefined && reference > 0 && (dataMax <= 0 ? false : reference <= dataMax * 3);
  return { max: Math.max(dataMax, showReference ? reference! : 0), showReference };
}

export function LineChart({
  t,
  series,
  format,
  height = 170,
  reference,
  title,
}: {
  t: number[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
  /** A horizontal reference (e.g. allocatable capacity), drawn as a dashed muted line with a label. */
  reference?: { value: number; label: string };
  title: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 12, t: 10, b: 22 };
  const plotW = Math.max(10, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const finite = series.flatMap((s) => s.values.filter(Number.isFinite));
  const scaled = scaleMax(Math.max(0, ...finite), reference?.value);
  const { max, step } = niceScale(scaled.max * 1.1 || 1);
  const t0 = t[0] ?? 0;
  const t1 = t[t.length - 1] ?? 1;
  const x = (ti: number) => pad.l + (t1 === t0 ? plotW : ((ti - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = '';
        let pen = false;
        s.values.forEach((v, i) => {
          if (!Number.isFinite(v)) {
            pen = false;
            return;
          }
          d += `${pen ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        });
        return d;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, t, width, max],
  );

  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  const xTicks = t.length > 1 ? [t0, t0 + (t1 - t0) / 2, t1] : [];

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (t.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ti = t0 + (px / plotW) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - ti) < Math.abs(t[best] - ti)) best = i;
    setHover(best);
  };

  return (
    <figure className="chart" aria-label={title}>
      <figcaption className="chart-title">
        <span>
          {title}
          {reference && !scaled.showReference && reference.value > 0 && (
            <span className="muted"> · {reference.label} {format(reference.value)}</span>
          )}
        </span>
        {series.length > 1 && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.name} className="legend-item">
                <span className="legend-swatch" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="chart-body" ref={ref}>
        {width > 0 && (
          <svg width={width} height={height} role="img">
            {ticks.map((v) => (
              <g key={v}>
                <line className="grid" x1={pad.l} x2={pad.l + plotW} y1={y(v)} y2={y(v)} />
                <text className="axis" x={pad.l - 6} y={y(v) + 3} textAnchor="end">
                  {format(v)}
                </text>
              </g>
            ))}
            {xTicks.map((ti, i) => (
              <text key={ti} className="axis" x={x(ti)} y={height - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
                {timeLabel(ti, t1 - t0)}
              </text>
            ))}
            {reference && scaled.showReference && (
              <g>
                <line className="reference" x1={pad.l} x2={pad.l + plotW} y1={y(reference.value)} y2={y(reference.value)} />
                <text className="axis" x={pad.l + plotW - 2} y={y(reference.value) - 4} textAnchor="end">
                  {reference.label} {format(reference.value)}
                </text>
              </g>
            )}
            {paths.map((d, i) => (
              <path key={series[i].name} d={d} fill="none" stroke={series[i].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {series.map((sr) =>
              sr.values.map((v, i) =>
                Number.isFinite(v) && !Number.isFinite(sr.values[i - 1]) && !Number.isFinite(sr.values[i + 1]) ? <circle key={`${sr.name}-${i}`} cx={x(t[i])} cy={y(v)} r={2.5} fill={sr.color} /> : null,
              ),
            )}
            {hover !== null && (
              <g>
                <line className="crosshair" x1={x(t[hover])} x2={x(t[hover])} y1={pad.t} y2={pad.t + plotH} />
                {series.map((s) =>
                  Number.isFinite(s.values[hover]) ? <circle key={s.name} cx={x(t[hover])} cy={y(s.values[hover])} r={4} fill={s.color} className="hover-dot" /> : null,
                )}
              </g>
            )}
            <rect x={pad.l} y={pad.t} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>
        )}
        {hover !== null && width > 0 && (
          <div className="chart-tooltip" style={{ left: Math.min(Math.max(x(t[hover]) + 10, 0), width - 170) }}>
            <div className="tooltip-time">{new Date(t[hover]).toLocaleTimeString()}</div>
            {series.map((s) => (
              <div key={s.name} className="tooltip-row">
                <span className="legend-swatch" style={{ background: s.color }} />
                <span>{s.name}</span>
                <b>{Number.isFinite(s.values[hover]) ? format(s.values[hover]) : '–'}</b>
              </div>
            ))}
          </div>
        )}
        {t.length < 2 && <div className="chart-empty">Collecting samples…</div>}
      </div>
    </figure>
  );
}

export function Sparkline({ values, color = SERIES[0], width = 90, height = 22, label }: { values: number[]; color?: string; width?: number; height?: number; label: string }) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return <span className="muted spark-empty">–</span>;
  const max = Math.max(...finite) || 1;
  const min = Math.min(...finite);
  const range = max - min || max || 1;
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    const px = (i / (values.length - 1)) * (width - 2) + 1;
    const py = height - 2 - ((v - min) / range) * (height - 4);
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    pen = true;
  });
  return (
    <svg width={width} height={height} className="sparkline" role="img" aria-label={label}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Usage vs capacity with request and limit ticks; severity follows thresholds and is always paired with the % label. */
export function UsageBar({ used, capacity, request, limit, label }: { used?: number; capacity: number; request?: number; limit?: number; label: string }) {
  const pct = (v: number | undefined) => (v === undefined || !capacity ? undefined : Math.min(100, (v / capacity) * 100));
  if (!capacity) return <span className="muted usagebar-none" title={`${label}: no request or limit set`}>no request/limit</span>;
  const u = pct(used);
  const r = pct(request);
  const l = pct(limit);
  const sev = u === undefined ? '' : u >= 90 ? 'critical' : u >= 75 ? 'warning' : '';
  const title = `${label}: ${u !== undefined ? u.toFixed(0) + '% used' : 'usage n/a'}${r !== undefined ? ` · ${r.toFixed(0)}% requested` : ''}${l !== undefined && l > 0 ? ` · ${l.toFixed(0)}% limits` : ''}`;
  return (
    <div className="usagebar" title={title} aria-label={title}>
      <div className="usagebar-track">
        {u !== undefined && <div className={`usagebar-fill ${sev}`} style={{ width: `${u}%` }} />}
        {r !== undefined && r > 0 && <div className="usagebar-tick request" style={{ left: `${r}%` }} />}
        {l !== undefined && l > 0 && <div className="usagebar-tick limit" style={{ left: `${l}%` }} />}
      </div>
      <span className={`usagebar-pct ${sev}`}>{u !== undefined ? `${u.toFixed(0)}%` : r !== undefined ? `req ${r.toFixed(0)}%` : '–'}</span>
    </div>
  );
}
