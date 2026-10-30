import { arnName } from '../../shared/ecs';
import type { AppSettings } from '../../shared/types';
import { useEcs, type EcsView } from './state';
import { EcsConnectView } from './ConnectView';
import { EcsServicesView } from './ServicesView';
import { EcsTasksView, type ExecTarget } from './TasksView';
import { EcsTaskDefsView } from './TaskDefsView';
import { EcsEventsView, EcsMapView, EcsMonitorView, EcsOverviewView, EcsSecurityView } from './InsightsViews';
import { EcsCostView } from '../views/CostView';
import { ImagesView } from '../views/ImagesView';

/** `onNav` lets the shell leave its own Settings page when an ECS item is chosen. */
export function EcsSidebar({ onNav, settingsOpen }: { onNav: () => void; settingsOpen: boolean }) {
  const { connected, clusters, cluster, setCluster, view, setView } = useEcs();
  const item = (v: EcsView, label: string, testId: string) => (
    <button
      key={label}
      className={`nav-item ${!settingsOpen && view.type === v.type ? 'active' : ''}`}
      onClick={() => {
        onNav();
        setView(v);
      }}
      disabled={!connected}
      data-testid={testId}
    >
      {label}
    </button>
  );
  return (
    <>
      <div className="context-switcher">
        <select value={cluster} onChange={(e) => setCluster(e.target.value)} aria-label="ECS cluster" data-testid="ecs-cluster-select" disabled={!connected}>
          {!connected && <option value="">Connect to AWS first</option>}
          {connected && clusters.length === 0 && <option value="">No clusters</option>}
          {clusters.map((c) => (
            <option key={c.arn} value={c.arn}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <nav className="nav">
        {item({ type: 'overview' }, 'Overview', 'ecs-nav-overview')}
        {item({ type: 'monitor' }, 'Monitor', 'ecs-nav-monitor')}
        {connected && (
          <>
            <div className="nav-group">
              <div className="nav-group-title">Workloads</div>
              {item({ type: 'services' }, 'Services', 'ecs-nav-services')}
              {item({ type: 'tasks' }, 'Tasks', 'ecs-nav-tasks')}
              {item({ type: 'taskdefs' }, 'Task Definitions', 'ecs-nav-taskdefs')}
            </div>
            <div className="nav-group">
              <div className="nav-group-title">Insights</div>
              {item({ type: 'map' }, 'Service Map', 'ecs-nav-map')}
              {item({ type: 'events' }, 'Events', 'ecs-nav-events')}
              {item({ type: 'security' }, 'Security Scan', 'ecs-nav-security')}
              {item({ type: 'images' }, 'Image Vulnerabilities', 'ecs-nav-images')}
              {item({ type: 'cost' }, 'Cost', 'ecs-nav-cost')}
            </div>
          </>
        )}
      </nav>
    </>
  );
}

export function EcsTopbar() {
  const { status, label, readOnly, disconnect, setView } = useEcs();
  return (
    <>
      <div className={`conn conn-${status.state}`} data-testid="aws-connection-state">
        <span className="dot" />
        {status.state === 'connected' && `AWS ${label}${status.account ? ` · ${status.account}` : ''}`}
        {status.state === 'connecting' && 'Connecting to AWS…'}
        {status.state === 'disconnected' && 'AWS not connected'}
        {status.state === 'error' && 'AWS connection error'}
      </div>
      {status.state === 'connected' && (
        <span className={`tag ${readOnly ? '' : 'tag-write'}`} title={readOnly ? 'Changes are blocked in the app' : 'Changes are allowed (within your IAM permissions)'} data-testid="aws-mode">
          {readOnly ? 'read-only' : 'read-write'}
        </span>
      )}
      {status.state === 'error' && <span className="conn-error">{status.error}</span>}
      <div className="spacer" />
      {status.state === 'connected' && (
        <button className="btn btn-sm" onClick={() => void disconnect()} data-testid="aws-disconnect">
          Disconnect
        </button>
      )}
      {status.state === 'error' && (
        <button className="btn btn-sm" onClick={() => setView({ type: 'connect' })}>
          Change connection
        </button>
      )}
    </>
  );
}

export function EcsContent({ settings, dark, onExec, onSettings }: { settings: AppSettings; dark: boolean; onExec: (t: ExecTarget) => void; onSettings: (s: AppSettings) => void }) {
  const { view, cluster } = useEcs();
  switch (view.type) {
    case 'connect':
      return <EcsConnectView settings={settings} />;
    case 'overview':
      return <EcsOverviewView />;
    case 'services':
      return <EcsServicesView settings={settings} dark={dark} select={view.select} onExec={onExec} />;
    case 'tasks':
      return <EcsTasksView dark={dark} service={view.service} select={view.select} onExec={onExec} />;
    case 'taskdefs':
      return <EcsTaskDefsView dark={dark} family={view.family} />;
    case 'monitor':
      return <EcsMonitorView />;
    case 'map':
      return <EcsMapView />;
    case 'events':
      return <EcsEventsView />;
    case 'security':
      return <EcsSecurityView />;
    case 'cost':
      return <EcsCostView key={cluster} cluster={cluster} settings={settings} onSettings={onSettings} />;
    case 'images':
      return <ImagesView key={cluster} source="ecs" cluster={cluster} />;
  }
}

/** Context lines for the AI assistant while the ECS workspace is shown. */
export function useEcsAssistantContext(): string {
  const { status, clusterInfo, view, label } = useEcs();
  if (status.state !== 'connected') return 'Amazon ECS workspace: not connected to AWS';
  return [`Amazon ECS: AWS ${label} (account ${status.account})`, clusterInfo ? `ECS cluster: ${clusterInfo.name}` : '', `current ECS view: ${view.type}`, view.type === 'services' && view.select ? `selected ECS service: ${view.select}` : '', view.type === 'tasks' && view.select ? `selected ECS task: ${arnName(view.select)}` : '']
    .filter(Boolean)
    .join('\n');
}

export function useEcsDock(): { label: string; cluster?: string; clusterName?: string } | undefined {
  const { connected, label, cluster, clusterInfo } = useEcs();
  return connected ? { label, cluster: cluster || undefined, clusterName: clusterInfo?.name } : undefined;
}
