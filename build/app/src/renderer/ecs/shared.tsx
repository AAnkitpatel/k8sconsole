import { arnName, taskStatus, type EcsTask } from '../../shared/ecs';
import type { Col } from './common';
import { StatusBadge, ago } from './state';

export { useEcs, StatusBadge, ago, when, isWarningEvent } from './state';

export const taskLabel = (t: EcsTask) => `${t.lastStatus.toLowerCase()}${t.lastStatus === 'RUNNING' && t.health && t.health !== 'UNKNOWN' ? ` · ${t.health.toLowerCase()}` : ''}`;

export const taskCols: Col<EcsTask>[] = [
  { key: 'id', title: 'Task', render: (t) => <span className="mono cell-name">{t.id.slice(0, 12)}</span>, sort: (t) => t.id },
  { key: 'service', title: 'Service / group', render: (t) => t.serviceName ?? t.group ?? '', sort: (t) => t.serviceName ?? t.group ?? '' },
  { key: 'status', title: 'Status', render: (t) => <StatusBadge status={taskStatus(t)} label={taskLabel(t)} />, sort: (t) => t.lastStatus },
  { key: 'td', title: 'Revision', render: (t) => <span className="mono">{arnName(t.taskDefinition)}</span>, sort: (t) => arnName(t.taskDefinition) },
  { key: 'size', title: 'CPU / memory', render: (t) => (t.cpu ? `${Number(t.cpu) / 1024} vCPU · ${Number(t.memory) >= 1024 ? `${Number(t.memory) / 1024} GB` : `${t.memory} MB`}` : '') },
  { key: 'az', title: 'Zone / IP', render: (t) => `${t.az ?? ''}${t.privateIp ? ` · ${t.privateIp}` : ''}`, sort: (t) => t.az ?? '' },
  {
    key: 'age',
    title: 'Started',
    render: (t) => (t.lastStatus === 'STOPPED' ? <span title={t.stoppedReason}>stopped {ago(t.stoppedAt)} ago</span> : t.startedAt ? `${ago(t.startedAt)} ago` : `created ${ago(t.createdAt)} ago`),
    sort: (t) => -(t.startedAt ?? t.createdAt ?? 0),
  },
];
