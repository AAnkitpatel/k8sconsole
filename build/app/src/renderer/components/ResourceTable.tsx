import { useMemo, useState } from 'react';
import type { KubeObject } from '../../shared/types';
import type { Column, ColumnContext } from '../lib/columns';

const MAX_ROWS = 2000;

export const objectKey = (o: KubeObject) => o.metadata.uid ?? `${o.metadata.namespace ?? ''}/${o.metadata.name}`;

/** Matches a free-text filter against name, namespace and labels (`key=value`). */
export function matchesFilter(o: KubeObject, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return f.split(/\s+/).every((term) => {
    if (term.includes('=')) {
      const [k, v] = term.split('=', 2);
      return Object.entries(o.metadata.labels ?? {}).some(([lk, lv]) => lk.toLowerCase() === k && lv.toLowerCase() === v);
    }
    return o.metadata.name.toLowerCase().includes(term) || (o.metadata.namespace ?? '').toLowerCase().includes(term) || (o.kind === 'Event' && String(o.message ?? '').toLowerCase().includes(term));
  });
}

export function ResourceTable({
  items,
  columns,
  ctx,
  filter,
  selectedKey,
  onSelect,
  emptyText,
}: {
  items: KubeObject[];
  columns: Column[];
  ctx: ColumnContext;
  filter: string;
  selectedKey: string | null;
  onSelect: (o: KubeObject) => void;
  emptyText: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns.some((c) => c.key === 'last') ? 'last' : 'name', dir: 1 });
  const rows = useMemo(() => {
    const filtered = items.filter((o) => matchesFilter(o, filter));
    const col = columns.find((c) => c.key === sort.key);
    const sv = col?.sortValue ?? ((o: KubeObject) => String(col?.render(o, ctx) ?? ''));
    return filtered.sort((a, b) => {
      const x = sv(a, ctx);
      const y = sv(b, ctx);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return r * sort.dir || a.metadata.name.localeCompare(b.metadata.name);
    });
  }, [items, filter, sort, columns, ctx]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = rows.findIndex((r) => objectKey(r) === selectedKey);
    const next = rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) onSelect(next);
  };

  return (
    <div className="table-wrap" tabIndex={0} onKeyDown={onKeyDown}>
      <table className="rtable">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width }}
                onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}
                aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              >
                {c.title}
                {sort.key === c.key && <span className="sort-ind">{sort.dir === 1 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_ROWS).map((o) => {
            const k = objectKey(o);
            return (
              <tr key={k} className={k === selectedKey ? 'selected' : ''} onClick={() => onSelect(o)} data-testid="resource-row">
                {columns.map((c) => (
                  <td key={c.key}>{c.render(o, ctx)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">{emptyText}</div>}
      {rows.length > MAX_ROWS && <div className="empty">Showing the first {MAX_ROWS} of {rows.length} items. Refine the filter to see more.</div>}
    </div>
  );
}
