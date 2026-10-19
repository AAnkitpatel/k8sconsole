import { useMemo, useState } from 'react';
import type { ApiResourceInfo, AppSettings, KubeObject, ResourceRef } from '../../shared/types';
import { useWatch } from '../lib/useWatch';
import { ResourceView } from './ResourceView';
import type { NavigateTarget } from '../components/DetailsPanel';
import { crdToRef } from '../lib/crd';

const CRD_REF: ResourceRef = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', plural: 'customresourcedefinitions', namespaced: false };

export function CustomResourcesView(props: { namespace: string; discovery: ApiResourceInfo[]; settings: AppSettings; dark: boolean; onNavigate: (t: NavigateTarget) => void }) {
  const crds = useWatch(useMemo(() => ({ resource: CRD_REF }), []));
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, KubeObject[]>();
    for (const c of crds.items) {
      if (filter && !`${c.spec?.names?.kind} ${c.spec?.group}`.toLowerCase().includes(filter.toLowerCase())) continue;
      const g = c.spec?.group ?? '';
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [crds.items, filter]);
  const crd = crds.items.find((c) => c.metadata.name === selected);
  const ref = useMemo(() => (crd ? crdToRef(crd) : null), [crd]);

  return (
    <div className="crd-view">
      <div className="crd-list">
        <div className="view-header">
          <h1>Custom Resources</h1>
          <span className="count">{crds.items.length}</span>
        </div>
        <input className="search full" placeholder="Filter CRDs…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {crds.loading && <div className="empty">Loading…</div>}
        {crds.status === 'error' && <div className="inline-error">{crds.error}</div>}
        {!crds.loading && crds.items.length === 0 && <div className="empty">No custom resource definitions are installed.</div>}
        {groups.map(([g, list]) => (
          <div key={g} className="crd-group">
            <div className="crd-group-title">{g}</div>
            {list
              .sort((a, b) => a.spec.names.kind.localeCompare(b.spec.names.kind))
              .map((c) => (
                <button key={c.metadata.name} className={`crd-item ${selected === c.metadata.name ? 'active' : ''}`} onClick={() => setSelected(c.metadata.name)}>
                  {c.spec.names.kind}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="crd-content">
        {ref ? (
          <ResourceView
            key={crd!.metadata.name}
            title={crd!.spec.names.kind}
            refInfo={ref}
            namespace={props.namespace}
            discovery={props.discovery}
            settings={props.settings}
            dark={props.dark}
            pendingSelect={null}
            onPendingHandled={() => undefined}
            onNavigate={props.onNavigate}
          />
        ) : (
          <div className="empty">Select a custom resource type to list its objects.</div>
        )}
      </div>
    </div>
  );
}
