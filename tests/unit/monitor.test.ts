import { afterEach, describe, expect, it } from 'vitest';
import { counterRate, MonitorCollector, parseSummary, podResources, SeriesStore } from '../../build/app/src/main/kube/monitor';
import { KubeRest } from '../../build/app/src/main/kube/rest';
import { niceScale } from '../../build/app/src/renderer/components/charts';
import { sliceHistory } from '../../build/app/src/renderer/views/MonitorView';
import type { MonitorSnapshot } from '../../build/app/src/shared/types';
import { json, startMockApi, status } from './mock-api';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

describe('monitor helpers', () => {
  it('parses kubelet summary documents', () => {
    const r = parseSummary({
      node: { cpu: { usageNanoCores: 250_000_000 }, memory: { workingSetBytes: 1024 }, network: { interfaces: [{ rxBytes: 10, txBytes: 5 }, { rxBytes: 20, txBytes: 1 }] }, fs: { usedBytes: 50, capacityBytes: 100 } },
      pods: [{ podRef: { namespace: 'a', name: 'p' }, cpu: { usageNanoCores: 1_000_000 }, memory: { workingSetBytes: 7 } }, { cpu: {} }],
    });
    expect(r.node).toEqual({ cpuMillis: 250, memBytes: 1024, rxBytes: 30, txBytes: 6, fsUsedBytes: 50, fsCapacityBytes: 100 });
    expect(r.pods.get('a/p')).toEqual({ cpuMillis: 1, memBytes: 7 });
    expect(r.pods.size).toBe(1);
  });

  it('computes counter rates and ignores resets', () => {
    expect(counterRate({ v: 1000, t: 0 }, { v: 3000, t: 2000 })).toBe(1000);
    expect(counterRate({ v: 3000, t: 0 }, { v: 10, t: 1000 })).toBeUndefined();
    expect(counterRate(undefined, { v: 1, t: 1 })).toBeUndefined();
    expect(counterRate({ v: 1, t: 5 }, { v: 2, t: 5 })).toBeUndefined();
  });

  it('sums requests/limits, taking the max of init containers', () => {
    expect(
      podResources({
        metadata: { name: 'p' },
        spec: {
          initContainers: [{ resources: { requests: { cpu: '2', memory: '1Gi' } } }],
          containers: [{ resources: { requests: { cpu: '250m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } } }, { resources: { requests: { cpu: '250m' } } }],
        },
      }),
    ).toEqual({ cpuReq: 2000, cpuLim: 500, memReq: 1073741824, memLim: 268435456 });
  });

  it('keeps a bounded history and pads missing columns', () => {
    const s = new SeriesStore(3);
    s.push('n', 1, { cpu: 1, mem: 10 });
    s.push('n', 2, { cpu: 2, mem: 20, rx: 5 });
    s.push('n', 3, { cpu: 3, mem: 30 });
    s.push('n', 4, { cpu: 4, mem: 40 });
    const h = s.history('n');
    expect(h.t).toEqual([2, 3, 4]);
    expect(h.cpu).toEqual([2, 3, 4]);
    expect(h.rx).toEqual([5, NaN, NaN]);
    s.prune(new Set());
    expect(s.history('n').t).toEqual([]);
  });

  it('slices history by time and picks nice axis scales', () => {
    expect(sliceHistory({ t: [1, 2, 3], cpu: [1, 2, 3], mem: [4, 5, 6] }, 2)).toEqual({ t: [2, 3], cpu: [2, 3], mem: [5, 6], rx: undefined, tx: undefined });
    expect(niceScale(87)).toEqual({ max: 100, step: 25 });
    expect(niceScale(0)).toEqual({ max: 1, step: 0.25 });
  });
});

const NODE = { metadata: { name: 'n1', labels: { 'node-role.kubernetes.io/control-plane': 'true' } }, status: { allocatable: { cpu: '4', memory: '8Gi', pods: '110' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: {} };
const POD = (name: string, cpu = '500m') => ({
  metadata: { name, namespace: 'app' },
  spec: { nodeName: 'n1', containers: [{ name: 'c', resources: { requests: { cpu, memory: '1Gi' }, limits: { cpu: '1' } } }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'c', ready: true, restartCount: 2, state: { running: {} } }] },
});

describe('MonitorCollector', () => {
  it('uses the kubelet summary API and derives network rates across samples', async () => {
    let rx = 1000;
    const api = await startMockApi((r, res) => {
      if (r.url.pathname === '/api/v1/nodes') return json(res, 200, { items: [NODE] });
      if (r.url.pathname === '/api/v1/pods') return json(res, 200, { items: [POD('a'), POD('b', '1'), { ...POD('done'), status: { phase: 'Succeeded' } }] });
      if (r.url.pathname === '/api/v1/nodes/n1/proxy/stats/summary') {
        rx += 5000;
        return json(res, 200, {
          node: { cpu: { usageNanoCores: 1_500_000_000 }, memory: { workingSetBytes: 2 ** 32 }, network: { interfaces: [{ rxBytes: rx, txBytes: 10 }] }, fs: { usedBytes: 1, capacityBytes: 4 } },
          pods: [{ podRef: { namespace: 'app', name: 'a' }, cpu: { usageNanoCores: 300_000_000 }, memory: { workingSetBytes: 100 } }],
        });
      }
      status(res, 404, 'not found');
    });
    cleanup.push(api.close);
    const snaps: MonitorSnapshot[] = [];
    const m = new MonitorCollector(new KubeRest(api.kc), (s) => snaps.push(s), 10);
    await m.tick(1_000_000);
    await m.tick(1_010_000);
    m.stop(true);
    const s = snaps[1];
    expect(s.source).toBe('kubelet-summary');
    expect(s.cluster).toMatchObject({ cpuAllocMillis: 4000, cpuUsageMillis: 1500, cpuRequestsMillis: 1500, cpuLimitsMillis: 2000, pods: 2, podCapacity: 110, nodesReady: 1, nodesTotal: 1 });
    expect(s.nodes[0]).toMatchObject({ name: 'n1', roles: 'control-plane', rxBps: 500, fsUsedBytes: 1 });
    expect(s.cluster.history.cpu).toEqual([1500, 1500]);
    const a = s.pods.find((p) => p.name === 'a')!;
    expect(a).toMatchObject({ cpuUsageMillis: 300, cpuRequestsMillis: 500, cpuLimitsMillis: 1000, restarts: 2, status: 'Running' });
    expect(a.spark.cpu).toEqual([300, 300]);
    expect(m.podHistory('app', 'a')?.t).toEqual([1_000_000, 1_010_000]);
    expect(s.pods.find((p) => p.name === 'b')!.cpuUsageMillis).toBeUndefined();
  });

  it('falls back to metrics-server when nodes/proxy is forbidden, then to requests only', async () => {
    let metrics = true;
    const api = await startMockApi((r, res) => {
      if (r.url.pathname === '/api/v1/nodes') return json(res, 200, { items: [NODE] });
      if (r.url.pathname === '/api/v1/pods') return json(res, 200, { items: [POD('a')] });
      if (r.url.pathname.endsWith('/stats/summary')) return status(res, 403, 'forbidden');
      if (metrics && r.url.pathname === '/apis/metrics.k8s.io/v1beta1/nodes') return json(res, 200, { items: [{ metadata: { name: 'n1' }, usage: { cpu: '750m', memory: '1Gi' } }] });
      if (metrics && r.url.pathname === '/apis/metrics.k8s.io/v1beta1/pods') return json(res, 200, { items: [{ metadata: { namespace: 'app', name: 'a' }, containers: [{ usage: { cpu: '100m', memory: '64Mi' } }] }] });
      status(res, 404, 'not found');
    });
    cleanup.push(api.close);
    const snaps: MonitorSnapshot[] = [];
    const m = new MonitorCollector(new KubeRest(api.kc), (s) => snaps.push(s));
    await m.tick(1);
    expect(snaps[0].source).toBe('metrics-server');
    expect(snaps[0].nodes[0].cpuUsageMillis).toBe(750);
    expect(snaps[0].pods[0].cpuUsageMillis).toBeCloseTo(100);
    metrics = false;
    await m.tick(2);
    m.stop(true);
    expect(snaps[1].source).toBe('requests-only');
    expect(snaps[1].error).toMatch(/requests and limits only/);
    expect(snaps[1].cluster.cpuUsageMillis).toBeUndefined();
    // The summary API is not retried once forbidden.
    expect(api.requests.filter((r) => r.url.pathname.endsWith('/stats/summary'))).toHaveLength(1);
  });
});

describe('chart scaling', () => {
  it('keeps the reference line only when it does not flatten the data', async () => {
    const { scaleMax, timeLabel } = await import('../../build/app/src/renderer/components/charts');
    expect(scaleMax(100, 12000)).toEqual({ max: 100, showReference: false });
    expect(scaleMax(5000, 12000)).toEqual({ max: 12000, showReference: true });
    expect(scaleMax(0, 10).showReference).toBe(false);
    expect(timeLabel(new Date(2026, 0, 1, 10, 29, 5).getTime(), 60_000)).toMatch(/29.05/);
  });
});
