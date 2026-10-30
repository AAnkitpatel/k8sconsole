import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AwsConnectRequest, AwsConnectionStatus, EcsCluster } from '../../shared/ecs';
import { arnName } from '../../shared/ecs';
import type { AppSettings } from '../../shared/types';
import { call, errorMessage, on } from '../lib/api';
import { useToast } from '../components/Dialogs';

export type EcsView =
  | { type: 'connect' }
  | { type: 'overview' }
  | { type: 'services'; select?: string }
  | { type: 'tasks'; service?: string; select?: string }
  | { type: 'taskdefs'; family?: string }
  | { type: 'monitor' }
  | { type: 'map' }
  | { type: 'events' }
  | { type: 'security' }
  | { type: 'cost' }
  | { type: 'images' };

interface EcsState {
  status: AwsConnectionStatus;
  connected: boolean;
  readOnly: boolean;
  clusters: EcsCluster[];
  cluster: string;
  clusterInfo?: EcsCluster;
  setCluster: (arn: string) => void;
  refreshClusters: () => Promise<void>;
  view: EcsView;
  setView: (v: EcsView) => void;
  connect: (req: AwsConnectRequest) => Promise<AwsConnectionStatus>;
  disconnect: () => Promise<void>;
  /** e.g. `super · eu-west-2` */
  label: string;
}

const Ctx = createContext<EcsState | null>(null);

export const connectionKey = (r?: AwsConnectRequest) => (r ? `${r.mode === 'profile' ? r.profile : 'default'}|${r.region}${r.assumeRoleArn ? `|${r.assumeRoleArn}` : ''}` : '');

export function EcsProvider({ children, settings, onSettings }: { children: ReactNode; settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const [status, setStatus] = useState<AwsConnectionStatus>({ state: 'disconnected' });
  const [clusters, setClusters] = useState<EcsCluster[]>([]);
  const [cluster, setClusterState] = useState('');
  const [view, setView] = useState<EcsView>({ type: 'connect' });
  const toast = useToast();

  useEffect(() => {
    void call('aws:status').then(setStatus);
    return on('aws:status', setStatus);
  }, []);

  const connected = status.state === 'connected';

  const refreshClusters = useCallback(async () => {
    try {
      const list = await call('ecs:clusters');
      setClusters(list);
      setClusterState((cur) => {
        if (cur && list.some((c) => c.arn === cur)) return cur;
        const remembered = settings.ecsLastCluster[connectionKey(status.request)];
        const pick = list.find((c) => c.arn === remembered) ?? [...list].sort((a, b) => b.activeServices - a.activeServices)[0];
        return pick?.arn ?? '';
      });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }, [settings.ecsLastCluster, status.request, toast]);

  useEffect(() => {
    if (connected) void refreshClusters();
    else setClusters([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, status.request?.region, status.request?.profile]);

  const setCluster = useCallback(
    (arn: string) => {
      setClusterState(arn);
      const key = connectionKey(status.request);
      if (key && arn) void call('settings:update', { ecsLastCluster: { ...settings.ecsLastCluster, [key]: arn } }).then(onSettings);
    },
    [settings.ecsLastCluster, status.request, onSettings],
  );

  const connect = useCallback(async (req: AwsConnectRequest) => {
    const s = await call('aws:connect', req);
    setStatus(s);
    if (s.state === 'connected') setView({ type: 'overview' });
    return s;
  }, []);

  const disconnect = useCallback(async () => {
    await call('aws:disconnect');
    setView({ type: 'connect' });
  }, []);

  const value = useMemo<EcsState>(() => {
    const r = status.request;
    return {
      status,
      connected,
      readOnly: r?.readOnly !== false,
      clusters,
      cluster,
      clusterInfo: clusters.find((c) => c.arn === cluster),
      setCluster,
      refreshClusters,
      view: connected ? view : { type: 'connect' },
      setView,
      connect,
      disconnect,
      label: r ? `${r.mode === 'profile' ? r.profile : 'default credentials'}${r.assumeRoleArn ? ` → ${arnName(r.assumeRoleArn)}` : ''} · ${r.region}` : '',
    };
  }, [status, connected, clusters, cluster, setCluster, refreshClusters, view, connect, disconnect]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEcs(): EcsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEcs outside EcsProvider');
  return v;
}

// ---- Small shared helpers for the ECS views ----

export const ago = (t?: number): string => {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

export const when = (t?: number): string => (t ? new Date(t).toLocaleString() : '');

/** Service events that indicate a problem (ECS has no event severity, so the message decides). */
export const isWarningEvent = (message: string): boolean => /unable|fail|unhealthy|error|insufficient|could not|cannot|stopped|throttl|denied|timed out|circuit breaker|rolling back/i.test(message);

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const cls = status === 'ok' ? 'badge-ok' : status === 'error' ? 'badge-error' : status === 'warn' ? 'badge-warn' : status === 'pending' ? 'badge-pending' : 'badge-done';
  return <span className={`badge ${cls}`}>{label ?? status}</span>;
}
