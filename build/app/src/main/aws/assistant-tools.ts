import { arnName, isEcsArn, isValidEcsName, logSourceFor, logStreamName, redactTaskDefinition, serviceSummary, type EcsLogSource } from '../../shared/ecs';
import type { AwsWorkspace } from './controller';

/** Read-only ECS access for the AI assistant. Environment values and secret references are never returned. */
export interface EcsAssistantHost {
  clusters(): Promise<unknown>;
  services(cluster: string): Promise<unknown>;
  service(cluster: string, service: string): Promise<unknown>;
  tasks(cluster: string, service?: string, status?: 'RUNNING' | 'STOPPED'): Promise<unknown>;
  taskDefinition(arn: string): Promise<string>;
  logs(cluster: string, opts: { service?: string; task?: string; container?: string; minutes?: number; filter?: string; lines?: number }): Promise<string>;
  metrics(cluster: string, services?: string[], minutes?: number): Promise<unknown>;
  securityScan(cluster: string): Promise<unknown>;
}

function clusterArg(c: unknown): string {
  const s = String(c ?? '');
  if (!isEcsArn(s, 'cluster') && !isValidEcsName(s)) throw new Error('cluster must be an ECS cluster name or ARN');
  return s;
}

export function ecsAssistantHost(aws: AwsWorkspace, canReadLogs: () => boolean): EcsAssistantHost {
  const api = () => aws.require();
  return {
    clusters: async () => (await api().listClusters()).map((c) => ({ name: c.name, arn: c.arn, services: c.activeServices, runningTasks: c.runningTasks, pendingTasks: c.pendingTasks, containerInstances: c.containerInstances, containerInsights: c.containerInsights })),
    services: async (cluster) =>
      (await api().listServices(clusterArg(cluster))).map((s) => ({ name: s.name, status: serviceSummary(s), desired: s.desired, running: s.running, pending: s.pending, taskDefinition: arnName(s.taskDefinition), launchType: s.launchType, loadBalanced: s.loadBalancers.length > 0 })),
    service: async (cluster, service) => {
      const ecs = api();
      const s = await ecs.getService(clusterArg(cluster), String(service));
      const targets = await ecs.targetHealth([s]).catch((err: Error) => `unavailable: ${err.message}`);
      return { ...s, events: s.events.slice(0, 25), targetHealth: targets, tags: undefined };
    },
    tasks: async (cluster, service, status) =>
      (await api().listTasks(clusterArg(cluster), { serviceName: service, desiredStatus: status ?? 'ALL' })).slice(0, 100).map((t) => ({
        id: t.id,
        service: t.serviceName ?? t.group,
        lastStatus: t.lastStatus,
        desiredStatus: t.desiredStatus,
        health: t.health,
        taskDefinition: arnName(t.taskDefinition),
        startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : undefined,
        stoppedAt: t.stoppedAt ? new Date(t.stoppedAt).toISOString() : undefined,
        stoppedReason: t.stoppedReason,
        stopCode: t.stopCode,
        containers: t.containers.map((c) => ({ name: c.name, image: c.image, lastStatus: c.lastStatus, exitCode: c.exitCode, reason: c.reason, health: c.health })),
      })),
    taskDefinition: async (arn) => JSON.stringify(redactTaskDefinition((await api().taskDefinition(String(arn))).def), null, 1),
    logs: async (cluster, o) => {
      if (!canReadLogs()) throw new Error('Reading logs is turned off in Settings → AI Assistant.');
      const ecs = api();
      const c = clusterArg(cluster);
      const lines = Math.min(500, Math.max(1, Number(o.lines) || 200));
      const startTime = Date.now() - Math.min(Math.max(Number(o.minutes) || 60, 1), 7 * 1440) * 60_000;
      let scopes: Array<{ src: EcsLogSource; stream?: string }> = [];
      if (o.task) {
        // DescribeTasks accepts a task ARN or the 32-character task id.
        const t = await ecs.getTask(c, String(o.task));
        scopes = (await ecs.logSources(t)).filter((s) => !o.container || s.container === o.container).map((src) => ({ src, stream: logStreamName(src, t.id) }));
      } else if (o.service) {
        const s = await ecs.getService(c, String(o.service));
        const { def } = await ecs.taskDefinition(s.taskDefinition);
        scopes = (def.containerDefinitions ?? []).map((x: any) => logSourceFor(def, x.name)).filter((x: EcsLogSource | null): x is EcsLogSource => !!x && (!o.container || x.container === o.container)).map((src: EcsLogSource) => ({ src }));
      } else throw new Error('Give a service or a task');
      if (!scopes.length) return 'No CloudWatch logs: the containers do not use the awslogs driver.';
      const out: Array<{ t: number; line: string }> = [];
      for (const sc of scopes) {
        let token: string | undefined;
        for (let page = 0; page < 3; page++) {
          const r = await ecs.logPage(sc.src, { stream: sc.stream }, { startTime, nextToken: token, filterPattern: o.filter ? String(o.filter).slice(0, 512) : undefined });
          for (const e of r.events) out.push({ t: e.t, line: `${new Date(e.t).toISOString()} ${sc.src.container}${sc.stream ? '' : ` ${e.stream.split('/').pop()?.slice(0, 8)}`} ${e.message}` });
          if (!r.nextToken || r.nextToken === token || !r.events.length) break;
          token = r.nextToken;
        }
      }
      out.sort((a, b) => a.t - b.t);
      return out.slice(-lines).map((x) => x.line).join('\n') || 'No log lines in this period.';
    },
    metrics: async (cluster, services, minutes) => {
      const ecs = api();
      const c = clusterArg(cluster);
      const names = services?.length ? services : (await ecs.listServices(c)).map((s) => s.name);
      const m = await ecs.metrics(c, names, Number(minutes) || 60);
      const summarize = (v: number[]) => {
        const f = v.filter(Number.isFinite);
        return f.length ? { latest: Math.round(f[f.length - 1] * 10) / 10, avg: Math.round((f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10, max: Math.round(Math.max(...f) * 10) / 10 } : null;
      };
      return {
        unit: 'percent of reserved CPU / memory',
        note: m.note,
        cluster: { cpu: summarize(m.cluster.cpu), memory: summarize(m.cluster.mem) },
        services: Object.fromEntries(Object.entries(m.services).map(([k, v]) => [k, { cpu: summarize(v.cpu), memory: summarize(v.mem) }])),
      };
    },
    securityScan: async (cluster) => {
      const r = await api().scan(clusterArg(cluster));
      return { score: r.score, counts: r.counts, findings: r.findings.slice(0, 30).map((f) => ({ severity: f.severity, title: f.title, target: f.target, remediation: f.remediation })), notes: r.notes };
    },
  };
}
