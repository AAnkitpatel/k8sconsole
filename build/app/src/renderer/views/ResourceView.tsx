import { useEffect, useMemo, useState } from 'react';
import type { ApiResourceInfo, AppSettings, KubeObject, MetricsSnapshot, ResourceRef } from '../../shared/types';
import { columnsFor } from '../lib/columns';
import { useWatch } from '../lib/useWatch';
import { call } from '../lib/api';
import { ResourceTable, objectKey } from '../components/ResourceTable';
import { DetailsPanel, type NavigateTarget } from '../components/DetailsPanel';
import { CreateResourceDialog } from './CreateResource';
import { useSelection } from '../lib/selection';

export interface ResourceViewProps {
  title: string;
  refInfo: ResourceRef;
  namespace: string;
  discovery: ApiResourceInfo[];
  settings: AppSettings;
  dark: boolean;
  /** Object to select once it shows up in the list (from navigation). */
  pendingSelect: { namespace?: string; name: string } | null;
  onPendingHandled: () => void;
  onNavigate: (t: NavigateTarget) => void;
}

export function ResourceView({ title, refInfo, namespace, discovery, settings, dark, pendingSelect, onPendingHandled, onNavigate }: ResourceViewProps) {
  const req = useMemo(() => ({ resource: refInfo, namespace: refInfo.namespaced ? namespace : undefined }), [refInfo, namespace]);
  const watch = useWatch(req);
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(Date.now());
  const columns = useMemo(() => columnsFor(refInfo.kind, refInfo.namespaced && !namespace), [refInfo.kind, refInfo.namespaced, namespace]);
  const visibleColumns = useMemo(() => (refInfo.namespaced && namespace ? columns.filter((c) => c.key !== 'namespace') : columns), [columns, namespace, refInfo.namespaced]);
  const canCreate = discovery.find((d) => d.apiVersion === refInfo.apiVersion && d.plural === refInfo.plural)?.verbs.includes('create') ?? false;

  useEffect(() => {
    setSelectedKey(null);
    setFilter('');
  }, [refInfo.apiVersion, refInfo.plural]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (refInfo.kind !== 'Pod' && refInfo.kind !== 'Node') return;
    let alive = true;
    const load = () => call('metrics:get').then((m) => alive && setMetrics(m)).catch(() => undefined);
    void load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refInfo.kind]);

  useEffect(() => {
    if (!pendingSelect) return;
    const match = watch.items.find((o) => o.metadata.name === pendingSelect.name && (!refInfo.namespaced || !pendingSelect.namespace || o.metadata.namespace === pendingSelect.namespace));
    if (match) {
      setSelectedKey(objectKey(match));
      onPendingHandled();
    } else if (!watch.loading) {
      onPendingHandled();
    }
  }, [pendingSelect, watch.items, watch.loading, refInfo.namespaced, onPendingHandled]);

  const selected: KubeObject | undefined = selectedKey ? watch.items.find((o) => objectKey(o) === selectedKey) : undefined;
  const { setSelection } = useSelection();
  const selKind = selected?.kind;
  const selNs = selected?.metadata.namespace;
  const selName = selected?.metadata.name;
  useEffect(() => {
    setSelection(selName ? { kind: selKind!, namespace: selNs, name: selName } : null);
  }, [selKind, selNs, selName, setSelection]);
  useEffect(() => () => setSelection(null), [setSelection]);
  const ctx = useMemo(() => ({ now, metrics }), [now, metrics]);

  return (
    <div className={`resource-view ${selected ? 'with-details' : ''}`}>
      <div className="list-pane">
        <div className="view-header">
          <h1>{title}</h1>
          <span className="count">{watch.items.length}</span>
          <span className={`live-dot live-${watch.status}`} title={watch.error ?? watch.status}>
            {watch.status === 'live' ? 'Live' : watch.status === 'reconnecting' ? 'Reconnecting…' : watch.status === 'error' ? 'Error' : 'Loading…'}
          </span>
          <div className="spacer" />
          <input className="search" placeholder="Filter by name or label (app=web)…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter resources" />
          {canCreate && (
            <button className="btn btn-sm" onClick={() => setCreating(true)}>
              Create
            </button>
          )}
        </div>
        {watch.status === 'error' && <div className="inline-error">{watch.error}</div>}
        {watch.status === 'reconnecting' && <div className="inline-warn">Connection interrupted ({watch.error}). Retrying automatically…</div>}
        {watch.loading ? (
          <div className="empty">
            <span className="spinner" /> Loading {title.toLowerCase()}…
          </div>
        ) : (
          <ResourceTable
            items={watch.items}
            columns={visibleColumns}
            ctx={ctx}
            filter={filter}
            selectedKey={selectedKey}
            onSelect={(o) => setSelectedKey(objectKey(o))}
            emptyText={filter ? 'No resources match the filter.' : `No ${title.toLowerCase()} found${refInfo.namespaced && namespace ? ` in namespace ${namespace}` : ''}.`}
          />
        )}
      </div>
      {selected && (
        <DetailsPanel object={selected} refInfo={refInfo} discovery={discovery} settings={settings} dark={dark} onClose={() => setSelectedKey(null)} onNavigate={onNavigate} />
      )}
      {creating && <CreateResourceDialog refInfo={refInfo} namespace={namespace} dark={dark} onClose={() => setCreating(false)} />}
    </div>
  );
}
