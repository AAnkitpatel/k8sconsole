import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiResourceInfo, AppSettings, ClusterContext, ConnectionStatus, KubeconfigSource, ResourceRef } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { NAV_GROUPS, RESOURCE_CATALOG } from '../shared/resources';
import { call, errorMessage, on } from './lib/api';
import { DialogProvider, ToastProvider, useToast } from './components/Dialogs';
import type { NavigateTarget } from './components/DetailsPanel';
import { ClustersView } from './views/ClustersView';
import { OverviewView } from './views/OverviewView';
import { ResourceView } from './views/ResourceView';
import { CustomResourcesView } from './views/CustomResourcesView';
import { HelmView } from './views/HelmView';
import { PortForwardsView } from './views/PortForwardsView';
import { SettingsView } from './views/SettingsView';
import { MonitorView } from './views/MonitorView';
import { TerminalDock } from './components/TerminalDock';
import { AssistantPanel } from './components/AssistantPanel';
import { ClusterMapView } from './views/ClusterMapView';
import { EventTimelineView } from './views/EventTimelineView';
import { SecurityView } from './views/SecurityView';
import { AccessView } from './views/AccessView';
import { SelectionProvider, useSelection } from './lib/selection';
import { EcsProvider } from './ecs/state';
import { EcsContent, EcsSidebar, EcsTopbar, useEcsAssistantContext, useEcsDock } from './ecs/EcsWorkspace';
import type { EcsExecTarget } from './components/TerminalDock';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CommandBridge } from './lib/commandBridge';
import { GitOpsView } from './views/GitOpsView';
import { CostView } from './views/CostView';
import { ImagesView } from './views/ImagesView';
import { ExtensionsView } from './views/ExtensionsView';
import { useEcs } from './ecs/state';

type View =
  | { type: 'clusters' }
  | { type: 'overview' }
  | { type: 'monitor' }
  | { type: 'map' }
  | { type: 'timeline' }
  | { type: 'security' }
  | { type: 'access' }
  | { type: 'resource'; ref: ResourceRef; title: string }
  | { type: 'crds' }
  | { type: 'helm' }
  | { type: 'portforwards' }
  | { type: 'gitops' }
  | { type: 'cost' }
  | { type: 'images' }
  | { type: 'extensions' }
  | { type: 'settings' };

function useDarkMode(theme: AppSettings['theme']): boolean {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const dark = theme === 'system' ? systemDark : theme === 'dark';
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('light', !dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);
  return dark;
}

function Shell() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  return (
    <EcsProvider settings={settings} onSettings={setSettings}>
      <Workspace settings={settings} setSettings={setSettings} />
    </EcsProvider>
  );
}

function Workspace({ settings, setSettings }: { settings: AppSettings; setSettings: (s: AppSettings) => void }) {
  const [sources, setSources] = useState<KubeconfigSource[]>([]);
  const [contexts, setContexts] = useState<ClusterContext[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>({ contextId: null, state: 'disconnected', namespaces: [], canListNamespaces: false });
  const [discovery, setDiscovery] = useState<ApiResourceInfo[]>([]);
  const [view, setView] = useState<View>({ type: 'clusters' });
  const [namespace, setNamespace] = useState('');
  const [pendingSelect, setPendingSelect] = useState<{ namespace?: string; name: string } | null>(null);
  const [booted, setBooted] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [execRequest, setExecRequest] = useState<{ id: number; target: EcsExecTarget } | null>(null);
  const { selection } = useSelection();
  const ecsContext = useEcsAssistantContext();
  const ecsDock = useEcsDock();
  const ws = settings.workspace;
  const ecsView = useEcs().view;
  // Navigating to another view clears a rendering error shown by the boundary.
  const viewKey = `${ws}|${JSON.stringify(view)}|${ws === 'ecs' ? JSON.stringify(ecsView) : ''}`;
  const setWorkspace = (w: AppSettings['workspace']) => void call('settings:update', { workspace: w }).then(setSettings);
  const [typeRequest, setTypeRequest] = useState<{ id: number; text: string; title?: string; aws: boolean } | null>(null);
  const insertCommand = useCallback(
    (text: string, title?: string) => {
      setTypeRequest((r) => ({ id: (r?.id ?? 0) + 1, text, title, aws: settings.workspace === 'ecs' }));
      setTermOpen(true);
    },
    [settings.workspace],
  );
  // Alt+1…9 switches to a pinned cluster; a ref keeps the shortcut handler current.
  const hotbarRef = useRef<{ ids: string[]; connect?: (id: string) => void }>({ ids: [] });
  const togglePin = (id: string) => {
    const cur = settings.pinnedContexts;
    void call('settings:update', { pinnedContexts: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }).then(setSettings);
  };
  const openExec = useCallback((target: EcsExecTarget) => {
    setExecRequest((r) => ({ id: (r?.id ?? 0) + 1, target }));
    setTermOpen(true);
  }, []);
  const toast = useToast();
  const dark = useDarkMode(settings.theme);

  const refreshKubeconfigs = useCallback(async () => {
    try {
      const r = await call('kubeconfig:list');
      setSources(r.sources);
      setContexts(r.contexts);
      return r;
    } catch (err) {
      toast('error', errorMessage(err));
      return null;
    }
  }, [toast]);

  const connect = useCallback(
    async (id: string) => {
      setDiscovery([]);
      const s = await call('cluster:connect', id);
      setStatus(s);
      if (s.state === 'connected') {
        setDiscovery(await call('cluster:discovery'));
        const st = await call('settings:get');
        setSettings(st);
        const remembered = st.lastNamespaces[id];
        setNamespace(remembered !== undefined && (remembered === '' ? s.canListNamespaces : s.namespaces.includes(remembered)) ? remembered : s.canListNamespaces ? '' : s.namespaces[0] ?? 'default');
        setView({ type: 'overview' });
      } else {
        setView({ type: 'clusters' });
      }
    },
    [setSettings],
  );

  useEffect(() => {
    const offs = [
      on('connection:status', setStatus),
      on('kubeconfig:changed', () => void refreshKubeconfigs()),
    ];
    void (async () => {
      const st = await call('settings:get');
      setSettings(st);
      const r = await refreshKubeconfigs();
      setBooted(true);
      if (st.lastContextId && r?.contexts.some((c) => c.id === st.lastContextId)) void connect(st.lastContextId);
    })();
    return () => offs.forEach((o) => o());
  }, [refreshKubeconfigs, connect, setSettings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key) && hotbarRef.current.connect) {
        const id = hotbarRef.current.ids[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          hotbarRef.current.connect(id);
        }
        return;
      }
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setTermOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  hotbarRef.current = { ids: settings.pinnedContexts.filter((id) => contexts.some((c) => c.id === id)), connect: (id) => status.contextId !== id && void connect(id) };

  const changeNamespace = (ns: string) => {
    setNamespace(ns);
    if (status.contextId) void call('settings:update', { lastNamespaces: { ...settings.lastNamespaces, [status.contextId]: ns } }).then(setSettings);
  };

  const available = useMemo(() => {
    const set = new Set(discovery.map((d) => `${d.apiVersion}/${d.plural}`));
    return RESOURCE_CATALOG.filter((c) => set.has(`${c.apiVersion}/${c.plural}`) || discovery.length === 0);
  }, [discovery]);

  const navigate = useCallback(
    (t: NavigateTarget) => {
      const info = discovery.find((d) => d.kind === t.kind && (!t.apiVersion || d.apiVersion === t.apiVersion)) ?? discovery.find((d) => d.kind === t.kind);
      if (!info) {
        toast('error', `Cannot open ${t.kind}: it is not served by this cluster.`);
        return;
      }
      const cat = RESOURCE_CATALOG.find((c) => c.kind === info.kind && c.apiVersion === info.apiVersion);
      if (info.namespaced && namespace && t.namespace && t.namespace !== namespace) changeNamespace(t.namespace);
      setView({ type: 'resource', ref: { apiVersion: info.apiVersion, kind: info.kind, plural: info.plural, namespaced: info.namespaced }, title: cat?.title ?? info.kind });
      setPendingSelect({ namespace: t.namespace, name: t.name });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [discovery, namespace, toast],
  );

  // Stay mounted on a transient health-check failure: watches reconnect on their own.
  const connected = status.state === 'connected' || (status.state === 'error' && !!status.contextId && discovery.length > 0);
  const activeContext = contexts.find((c) => c.id === status.contextId);
  const isActive = (v: View) => JSON.stringify(v) === JSON.stringify(view);
  const navButton = (v: View, label: string, testId?: string) => (
    <button key={label} className={`nav-item ${isActive(v) ? 'active' : ''}`} onClick={() => setView(v)} disabled={!connected && v.type !== 'clusters' && v.type !== 'settings'} data-testid={testId}>
      {label}
    </button>
  );

  return (
    <CommandBridge.Provider value={{ insertCommand, context: activeContext?.name }}>
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src="./logo.svg" alt="" aria-hidden="true" />
          <div>
            <div className="brand-name">K8sConsole</div>
            <div className="brand-sub">Kubernetes &amp; ECS desktop</div>
          </div>
        </div>
        <div className="segmented workspace-switch" role="radiogroup" aria-label="Workspace">
          <button role="radio" aria-checked={ws === 'kubernetes'} className={ws === 'kubernetes' ? 'active' : ''} onClick={() => setWorkspace('kubernetes')} data-testid="ws-kubernetes">
            Kubernetes
          </button>
          <button role="radio" aria-checked={ws === 'ecs'} className={ws === 'ecs' ? 'active' : ''} onClick={() => setWorkspace('ecs')} data-testid="ws-ecs">
            Amazon ECS
          </button>
        </div>
        {ws === 'ecs' && <EcsSidebar settingsOpen={view.type === 'settings'} onNav={() => view.type === 'settings' && setView({ type: connected ? 'overview' : 'clusters' })} />}
        {ws === 'kubernetes' && (
        <>
        <div className="context-switcher">
          <select
            value={status.contextId ?? ''}
            onChange={(e) => e.target.value && void connect(e.target.value)}
            aria-label="Cluster context"
            data-testid="context-select"
          >
            <option value="">Select a cluster…</option>
            {contexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {settings.pinnedContexts.length > 0 && (
          <div className="hotbar" role="toolbar" aria-label="Pinned clusters" data-testid="hotbar">
            {settings.pinnedContexts
              .map((id) => contexts.find((c) => c.id === id))
              .filter((c): c is ClusterContext => !!c)
              .map((c, i) => (
                <button
                  key={c.id}
                  className={`hotbar-item ${status.contextId === c.id ? 'active' : ''}`}
                  onClick={() => status.contextId !== c.id && void connect(c.id)}
                  title={`${c.name}${i < 9 ? ` (Alt+${i + 1})` : ''}`}
                  data-testid="hotbar-item"
                >
                  <span className="hotbar-badge">{c.name.replace(/^(arn:aws:eks:[^:]+:\d+:cluster\/|gke_[^_]+_[^_]+_)/, '').slice(0, 2).toUpperCase()}</span>
                  <span className="hotbar-name">{c.name.replace(/^arn:aws:eks:[^:]+:\d+:cluster\//, '')}</span>
                </button>
              ))}
          </div>
        )}
        <nav className="nav">
          {navButton({ type: 'overview' }, 'Overview', 'nav-overview')}
          {navButton({ type: 'monitor' }, 'Monitor', 'nav-monitor')}
          {connected &&
            NAV_GROUPS.map((g) => {
              const items = available.filter((c) => c.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="nav-group">
                  <div className="nav-group-title">{g}</div>
                  {items.map((c) => navButton({ type: 'resource', ref: { apiVersion: c.apiVersion, kind: c.kind, plural: c.plural, namespaced: c.namespaced }, title: c.title }, c.title, `nav-${c.plural}`))}
                </div>
              );
            })}
          {connected && (
            <div className="nav-group">
              <div className="nav-group-title">Insights</div>
              {navButton({ type: 'map' }, 'Cluster Map', 'nav-map')}
              {navButton({ type: 'timeline' }, 'Event Timeline', 'nav-timeline')}
              {navButton({ type: 'security' }, 'Security Scan', 'nav-security')}
              {navButton({ type: 'access' }, 'Access', 'nav-access')}
            </div>
          )}
          {connected && (
            <div className="nav-group">
              <div className="nav-group-title">Extensions</div>
              {navButton({ type: 'crds' }, 'Custom Resources')}
              {navButton({ type: 'helm' }, 'Helm Releases')}
              {navButton({ type: 'portforwards' }, 'Port Forwards')}
            </div>
          )}
          {connected && (
            <div className="nav-group">
              <div className="nav-group-title">Platform</div>
              {navButton({ type: 'gitops' }, 'GitOps', 'nav-gitops')}
              {navButton({ type: 'cost' }, 'Cost', 'nav-cost')}
              {navButton({ type: 'images' }, 'Image Vulnerabilities', 'nav-images')}
              {navButton({ type: 'extensions' }, 'Extensions', 'nav-extensions')}
            </div>
          )}
        </nav>
        </>
        )}
        <div className="nav-footer">
          {ws === 'kubernetes' && navButton({ type: 'clusters' }, 'Clusters', 'nav-clusters')}
          {navButton({ type: 'settings' }, 'Settings', 'nav-settings')}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {ws === 'ecs' && view.type !== 'settings' ? (
            <EcsTopbar />
          ) : (
          <>
          <div className={`conn conn-${status.state}`} data-testid="connection-state">
            <span className="dot" />
            {status.state === 'connected' && `${activeContext?.name ?? ''} · ${status.serverVersion ?? ''}`}
            {status.state === 'connecting' && 'Connecting…'}
            {status.state === 'disconnected' && 'Not connected'}
            {status.state === 'error' && `Connection error`}
          </div>
          {status.state === 'error' && status.contextId && (
            <>
              <span className="conn-error" title={status.error}>
                {status.error}
              </span>
              <button className="btn btn-sm" onClick={() => void connect(status.contextId!)}>
                Retry
              </button>
            </>
          )}
          <div className="spacer" />
          {connected && (
            <label className="ns-select">
              <span>Namespace</span>
              <select value={namespace} onChange={(e) => changeNamespace(e.target.value)} aria-label="Namespace" data-testid="namespace-select">
                {status.canListNamespaces && <option value="">All namespaces</option>}
                {status.namespaces.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          </>
          )}
          <button className={`btn btn-sm ${assistantOpen ? 'btn-active' : ''}`} onClick={() => setAssistantOpen((o) => !o)} title="AI Assistant" data-testid="toggle-assistant">
            ✦ Assistant
          </button>
          <button className={`btn btn-sm ${termOpen ? 'btn-active' : ''}`} onClick={() => setTermOpen((o) => !o)} title="Toggle the integrated terminal (Ctrl+`)" data-testid="toggle-terminal">
            Terminal
          </button>
          {connected && ws === 'kubernetes' && (
            <button className="btn btn-sm" onClick={() => void call('cluster:disconnect').then(() => setView({ type: 'clusters' }))}>
              Disconnect
            </button>
          )}
        </header>
        <div className="workspace">
        <div className="content">
          <ErrorBoundary label="this view" resetKey={viewKey}>
          {!booted && <div className="empty">Loading…</div>}
          {booted && ws === 'ecs' && view.type !== 'settings' && <EcsContent settings={settings} dark={dark} onExec={openExec} onSettings={setSettings} />}
          {booted && ws === 'kubernetes' && (
          <>
          {booted && view.type === 'clusters' && <ClustersView sources={sources} contexts={contexts} status={status} onConnect={(id) => void connect(id)} onRefresh={() => void refreshKubeconfigs()} pinned={settings.pinnedContexts} onTogglePin={togglePin} />}
          {booted && view.type === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
          {connected && view.type === 'monitor' && <MonitorView key={status.contextId ?? ''} namespace={namespace} />}
          {connected && view.type === 'map' && <ClusterMapView key={status.contextId ?? ''} namespace={namespace} onNavigate={navigate} />}
          {connected && view.type === 'timeline' && <EventTimelineView key={status.contextId ?? ''} namespace={namespace} onNavigate={navigate} />}
          {connected && view.type === 'security' && <SecurityView key={status.contextId ?? ''} namespace={namespace} onNavigate={navigate} />}
          {connected && view.type === 'access' && <AccessView key={status.contextId ?? ''} namespace={namespace} />}
          {connected && view.type === 'overview' && <OverviewView status={status} context={activeContext} namespace={namespace} onNavigate={navigate} />}
          {connected && view.type === 'resource' && (
            <ResourceView
              key={`${status.contextId}|${view.ref.apiVersion}|${view.ref.plural}`}
              title={view.title}
              refInfo={view.ref}
              namespace={namespace}
              discovery={discovery}
              settings={settings}
              dark={dark}
              pendingSelect={pendingSelect}
              onPendingHandled={() => setPendingSelect(null)}
              onNavigate={navigate}
            />
          )}
          {connected && view.type === 'crds' && <CustomResourcesView namespace={namespace} discovery={discovery} settings={settings} dark={dark} onNavigate={navigate} />}
          {connected && view.type === 'helm' && <HelmView namespace={namespace} dark={dark} />}
          {connected && view.type === 'portforwards' && <PortForwardsView />}
          {connected && view.type === 'gitops' && <GitOpsView key={status.contextId ?? ''} namespace={namespace} onNavigate={navigate} />}
          {connected && view.type === 'cost' && <CostView key={status.contextId ?? ''} namespace={namespace} settings={settings} onSettings={setSettings} />}
          {connected && view.type === 'images' && <ImagesView key={status.contextId ?? ''} source="kubernetes" namespace={namespace} />}
          {connected && view.type === 'extensions' && <ExtensionsView key={status.contextId ?? ''} namespace={namespace} connected={connected} dark={dark} />}
          {!connected && booted && !['clusters', 'settings'].includes(view.type) && (
            <div className="empty">
              <p>Not connected.</p>
              <button className="btn btn-primary" onClick={() => setView({ type: 'clusters' })}>
                Choose a cluster
              </button>
            </div>
          )}
          </>
          )}
          {booted && ws === 'ecs' && view.type === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
          </ErrorBoundary>
        </div>
        <AssistantPanel
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          dark={dark}
          context={ws === 'ecs' ? ecsContext : [
            `cluster context: ${activeContext?.name ?? 'not connected'}${status.serverVersion ? ` (Kubernetes ${status.serverVersion})` : ''}`,
            `namespace: ${namespace || 'all namespaces'}`,
            `current view: ${view.type === 'resource' ? view.title : view.type}`,
            selection ? `selected: ${selection.kind} ${selection.namespace ? selection.namespace + '/' : ''}${selection.name}` : '',
          ]
            .filter(Boolean)
            .join('\n')}
        />
        </div>
        <TerminalDock open={termOpen} onClose={() => setTermOpen(false)} connected={connected} namespace={namespace} dark={dark} contextName={activeContext?.name} aws={ecsDock} execRequest={execRequest} typeRequest={typeRequest} />
      </main>
    </div>
    </CommandBridge.Provider>
  );
}

export function App() {
  return (
    <ErrorBoundary label="K8sConsole">
      <ToastProvider>
        <DialogProvider>
          <SelectionProvider>
            <Shell />
          </SelectionProvider>
        </DialogProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
