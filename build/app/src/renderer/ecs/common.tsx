import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { useEcs } from './state';

/** Loads data, optionally refreshing on an interval while mounted. Keeps the last data on refresh errors. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 0): { data: T | undefined; error: string | null; loading: boolean; reload: () => Promise<void>; updatedAt: number } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(0);
  const gen = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    const g = ++gen.current;
    try {
      const v = await fnRef.current();
      if (g !== gen.current) return;
      setData(v);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (g === gen.current) setError(errorMessage(err));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Bumping the generation on cleanup discards responses that arrive after the inputs changed.
    const generation = gen;
    setLoading(true);
    setData(undefined);
    void reload();
    if (!intervalMs) return () => void generation.current++;
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, intervalMs);
    return () => {
      generation.current++;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, updatedAt };
}

export interface Col<T> {
  key: string;
  title: string;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  width?: number | string;
}

export function DataTable<T>({
  rows,
  cols,
  rowKey,
  selected,
  onSelect,
  filter,
  match,
  empty,
  testId = 'ecs-row',
  initialSort,
}: {
  rows: T[];
  cols: Col<T>[];
  rowKey: (r: T) => string;
  selected?: string | null;
  onSelect?: (r: T) => void;
  filter?: string;
  match?: (r: T, f: string) => boolean;
  empty: string;
  testId?: string;
  initialSort?: { key: string; dir: 1 | -1 };
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>(initialSort ?? { key: cols[0]?.key ?? '', dir: 1 });
  const shown = useMemo(() => {
    const f = (filter ?? '').trim().toLowerCase();
    const list = f && match ? rows.filter((r) => match(r, f)) : [...rows];
    const col = cols.find((c) => c.key === sort.key);
    if (col?.sort) {
      const sv = col.sort;
      list.sort((a, b) => {
        const x = sv(a);
        const y = sv(b);
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
      });
    }
    return list;
  }, [rows, cols, sort, filter, match]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!onSelect || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const idx = shown.findIndex((r) => rowKey(r) === selected);
    const next = shown[Math.max(0, Math.min(shown.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) onSelect(next);
  };

  return (
    <div className="table-wrap" tabIndex={0} onKeyDown={onKeyDown}>
      <table className="rtable">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width }}
                onClick={() => c.sort && setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}
                aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              >
                {c.title}
                {sort.key === c.key && c.sort && <span className="sort-ind">{sort.dir === 1 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={k === selected ? 'selected' : ''} onClick={() => onSelect?.(r)} data-testid={testId}>
                {cols.map((c) => (
                  <td key={c.key}>{c.render(r)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.length === 0 && <div className="empty">{empty}</div>}
    </div>
  );
}

export function Props({ items }: { items: Array<[string, ReactNode] | false | null | undefined> }) {
  return (
    <dl className="props">
      {items
        .filter((x): x is [string, ReactNode] => !!x && x[1] !== undefined && x[1] !== null && x[1] !== '')
        .map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Shown in place of write actions on a read-only connection. */
export function ReadOnlyNote() {
  const { readOnly } = useEcs();
  if (!readOnly) return null;
  return (
    <span className="tag" title="This AWS connection is read-only. Reconnect with read-only off to make changes." data-testid="ecs-readonly-tag">
      read-only
    </span>
  );
}

export function LoadState({ loading, error, what }: { loading: boolean; error: string | null; what: string }) {
  if (error) return <div className="inline-error">{error}</div>;
  if (loading)
    return (
      <div className="empty">
        <span className="spinner" /> Loading {what}…
      </div>
    );
  return null;
}

export function NoCluster() {
  const { clusters } = useEcs();
  return <div className="empty">{clusters.length ? 'Choose a cluster in the sidebar.' : 'No ECS clusters in this region.'}</div>;
}

export const pct = (v: number) => (Number.isFinite(v) ? `${v.toFixed(v < 10 ? 1 : 0)}%` : '–');
export const last = (a: number[]): number => {
  for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i];
  return NaN;
};
