import { PortForward, type KubeConfig } from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { isValidName } from '../../shared/resources';
import { validatePort } from '../../shared/validation';
import type { KubeObject, PortForwardInfo, PortForwardRequest } from '../../shared/types';
import type { KubeRest } from './rest';

/** Maps a Service port to a ready backing pod and its container port (handles named targetPorts). */
export function resolveServiceTarget(service: KubeObject, pods: KubeObject[], servicePort: number): { pod: string; port: number } {
  const ports: any[] = service.spec?.ports ?? [];
  const sp = ports.find((p) => p.port === servicePort);
  if (!sp) throw new Error(`Service ${service.metadata.name} has no port ${servicePort}`);
  const ready = pods.filter(
    (p) => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp && (p.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
  );
  if (ready.length === 0) throw new Error(`No ready pods back service ${service.metadata.name}`);
  const target = sp.targetPort ?? sp.port;
  for (const pod of ready) {
    if (typeof target === 'number' || /^\d+$/.test(String(target))) return { pod: pod.metadata.name, port: Number(target) };
    for (const c of pod.spec?.containers ?? []) {
      const named = (c.ports ?? []).find((p: any) => p.name === target);
      if (named) return { pod: pod.metadata.name, port: named.containerPort };
    }
  }
  throw new Error(`No pod exposes the named port "${target}"`);
}

function selectorString(sel: Record<string, string> | undefined): string {
  if (!sel || Object.keys(sel).length === 0) throw new Error('Service has no selector; port-forward a pod instead');
  return Object.entries(sel)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

interface Forward {
  info: PortForwardInfo;
  server: net.Server;
  sockets: Set<net.Socket>;
}

export class PortForwardManager {
  private readonly forwards = new Map<string, Forward>();

  constructor(private readonly onUpdate: (list: PortForwardInfo[]) => void) {}

  list(): PortForwardInfo[] {
    return [...this.forwards.values()].map((f) => ({ ...f.info }));
  }

  private notify() {
    this.onUpdate(this.list());
  }

  async start(kc: KubeConfig, rest: KubeRest, contextId: string, req: PortForwardRequest): Promise<PortForwardInfo> {
    if (!isValidName(req.namespace) || !isValidName(req.targetName)) throw new Error('Invalid target');
    const remoteErr = validatePort(req.remotePort);
    if (remoteErr) throw new Error(`Remote port: ${remoteErr}`);
    const localErr = validatePort(req.localPort, { allowZero: true });
    if (localErr) throw new Error(`Local port: ${localErr}`);

    let podName = req.targetName;
    let podPort = req.remotePort;
    if (req.targetKind === 'Service') {
      const svc = await rest.get(`/api/v1/namespaces/${req.namespace}/services/${req.targetName}`);
      const pods = await rest.get(`/api/v1/namespaces/${req.namespace}/pods`, { query: { labelSelector: selectorString(svc.spec?.selector) } });
      const t = resolveServiceTarget(svc, pods.items ?? [], req.remotePort);
      podName = t.pod;
      podPort = t.port;
    }

    const pf = new PortForward(kc);
    const id = randomUUID();
    const sockets = new Set<net.Socket>();
    const info: PortForwardInfo = {
      id,
      contextId,
      namespace: req.namespace,
      targetKind: req.targetKind,
      targetName: req.targetName,
      podName,
      remotePort: req.remotePort,
      localPort: req.localPort,
      state: 'active',
      connections: 0,
    };
    const server = net.createServer((socket) => {
      sockets.add(socket);
      info.connections = sockets.size;
      this.notify();
      socket.on('close', () => {
        sockets.delete(socket);
        info.connections = sockets.size;
        this.notify();
      });
      socket.on('error', () => socket.destroy());
      pf.portForward(req.namespace, podName, [podPort], socket, null, socket).catch((err: unknown) => {
        info.error = err instanceof Error ? err.message : String(err);
        socket.destroy();
        this.notify();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(req.localPort, '127.0.0.1', () => resolve());
    });
    server.on('error', (err) => {
      info.state = 'error';
      info.error = err.message;
      this.notify();
    });
    info.localPort = (server.address() as net.AddressInfo).port;
    this.forwards.set(id, { info, server, sockets });
    this.notify();
    return { ...info };
  }

  stop(id: string): void {
    const f = this.forwards.get(id);
    if (!f) return;
    this.forwards.delete(id);
    for (const s of f.sockets) s.destroy();
    f.server.close();
    this.notify();
  }

  stopForContext(contextId: string): void {
    for (const f of [...this.forwards.values()]) if (f.info.contextId === contextId) this.stop(f.info.id);
  }

  stopAll(): void {
    for (const id of [...this.forwards.keys()]) this.stop(id);
  }

  get(id: string): PortForwardInfo | undefined {
    const f = this.forwards.get(id);
    return f ? { ...f.info } : undefined;
  }
}
