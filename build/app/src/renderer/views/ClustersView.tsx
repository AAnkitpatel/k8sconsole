import { useState } from 'react';
import type { ClusterContext, ConnectionStatus, KubeconfigSource } from '../../shared/types';
import { call, errorMessage } from '../lib/api';
import { Modal, useToast, useDialogs } from '../components/Dialogs';

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [name, setName] = useState('');
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const submit = async () => {
    try {
      const r = await call('kubeconfig:importYaml', yaml, name || 'imported');
      toast('success', `Imported ${r.contexts} context(s)`);
      onImported();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal
      title="Add kubeconfig from YAML"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!yaml.trim()} onClick={() => void submit()}>
            Add
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. staging" />
      </label>
      <label className="field">
        <span>Kubeconfig YAML</span>
        <textarea className="mono" rows={16} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} aria-label="Kubeconfig YAML" />
      </label>
      <p className="muted">The file is stored in the application data folder with owner-only permissions (0600).</p>
      {error && <div className="inline-error">{error}</div>}
    </Modal>
  );
}

export function ClustersView({
  sources,
  contexts,
  status,
  onConnect,
  onRefresh,
  pinned = [],
  onTogglePin,
}: {
  sources: KubeconfigSource[];
  contexts: ClusterContext[];
  status: ConnectionStatus;
  onConnect: (id: string) => void;
  onRefresh: () => void;
  /** Hotbar: pinned context ids. */
  pinned?: string[];
  onTogglePin?: (id: string) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState('');
  const toast = useToast();
  const { confirm } = useDialogs();

  const add = async (method: 'kubeconfig:addFile' | 'kubeconfig:addFolder') => {
    try {
      const r = await call(method);
      if (r.added) {
        toast('success', `Added ${r.added}`);
        onRefresh();
      }
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const remove = async (path: string) => {
    if (await confirm({ title: 'Remove source', message: `Stop loading ${path}? The file itself is not deleted.`, confirmLabel: 'Remove' })) {
      await call('kubeconfig:removeSource', path);
      onRefresh();
    }
  };

  const f = filter.toLowerCase();
  return (
    <div className="clusters-view">
      <div className="view-header">
        <h1>Clusters</h1>
        <span className="count">{contexts.length}</span>
        <div className="spacer" />
        <input className="search" placeholder="Filter contexts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm" onClick={() => void add('kubeconfig:addFile')}>
          Add file
        </button>
        <button className="btn btn-sm" onClick={() => void add('kubeconfig:addFolder')}>
          Add folder
        </button>
        <button className="btn btn-sm" onClick={() => setImporting(true)}>
          Paste YAML
        </button>
        <button className="btn btn-sm" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <p className="muted intro">
        Kubeconfig files are read from <code>~/.kube/config</code>, <code>$KUBECONFIG</code>, and any files or folders you add. Changes on disk are picked up automatically. Nothing is installed in your clusters.
      </p>
      {sources.length === 0 && (
        <div className="empty">
          <h2>No kubeconfig found</h2>
          <p>Add a kubeconfig file or folder, or paste kubeconfig YAML to get started.</p>
        </div>
      )}
      {sources.map((s) => {
        const ctxs = contexts.filter((c) => c.sourcePath === s.path && (!f || c.name.toLowerCase().includes(f) || (c.server ?? '').toLowerCase().includes(f)));
        return (
          <section key={s.path} className="panel source">
            <div className="source-header">
              <span className="mono">{s.path}</span>
              <span className="tag">{s.origin}</span>
              <div className="spacer" />
              {(s.origin === 'user-file' || s.origin === 'user-folder') && (
                <button className="btn btn-sm" onClick={() => void remove(s.origin === 'user-file' ? s.path : s.path.replace(/\/[^/]+$/, ''))}>
                  Remove
                </button>
              )}
            </div>
            {s.error && <div className="inline-error">{s.error}</div>}
            <div className="context-grid">
              {ctxs.map((c) => {
                const active = status.contextId === c.id;
                return (
                  <div key={c.id} className={`context-card ${active ? 'active' : ''}`}>
                    <div className="context-name" title={c.name}>
                      {c.name}
                      {c.isCurrentInFile && <span className="tag">current</span>}
                    </div>
                    <div className="context-meta mono">{c.server}</div>
                    <div className="context-meta">
                      user {c.user} · {c.authMethod}
                      {c.namespace ? ` · ns ${c.namespace}` : ''}
                    </div>
                    {c.insecureSkipTlsVerify && <span className="badge badge-warn">TLS verification disabled</span>}
                    <div className="context-actions">
                      {onTogglePin && (
                        <button className={`btn btn-sm ${pinned.includes(c.id) ? 'btn-active' : ''}`} onClick={() => onTogglePin(c.id)} title={pinned.includes(c.id) ? 'Remove from the hotbar' : 'Pin to the hotbar for one-click switching'} data-testid="pin-button">
                          {pinned.includes(c.id) ? '★ Pinned' : '☆ Pin'}
                        </button>
                      )}
                      {active && status.state === 'connected' ? (
                        <span className="badge badge-ok">Connected</span>
                      ) : active && status.state === 'connecting' ? (
                        <span className="badge badge-pending">Connecting…</span>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => onConnect(c.id)} data-testid="connect-button">
                          Connect
                        </button>
                      )}
                    </div>
                    {active && status.state === 'error' && <div className="inline-error">{status.error}</div>}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={onRefresh} />}
    </div>
  );
}
