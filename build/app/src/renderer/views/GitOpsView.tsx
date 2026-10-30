import { useState } from 'react';
import { gitopsSummary, type GitOpsAction, type GitOpsItem } from '../../shared/gitops';
import { call, errorMessage } from '../lib/api';
import { useDialogs, useToast } from '../components/Dialogs';
import type { NavigateTarget } from '../components/DetailsPanel';
import { DataTable, LoadState, useLoad, type Col } from '../ecs/common';
import { StatusBadge, ago } from '../ecs/state';

const ACTION_LABEL: Record<GitOpsAction, string> = { reconcile: 'Reconcile', suspend: 'Suspend', resume: 'Resume', refresh: 'Refresh', 'hard-refresh': 'Hard refresh', sync: 'Sync' };

export function GitOpsView({ namespace, onNavigate }: { namespace: string; onNavigate: (t: NavigateTarget) => void }) {
  const data = useLoad(() => call('gitops:list', namespace || undefined), [namespace], 15000);
  const [filter, setFilter] = useState('');
  const [engine, setEngine] = useState<'all' | 'flux' | 'argocd'>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const { confirm } = useDialogs();
  const toast = useToast();

  const act = async (i: GitOpsItem, action: GitOpsAction) => {
    const what = `${i.kind} ${i.namespace}/${i.name}`;
    const message: Record<GitOpsAction, string> = {
      reconcile: `Ask Flux to reconcile ${what} now?`,
      suspend: `Suspend ${what}? Flux stops applying changes from its source until it is resumed.`,
      resume: `Resume ${what} and reconcile it now?`,
      refresh: `Ask Argo CD to compare ${what} with Git again?`,
      'hard-refresh': `Hard-refresh ${what}? Argo CD invalidates its manifest cache and regenerates manifests.`,
      sync: `Sync ${what}? Argo CD applies the desired state from Git to the cluster now.`,
    };
    if (!(await confirm({ title: ACTION_LABEL[action], message: message[action], confirmLabel: ACTION_LABEL[action], danger: action === 'suspend' || action === 'sync' }))) return;
    try {
      await call('gitops:action', i.ref, i.namespace, i.name, action);
      toast('success', `${ACTION_LABEL[action]}: ${i.name}`);
      void data.reload();
    } catch (err) {
      toast('error', `${ACTION_LABEL[action]} failed: ${errorMessage(err)}`);
    }
  };

  const items = (data.data?.items ?? []).filter((i) => (engine === 'all' || i.engine === engine) && (!problemsOnly || i.status === 'error' || i.status === 'warn'));
  const sum = gitopsSummary(data.data?.items ?? []);
  const cols: Col<GitOpsItem>[] = [
    { key: 'name', title: 'Name', render: (i) => <span className="cell-name">{i.name}</span>, sort: (i) => i.name },
    { key: 'kind', title: 'Kind', render: (i) => <span className="kind-tag">{i.engine === 'flux' ? 'Flux' : 'Argo'} {i.kind}</span>, sort: (i) => i.kind },
    { key: 'ns', title: 'Namespace', render: (i) => i.namespace, sort: (i) => i.namespace },
    { key: 'state', title: 'State', render: (i) => <StatusBadge status={i.status} label={i.state} />, sort: (i) => ['error', 'warn', 'pending', 'done', 'ok'].indexOf(i.status) },
    { key: 'source', title: 'Source', render: (i) => <span className="mono truncate gitops-source" title={i.source}>{i.source ?? ''}</span> },
    { key: 'rev', title: 'Revision', render: (i) => <span className="mono truncate gitops-rev" title={i.revision}>{i.revision ?? ''}</span> },
    { key: 'dest', title: 'Destination', render: (i) => <span className="truncate gitops-dest" title={i.destination}>{i.destination ?? ''}</span> },
    { key: 'changed', title: 'Changed', render: (i) => (i.lastChange ? `${ago(Date.parse(i.lastChange))} ago` : ''), sort: (i) => -(Date.parse(i.lastChange ?? '') || 0) },
    {
      key: 'actions',
      title: '',
      render: (i) => (
        <span className="gitops-actions" onClick={(e) => e.stopPropagation()}>
          {i.actions.map((a) => (
            <button key={a} className="btn btn-sm" onClick={() => void act(i, a)} data-testid={`gitops-${a}`}>
              {ACTION_LABEL[a]}
            </button>
          ))}
        </span>
      ),
    },
  ];

  return (
    <div className="resource-view platform-view" data-testid="gitops-view">
      <div className="list-pane">
        <div className="view-header">
          <h1>GitOps</h1>
          <span className="count">{items.length}</span>
          <span className="muted">Flux and Argo CD{namespace ? ` · namespace ${namespace}` : ' · all namespaces'}</span>
          <div className="spacer" />
          <div className="segmented" role="radiogroup" aria-label="Engine">
            {(['all', 'argocd', 'flux'] as const).map((e) => (
              <button key={e} role="radio" aria-checked={engine === e} className={engine === e ? 'active' : ''} onClick={() => setEngine(e)}>
                {e === 'all' ? 'All' : e === 'flux' ? 'Flux' : 'Argo CD'}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> Problems only
          </label>
          <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter GitOps objects" />
          <button className="btn btn-sm" onClick={() => void data.reload()}>
            Refresh
          </button>
        </div>
        {data.data && (
          <div className="cards platform-cards">
            <div className="card">
              <div className="card-title">Objects</div>
              <div className="card-value">{sum.total}</div>
              <div className="card-sub">{sum.engines.map((e) => (e === 'flux' ? 'Flux' : 'Argo CD')).join(' · ') || 'no GitOps controllers found'}</div>
            </div>
            <div className="card card-ok">
              <div className="card-title">Healthy</div>
              <div className="card-value">{sum.ok}</div>
            </div>
            <div className={`card ${sum.warn ? 'card-warn' : ''}`}>
              <div className="card-title">Out of sync / progressing</div>
              <div className="card-value">{sum.warn + sum.pending}</div>
            </div>
            <div className={`card ${sum.error ? 'card-error' : ''}`}>
              <div className="card-title">Failing</div>
              <div className="card-value">{sum.error}</div>
            </div>
            <div className="card">
              <div className="card-title">Suspended (Flux)</div>
              <div className="card-value">{sum.suspended}</div>
            </div>
          </div>
        )}
        <LoadState loading={data.loading && !data.data} error={data.error} what="GitOps objects" />
        {data.data?.notes.map((n) => (
          <div key={n} className="inline-warn">
            {n}
          </div>
        ))}
        {data.data && data.data.engines.length === 0 ? (
          <div className="empty" data-testid="gitops-empty">
            <p>No Flux or Argo CD custom resources are served by this cluster.</p>
            <p className="muted">Install Flux (fluxcd.io) or Argo CD (argo-cd.readthedocs.io) and their objects appear here, with sync state and actions.</p>
          </div>
        ) : (
          data.data && (
            <DataTable
              rows={items}
              cols={cols}
              rowKey={(i) => `${i.ref.apiVersion}/${i.kind}/${i.namespace}/${i.name}`}
              onSelect={(i) => onNavigate({ kind: i.kind, apiVersion: i.ref.apiVersion, namespace: i.namespace, name: i.name })}
              filter={filter}
              match={(i, f) => [i.name, i.namespace, i.kind, i.source ?? '', i.state].some((x) => x.toLowerCase().includes(f))}
              empty="Nothing matches."
              initialSort={{ key: 'state', dir: 1 }}
              testId="gitops-row"
            />
          )
        )}
        {items.some((i) => i.message && (i.status === 'error' || i.status === 'warn')) && (
          <div className="mon-pad">
            <h3 className="sub-h">Messages</h3>
            <ul className="plain-list ecs-events">
              {items
                .filter((i) => i.message && (i.status === 'error' || i.status === 'warn'))
                .map((i) => (
                  <li key={`${i.kind}/${i.namespace}/${i.name}`} className={i.status === 'error' ? 'ecs-event-warn' : ''}>
                    <b>{i.name}</b> <span className="muted">{i.kind}</span> {i.message}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
