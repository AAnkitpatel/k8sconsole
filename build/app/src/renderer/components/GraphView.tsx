import { useEffect, useMemo, useRef, useState } from 'react';
import { KIND_RANK, type EdgeType, type GraphNode, type ResourceGraph } from '../../shared/graph';

const NODE_W = 196;
const NODE_H = 46;
const COL_GAP = 84;
const ROW_GAP = 14;

export const EDGE_STYLE: Record<EdgeType, { dash: string; label: string }> = {
  owns: { dash: '', label: 'owns' },
  selects: { dash: '6 4', label: 'selects' },
  routes: { dash: '', label: 'routes traffic' },
  mounts: { dash: '2 4', label: 'mounts / references' },
  binds: { dash: '8 3 2 3', label: 'binds volume' },
  uses: { dash: '2 4', label: 'uses identity' },
  'runs-on': { dash: '1 5', label: 'runs on' },
  scales: { dash: '10 4', label: 'scales' },
  guards: { dash: '4 2', label: 'network policy' },
};

export interface Positioned extends GraphNode {
  x: number;
  y: number;
}

/** Layered layout: one column per kind rank; rows ordered by the barycenter of neighbours to reduce crossings. */
export function layoutGraph(g: ResourceGraph): { nodes: Positioned[]; width: number; height: number } {
  const ranks = new Map<number, GraphNode[]>();
  for (const n of g.nodes) {
    const r = KIND_RANK[n.kind] ?? 5;
    (ranks.get(r) ?? ranks.set(r, []).get(r)!).push(n);
  }
  const cols = [...ranks.keys()].sort((a, b) => a - b);
  const order = new Map<string, number>();
  for (const c of cols) ranks.get(c)!.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).forEach((n, i) => order.set(n.id, i));
  const nbrs = new Map<string, string[]>();
  for (const e of g.edges) {
    (nbrs.get(e.from) ?? nbrs.set(e.from, []).get(e.from)!).push(e.to);
    (nbrs.get(e.to) ?? nbrs.set(e.to, []).get(e.to)!).push(e.from);
  }
  for (let pass = 0; pass < 4; pass++) {
    const seq = pass % 2 === 0 ? cols : [...cols].reverse();
    for (const c of seq) {
      const list = ranks.get(c)!;
      const bary = (n: GraphNode) => {
        const ns = (nbrs.get(n.id) ?? []).map((x) => order.get(x)).filter((v): v is number => v !== undefined);
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : order.get(n.id)!;
      };
      list.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name));
      list.forEach((n, i) => order.set(n.id, i));
    }
  }
  const tallest = Math.max(1, ...cols.map((c) => ranks.get(c)!.length));
  const height = tallest * (NODE_H + ROW_GAP) + 40;
  const nodes: Positioned[] = [];
  cols.forEach((c, ci) => {
    const list = ranks.get(c)!;
    const colH = list.length * (NODE_H + ROW_GAP);
    const top = (height - colH) / 2;
    list.forEach((n, i) => nodes.push({ ...n, x: 20 + ci * (NODE_W + COL_GAP), y: top + i * (NODE_H + ROW_GAP) }));
  });
  return { nodes, width: 40 + cols.length * (NODE_W + COL_GAP) - COL_GAP, height };
}

export function GraphView({
  graph,
  onOpen,
  highlight,
  emptyText,
  edgeLabels,
}: {
  graph: ResourceGraph;
  onOpen?: (n: GraphNode) => void;
  highlight?: string;
  emptyText: string;
  /** Overrides legend wording (e.g. ECS calls a `guards` edge a security group). */
  edgeLabels?: Partial<Record<EdgeType, string>>;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const fit = () => {
    const el = host.current;
    if (!el || !layout.width) return;
    const k = Math.min(1.2, Math.max(0.25, Math.min(el.clientWidth / (layout.width + 20), el.clientHeight / (layout.height + 20))));
    setView({ k, x: (el.clientWidth - layout.width * k) / 2, y: Math.max(0, (el.clientHeight - layout.height * k) / 2) });
  };
  useEffect(fit, [layout]);

  const focus = hover ?? highlight ?? null;
  const related = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of graph.edges) if (e.from === focus || e.to === focus) s.add(e.from).add(e.to);
    return s;
  }, [focus, graph.edges]);

  if (graph.nodes.length === 0) return <div className="empty">{emptyText}</div>;

  return (
    <div className="graph">
      <div className="graph-tools">
        <button className="btn btn-sm" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.2) }))} aria-label="Zoom in">
          +
        </button>
        <button className="btn btn-sm" onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))} aria-label="Zoom out">
          −
        </button>
        <button className="btn btn-sm" onClick={fit}>
          Fit
        </button>
        <span className="muted">
          {graph.nodes.length} objects · {graph.edges.length} relations{graph.truncated ? ` · ${graph.truncated} hidden` : ''}
        </span>
      </div>
      <div
        className="graph-canvas"
        ref={host}
        data-testid="graph-canvas"
        onWheel={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          setView((v) => {
            const k = Math.min(2.5, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
            return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
          });
        }}
        onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y })}
        onMouseMove={(e) => {
          // Compute the position now: the drag can end before React runs a state updater.
          const d = drag.current;
          if (!d) return;
          const x = d.vx + e.clientX - d.x;
          const y = d.vy + e.clientY - d.y;
          setView((v) => ({ ...v, x, y }));
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        <svg width="100%" height="100%">
          <defs>
            <marker id="gv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="gv-arrow" />
            </marker>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {graph.edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const forward = a.x <= b.x;
              const x1 = forward ? a.x + NODE_W : a.x;
              const x2 = forward ? b.x : b.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const y2 = b.y + NODE_H / 2;
              const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
              const dim = related && !(related.has(e.from) && related.has(e.to));
              return (
                <path
                  key={`${e.from}|${e.to}|${e.type}`}
                  d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                  className={`gv-edge gv-edge-${e.type} ${dim ? 'dim' : ''}`}
                  strokeDasharray={EDGE_STYLE[e.type].dash}
                  markerEnd="url(#gv-arrow)"
                >
                  <title>{`${a.kind} ${a.name} ${EDGE_STYLE[e.type].label} ${b.kind} ${b.name}`}</title>
                </path>
              );
            })}
            {layout.nodes.map((n) => {
              const dim = related && !related.has(n.id);
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className={`gv-node ${dim ? 'dim' : ''} ${n.id === highlight ? 'root' : ''}`}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!n.id.startsWith('More/')) onOpen?.(n);
                  }}
                  data-testid="graph-node"
                >
                  <rect width={NODE_W} height={NODE_H} rx={8} className="gv-box" />
                  <rect width={5} height={NODE_H} rx={2} className={`gv-status gv-status-${n.status}`} />
                  <text x={14} y={17} className="gv-kind">
                    {n.kind}
                    {n.detail ? ` · ${n.detail}` : ''}
                  </text>
                  <text x={14} y={35} className="gv-name">
                    {n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name}
                  </text>
                  <title>{`${n.kind} ${n.namespace ? n.namespace + '/' : ''}${n.name}${n.detail ? ` (${n.detail})` : ''}`}</title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="graph-legend" aria-label="Relationship legend">
        {[...new Set(graph.edges.map((e) => e.type))].map((t) => (
          <span key={t} className="legend-item">
            <svg width="26" height="8">
              <line x1="0" y1="4" x2="26" y2="4" className={`gv-edge gv-edge-${t}`} strokeDasharray={EDGE_STYLE[t].dash} />
            </svg>
            {edgeLabels?.[t] ?? EDGE_STYLE[t].label}
          </span>
        ))}
        <span className="legend-item">
          <span className="gv-status-chip gv-status-ok" /> healthy
        </span>
        <span className="legend-item">
          <span className="gv-status-chip gv-status-warn" /> degraded
        </span>
        <span className="legend-item">
          <span className="gv-status-chip gv-status-error" /> failing
        </span>
        <span className="legend-item">
          <span className="gv-status-chip gv-status-pending" /> pending
        </span>
      </div>
    </div>
  );
}
