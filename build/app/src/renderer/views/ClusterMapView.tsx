import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ResourceGraph } from '../../shared/graph';
import type { KubeObject } from '../../shared/types';
import { summarizeNode, summarizePod } from '../../shared/format';
import { call, errorMessage } from '../lib/api';
import { useWatch } from '../lib/useWatch';
import { GraphView } from '../components/GraphView';
import type { NavigateTarget } from '../components/DetailsPanel';

const POD = { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
const NODE = { apiVersion: 'v1', kind: 'Node', plural: 'nodes', namespaced: false };

/** Groups pods by node for the node map; unscheduled pods get their own bucket. */
export function podsByNode(nodes: KubeObject[], pods: KubeObject[]): Array<{ node: KubeObject | null; name: string; pods: KubeObject[] }> {
  const map = new Map<string, KubeObject[]>();
  for (const p of pods) {
    const n = p.spec?.nodeName ?? '';
    (map.get(n) ?? map.set(n, []).get(n)!).push(p);
  }
  const out: Array<{ node: KubeObject | null; name: string; pods: KubeObject[] }> = nodes.map((n) => ({ node: n, name: n.metadata.name, pods: (map.get(n.metadata.name) ?? []).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)) }));
  if (map.get('')?.length) out.push({ node: null, name: 'Unscheduled', pods: map.get('')! });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function NodeMap({ namespace, onNavigate }: { namespace: string; onNavigate: (t: NavigateTarget) => void }) {
  const pods = useWatch(useMemo(() => ({ resource: POD, namespace: namespace || undefined }), [namespace]));
  const nodes = useWatch(useMemo(() => ({ resource: NODE }), []));
  const groups = useMemo(() => podsByNode(nodes.items, pods.items), [nodes.items, pods.items]);
  if (pods.loading || nodes.loading) return <div className="empty">Loading…</div>;
  return (
    <div className="nodemap">
      {groups.map((g) => {
        const s = g.node ? summarizeNode(g.node) : null;
        const bad = g.pods.filter((p) => summarizePod(p).severity === 'error').length;
        return (
          <section key={g.name} className={`nodemap-node ${s && s.severity !== 'ok' ? 'sev-' + s.severity : ''}`} data-testid="nodemap-node">
            <header>
              {g.node ? (
                <button className="link" onClick={() => onNavigate({ kind: 'Node', name: g.name })}>
                  {g.name}
                </button>
              ) : (
                <b>{g.name}</b>
              )}
              {s && <span className={`badge badge-${s.severity}`}>{s.status}</span>}
              <span className="muted">
                {g.pods.length} pods{bad ? ` · ${bad} failing` : ''}
              </span>
            </header>
            <div className="nodemap-pods">
              {g.pods.map((p) => {
                const ps = summarizePod(p);
                return (
                  <button
                    key={p.metadata.uid}
                    className={`pod-tile sev-${ps.severity}`}
                    title={`${p.metadata.namespace}/${p.metadata.name}\n${ps.status} · ready ${ps.ready} · restarts ${ps.restarts}`}
                    onClick={() => onNavigate({ kind: 'Pod', namespace: p.metadata.namespace, name: p.metadata.name })}
                    aria-label={`Pod ${p.metadata.name}: ${ps.status}`}
                  >
                    <span className="pod-tile-name">{p.metadata.name}</span>
                    <span className="pod-tile-status">{ps.status}</span>
                  </button>
                );
              })}
              {g.pods.length === 0 && <span className="muted">No pods{namespace ? ` from ${namespace}` : ''}.</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function ClusterMapView({ namespace, onNavigate }: { namespace: string; onNavigate: (t: NavigateTarget) => void }) {
  const [mode, setMode] = useState<'namespace' | 'nodes'>(namespace ? 'namespace' : 'nodes');
  const [graph, setGraph] = useState<(ResourceGraph & { notes: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!namespace) return;
    setLoading(true);
    call('graph:namespace', namespace)
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [namespace]);

  useEffect(() => {
    if (mode !== 'namespace') return;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [mode, load]);

  return (
    <div className="map-view">
      <div className="view-header">
        <h1>Cluster Map</h1>
        <div className="segmented" role="radiogroup" aria-label="Map mode">
          <button role="radio" aria-checked={mode === 'namespace'} className={mode === 'namespace' ? 'active' : ''} onClick={() => setMode('namespace')}>
            Namespace map
          </button>
          <button role="radio" aria-checked={mode === 'nodes'} className={mode === 'nodes' ? 'active' : ''} onClick={() => setMode('nodes')} data-testid="map-mode-nodes">
            Node map
          </button>
        </div>
        <span className="muted">{mode === 'namespace' ? 'Traffic → services → workloads → pods → config and storage. Click any object to open it.' : 'Every pod placed on its node, coloured by health.'}</span>
        <div className="spacer" />
        {mode === 'namespace' && (
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            Refresh
          </button>
        )}
      </div>
      {error && <div className="inline-error mon-pad">{error}</div>}
      {graph?.notes.length ? <div className="inline-warn mon-pad">Partial view: {graph.notes.join(' · ')}</div> : null}
      <div className="map-body">
        {mode === 'nodes' && <NodeMap namespace={namespace} onNavigate={onNavigate} />}
        {mode === 'namespace' &&
          (!namespace ? (
            <div className="empty">Select a namespace in the top bar to draw its map.</div>
          ) : graph ? (
            <GraphView graph={graph} onOpen={(n) => onNavigate({ kind: n.kind, apiVersion: n.apiVersion, namespace: n.namespace, name: n.name })} emptyText={`Namespace ${namespace} has no objects to map.`} />
          ) : (
            <div className="empty">
              <span className="spinner" /> Building map…
            </div>
          ))}
      </div>
    </div>
  );
}
