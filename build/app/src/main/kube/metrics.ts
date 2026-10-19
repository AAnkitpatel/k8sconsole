import { parseQuantity } from '../../shared/format';
import type { MetricsSnapshot } from '../../shared/types';
import { KubeApiError, type KubeRest } from './rest';

/** Reads pod and node usage from metrics.k8s.io (metrics-server). Missing metrics are reported, not thrown. */
export async function readMetrics(rest: KubeRest, namespace?: string): Promise<MetricsSnapshot> {
  const snap: MetricsSnapshot = { available: false, pods: {}, nodes: {} };
  try {
    const podPath = namespace ? `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods` : '/apis/metrics.k8s.io/v1beta1/pods';
    const [pods, nodes] = await Promise.all([rest.get(podPath, { timeoutMs: 10000 }), rest.get('/apis/metrics.k8s.io/v1beta1/nodes', { timeoutMs: 10000 }).catch(() => ({ items: [] }))]);
    for (const p of pods.items ?? []) {
      let cpu = 0;
      let mem = 0;
      for (const c of p.containers ?? []) {
        cpu += parseQuantity(c.usage?.cpu) * 1000;
        mem += parseQuantity(c.usage?.memory);
      }
      snap.pods[`${p.metadata.namespace}/${p.metadata.name}`] = { cpuMillis: cpu, memoryBytes: mem };
    }
    for (const n of nodes.items ?? []) {
      snap.nodes[n.metadata.name] = { cpuMillis: parseQuantity(n.usage?.cpu) * 1000, memoryBytes: parseQuantity(n.usage?.memory) };
    }
    snap.available = true;
  } catch (err) {
    snap.error = err instanceof KubeApiError && (err.code === 404 || err.code === 503) ? 'Metrics API (metrics-server) is not available in this cluster.' : err instanceof Error ? err.message : String(err);
  }
  return snap;
}
