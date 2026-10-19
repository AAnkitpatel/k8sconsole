import type { ReactNode } from 'react';
import { formatAge, formatBytes, formatCpu, summarizeNode, summarizePod, summarizeWorkload } from '../../shared/format';
import type { KubeObject, MetricsSnapshot } from '../../shared/types';

export interface Column {
  key: string;
  title: string;
  render: (o: KubeObject, ctx: ColumnContext) => ReactNode;
  sortValue?: (o: KubeObject, ctx: ColumnContext) => string | number;
  width?: string;
}

export interface ColumnContext {
  now: number;
  metrics: MetricsSnapshot | null;
}

const Badge = ({ text, severity }: { text: string; severity: string }) => <span className={`badge badge-${severity}`}>{text}</span>;

const name: Column = { key: 'name', title: 'Name', render: (o) => <span className="cell-name">{o.metadata.name}</span>, sortValue: (o) => o.metadata.name };
const namespace: Column = { key: 'namespace', title: 'Namespace', render: (o) => o.metadata.namespace ?? '', sortValue: (o) => o.metadata.namespace ?? '' };
const age: Column = {
  key: 'age',
  title: 'Age',
  render: (o, c) => formatAge(o.metadata.creationTimestamp, c.now),
  sortValue: (o) => -(Date.parse(o.metadata.creationTimestamp ?? '') || 0),
  width: '70px',
};

const text = (key: string, title: string, get: (o: KubeObject) => string | number | undefined, width?: string): Column => ({
  key,
  title,
  render: (o) => String(get(o) ?? ''),
  sortValue: (o) => get(o) ?? '',
  width,
});

const workloadReady: Column = {
  key: 'ready',
  title: 'Ready',
  render: (o) => {
    const s = summarizeWorkload(o);
    return <Badge text={s.ready} severity={s.severity} />;
  },
  sortValue: (o) => summarizeWorkload(o).ready,
  width: '80px',
};

const podColumns: Column[] = [
  name,
  namespace,
  {
    key: 'ready',
    title: 'Ready',
    render: (o) => summarizePod(o).ready,
    width: '64px',
  },
  {
    key: 'status',
    title: 'Status',
    render: (o) => {
      const s = summarizePod(o);
      return <Badge text={s.status} severity={s.severity} />;
    },
    sortValue: (o) => summarizePod(o).status,
  },
  { key: 'restarts', title: 'Restarts', render: (o) => summarizePod(o).restarts, sortValue: (o) => summarizePod(o).restarts, width: '76px' },
  {
    key: 'cpu',
    title: 'CPU',
    render: (o, c) => {
      const m = c.metrics?.pods[`${o.metadata.namespace}/${o.metadata.name}`];
      return m ? formatCpu(m.cpuMillis) : '-';
    },
    sortValue: (o, c) => c.metrics?.pods[`${o.metadata.namespace}/${o.metadata.name}`]?.cpuMillis ?? -1,
    width: '70px',
  },
  {
    key: 'memory',
    title: 'Memory',
    render: (o, c) => {
      const m = c.metrics?.pods[`${o.metadata.namespace}/${o.metadata.name}`];
      return m ? formatBytes(m.memoryBytes) : '-';
    },
    sortValue: (o, c) => c.metrics?.pods[`${o.metadata.namespace}/${o.metadata.name}`]?.memoryBytes ?? -1,
    width: '80px',
  },
  text('node', 'Node', (o) => o.spec?.nodeName),
  text('ip', 'IP', (o) => o.status?.podIP, '120px'),
  age,
];

const nodeColumns: Column[] = [
  name,
  {
    key: 'status',
    title: 'Status',
    render: (o) => {
      const s = summarizeNode(o);
      return <Badge text={s.status} severity={s.severity} />;
    },
    sortValue: (o) => summarizeNode(o).status,
  },
  text('roles', 'Roles', (o) => summarizeNode(o).roles),
  text('version', 'Version', (o) => o.status?.nodeInfo?.kubeletVersion),
  {
    key: 'cpu',
    title: 'CPU',
    render: (o, c) => {
      const m = c.metrics?.nodes[o.metadata.name];
      return m ? formatCpu(m.cpuMillis) : '-';
    },
    width: '70px',
  },
  {
    key: 'memory',
    title: 'Memory',
    render: (o, c) => {
      const m = c.metrics?.nodes[o.metadata.name];
      return m ? formatBytes(m.memoryBytes) : '-';
    },
    width: '80px',
  },
  text('ip', 'Internal IP', (o) => (o.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address),
  age,
];

function servicePorts(o: KubeObject): string {
  return (o.spec?.ports ?? []).map((p: any) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol ?? 'TCP'}`).join(', ');
}

function eventColumns(): Column[] {
  return [
    {
      key: 'type',
      title: 'Type',
      render: (o) => <Badge text={o.type ?? ''} severity={o.type === 'Warning' ? 'warn' : 'ok'} />,
      sortValue: (o) => o.type ?? '',
      width: '84px',
    },
    text('reason', 'Reason', (o) => o.reason),
    text('object', 'Object', (o) => `${o.involvedObject?.kind ?? ''}/${o.involvedObject?.name ?? ''}`),
    { key: 'message', title: 'Message', render: (o) => <span className="cell-wrap">{o.message}</span>, sortValue: (o) => o.message ?? '' },
    namespace,
    text('count', 'Count', (o) => o.count ?? 1, '60px'),
    {
      key: 'last',
      title: 'Last Seen',
      render: (o, c) => formatAge(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp, c.now),
      sortValue: (o) => -(Date.parse(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp ?? '') || 0),
      width: '84px',
    },
  ];
}

export function columnsFor(kind: string, namespaced: boolean): Column[] {
  const base = namespaced ? [name, namespace] : [name];
  switch (kind) {
    case 'Pod':
      return podColumns;
    case 'Node':
      return nodeColumns;
    case 'Event':
      return eventColumns();
    case 'Deployment':
      return [...base, workloadReady, text('uptodate', 'Up-to-date', (o) => o.status?.updatedReplicas ?? 0, '90px'), text('available', 'Available', (o) => o.status?.availableReplicas ?? 0, '84px'), age];
    case 'StatefulSet':
    case 'ReplicaSet':
      return [...base, workloadReady, age];
    case 'DaemonSet':
      return [...base, workloadReady, text('desired', 'Desired', (o) => o.status?.desiredNumberScheduled ?? 0, '70px'), text('available', 'Available', (o) => o.status?.numberAvailable ?? 0, '84px'), age];
    case 'Job':
      return [
        ...base,
        text('completions', 'Completions', (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}`, '100px'),
        {
          key: 'status',
          title: 'Status',
          render: (o) => {
            const c = (o.status?.conditions ?? []).find((x: any) => x.status === 'True');
            const t = c?.type ?? (o.status?.active ? 'Running' : 'Pending');
            return <Badge text={t} severity={t === 'Complete' ? 'done' : t === 'Failed' ? 'error' : 'pending'} />;
          },
        },
        age,
      ];
    case 'CronJob':
      return [
        ...base,
        text('schedule', 'Schedule', (o) => o.spec?.schedule),
        { key: 'suspend', title: 'Suspended', render: (o) => (o.spec?.suspend ? <Badge text="Yes" severity="warn" /> : 'No'), width: '90px' },
        text('active', 'Active', (o) => (o.status?.active ?? []).length, '64px'),
        { key: 'last', title: 'Last Schedule', render: (o, c) => formatAge(o.status?.lastScheduleTime, c.now) },
        age,
      ];
    case 'Service':
      return [...base, text('type', 'Type', (o) => o.spec?.type), text('clusterIP', 'Cluster IP', (o) => o.spec?.clusterIP), text('ports', 'Ports', servicePorts), age];
    case 'Ingress':
      return [
        ...base,
        text('class', 'Class', (o) => o.spec?.ingressClassName ?? ''),
        text('hosts', 'Hosts', (o) => (o.spec?.rules ?? []).map((r: any) => r.host ?? '*').join(', ')),
        text('address', 'Address', (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(', ')),
        age,
      ];
    case 'ConfigMap':
      return [...base, text('data', 'Keys', (o) => Object.keys(o.data ?? {}).length + Object.keys(o.binaryData ?? {}).length, '60px'), age];
    case 'Secret':
      return [...base, text('type', 'Type', (o) => o.type), text('data', 'Keys', (o) => Object.keys(o.data ?? {}).length, '60px'), age];
    case 'PersistentVolumeClaim':
      return [
        ...base,
        {
          key: 'status',
          title: 'Status',
          render: (o) => <Badge text={o.status?.phase ?? ''} severity={o.status?.phase === 'Bound' ? 'ok' : 'pending'} />,
        },
        text('volume', 'Volume', (o) => o.spec?.volumeName),
        text('capacity', 'Capacity', (o) => o.status?.capacity?.storage),
        text('class', 'Storage Class', (o) => o.spec?.storageClassName),
        age,
      ];
    case 'PersistentVolume':
      return [
        ...base,
        text('capacity', 'Capacity', (o) => o.spec?.capacity?.storage),
        text('status', 'Status', (o) => o.status?.phase),
        text('claim', 'Claim', (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : '')),
        text('class', 'Storage Class', (o) => o.spec?.storageClassName),
        age,
      ];
    case 'Namespace':
      return [...base, { key: 'status', title: 'Status', render: (o) => <Badge text={o.status?.phase ?? ''} severity={o.status?.phase === 'Active' ? 'ok' : 'warn'} /> }, age];
    case 'HorizontalPodAutoscaler':
      return [
        ...base,
        text('target', 'Target', (o) => `${o.spec?.scaleTargetRef?.kind}/${o.spec?.scaleTargetRef?.name}`),
        text('replicas', 'Replicas', (o) => `${o.status?.currentReplicas ?? 0} (${o.spec?.minReplicas ?? 1}-${o.spec?.maxReplicas})`),
        age,
      ];
    case 'CustomResourceDefinition':
      return [name, text('group', 'Group', (o) => o.spec?.group), text('kind', 'Kind', (o) => o.spec?.names?.kind), text('scope', 'Scope', (o) => o.spec?.scope, '100px'), age];
    case 'RoleBinding':
    case 'ClusterRoleBinding':
      return [...base, text('role', 'Role', (o) => `${o.roleRef?.kind}/${o.roleRef?.name}`), text('subjects', 'Subjects', (o) => (o.subjects ?? []).map((s: any) => `${s.kind}:${s.name}`).join(', ')), age];
    default:
      return [...base, age];
  }
}
