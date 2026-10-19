import { describe, expect, it } from 'vitest';
import { cleanForEditing, formatAge, formatBytes, formatCpu, parseQuantity, summarizeNode, summarizePod, summarizeWorkload } from '../../build/app/src/shared/format';
import type { KubeObject } from '../../build/app/src/shared/types';

const pod = (status: any, spec: any = { containers: [{ name: 'a' }] }, meta: any = {}): KubeObject => ({ kind: 'Pod', metadata: { name: 'p', ...meta }, spec, status });

describe('formatAge', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  it('formats seconds, minutes, hours, days, years like kubectl', () => {
    expect(formatAge('2026-01-09T23:59:15Z', now)).toBe('45s');
    expect(formatAge('2026-01-09T23:30:00Z', now)).toBe('30m');
    expect(formatAge('2026-01-09T19:00:00Z', now)).toBe('5h');
    expect(formatAge('2026-01-05T00:00:00Z', now)).toBe('5d');
    expect(formatAge('2023-01-01T00:00:00Z', now)).toBe('3y');
  });
  it('handles missing and invalid timestamps', () => {
    expect(formatAge(undefined, now)).toBe('-');
    expect(formatAge('not a date', now)).toBe('-');
  });
  it('never returns negative ages for clock skew', () => {
    expect(formatAge('2026-01-10T00:00:10Z', now)).toBe('0s');
  });
});

describe('summarizePod', () => {
  it('reports a ready running pod', () => {
    const s = summarizePod(pod({ phase: 'Running', containerStatuses: [{ name: 'a', ready: true, restartCount: 0, state: { running: {} } }] }));
    expect(s).toEqual({ status: 'Running', ready: '1/1', restarts: 0, severity: 'ok' });
  });
  it('surfaces waiting reasons such as CrashLoopBackOff', () => {
    const s = summarizePod(pod({ phase: 'Running', containerStatuses: [{ name: 'a', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] }));
    expect(s.status).toBe('CrashLoopBackOff');
    expect(s.restarts).toBe(7);
    expect(s.severity).toBe('error');
  });
  it('reports init container progress', () => {
    const s = summarizePod(
      pod(
        { phase: 'Pending', initContainerStatuses: [{ name: 'i', state: { waiting: { reason: 'PodInitializing' } } }], containerStatuses: [] },
        { initContainers: [{ name: 'i' }], containers: [{ name: 'a' }] },
      ),
    );
    expect(s.status).toBe('Init:0/1');
    expect(s.severity).toBe('pending');
  });
  it('reports failed init containers', () => {
    const s = summarizePod(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'i', state: { terminated: { exitCode: 1, reason: 'Error' } } }] }, { initContainers: [{ name: 'i' }], containers: [{ name: 'a' }] }));
    expect(s.status).toBe('Init:Error');
    expect(s.severity).toBe('error');
  });
  it('marks pods being deleted as Terminating', () => {
    const s = summarizePod(pod({ phase: 'Running', containerStatuses: [{ name: 'a', ready: true, state: { running: {} } }] }, undefined, { deletionTimestamp: '2026-01-01T00:00:00Z' }));
    expect(s.status).toBe('Terminating');
  });
  it('treats completed pods as done', () => {
    const s = summarizePod(pod({ phase: 'Succeeded', containerStatuses: [{ name: 'a', ready: false, state: { terminated: { exitCode: 0, reason: 'Completed' } } }] }));
    expect(s.status).toBe('Completed');
    expect(s.severity).toBe('done');
  });
  it('warns when running but not all containers are ready', () => {
    const s = summarizePod(pod({ phase: 'Running', containerStatuses: [{ name: 'a', ready: false, state: { running: {} } }] }));
    expect(s.severity).toBe('warn');
    expect(s.ready).toBe('0/1');
  });
});

describe('summarizeWorkload / summarizeNode', () => {
  it('computes deployment readiness', () => {
    expect(summarizeWorkload({ kind: 'Deployment', metadata: { name: 'd' }, spec: { replicas: 3 }, status: { readyReplicas: 3 } })).toEqual({ ready: '3/3', severity: 'ok' });
    expect(summarizeWorkload({ kind: 'Deployment', metadata: { name: 'd' }, spec: { replicas: 3 }, status: { readyReplicas: 1 } }).severity).toBe('warn');
    expect(summarizeWorkload({ kind: 'Deployment', metadata: { name: 'd' }, spec: { replicas: 3 }, status: {} }).severity).toBe('error');
    expect(summarizeWorkload({ kind: 'DaemonSet', metadata: { name: 'd' }, status: { desiredNumberScheduled: 2, numberReady: 2 } }).ready).toBe('2/2');
  });
  it('computes node status and roles', () => {
    const n: KubeObject = {
      kind: 'Node',
      metadata: { name: 'n', labels: { 'node-role.kubernetes.io/control-plane': 'true' } },
      spec: { unschedulable: true },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
    expect(summarizeNode(n)).toEqual({ status: 'Ready,SchedulingDisabled', roles: 'control-plane', severity: 'warn' });
    expect(summarizeNode({ kind: 'Node', metadata: { name: 'x' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } }).severity).toBe('error');
  });
});

describe('quantities', () => {
  it('parses binary, decimal, milli and exponent suffixes', () => {
    expect(parseQuantity('250m')).toBeCloseTo(0.25);
    expect(parseQuantity('1Gi')).toBe(1073741824);
    expect(parseQuantity('1.5Ki')).toBe(1536);
    expect(parseQuantity('2k')).toBe(2000);
    expect(parseQuantity('100n')).toBeCloseTo(1e-7);
    expect(parseQuantity('2e3')).toBe(2000);
    expect(parseQuantity('4')).toBe(4);
    expect(parseQuantity(undefined)).toBe(0);
    expect(parseQuantity('garbage')).toBeNaN();
  });
  it('formats cpu and memory', () => {
    expect(formatCpu(250)).toBe('250m');
    expect(formatCpu(2500)).toBe('2.50');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(1536 * 1024)).toBe('1.5Mi');
    expect(formatBytes(NaN)).toBe('-');
  });
});

describe('cleanForEditing', () => {
  it('removes managedFields without mutating the input', () => {
    const o: KubeObject = { metadata: { name: 'a', managedFields: [{}] } };
    const c = cleanForEditing(o, true);
    expect(c.metadata.managedFields).toBeUndefined();
    expect(o.metadata.managedFields).toHaveLength(1);
    expect(cleanForEditing(o, false).metadata.managedFields).toHaveLength(1);
  });
});
