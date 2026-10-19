import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DeregisterTaskDefinitionCommand,
  DescribeClustersCommand,
  DescribeContainerInstancesCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ListClustersCommand,
  ListContainerInstancesCommand,
  ListServicesCommand,
  ListTaskDefinitionFamiliesCommand,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { FilterLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTargetGroupsCommand, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  arnName,
  averageSeries,
  buildEcsGraph,
  isEcsArn,
  isValidEcsName,
  logSourceFor,
  scanEcs,
  toRegisterInput,
  type EcsCluster,
  type EcsContainerInstance,
  type EcsEvent,
  type EcsLogEvent,
  type EcsLogSource,
  type EcsMetrics,
  type EcsRunTaskRequest,
  type EcsScanReport,
  type EcsSecurityGroupInfo,
  type EcsService,
  type EcsServiceMetrics,
  type EcsServiceUpdate,
  type EcsTargetHealth,
  type EcsTask,
  type EcsTaskDefinitionFamily,
} from '../../shared/ecs';
import type { ResourceGraph } from '../../shared/graph';
import { ReadOnlyError, type AwsClients } from './session';

const ms = (d: unknown): number | undefined => (d instanceof Date ? d.getTime() : typeof d === 'string' || typeof d === 'number' ? new Date(d).getTime() || undefined : undefined);
const tagMap = (tags: Array<{ key?: string; value?: string }> | undefined): Record<string, string> => Object.fromEntries((tags ?? []).filter((t) => t.key).map((t) => [t.key!, t.value ?? '']));
const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function toCluster(c: any): EcsCluster {
  return {
    arn: c.clusterArn,
    name: c.clusterName,
    status: c.status ?? 'UNKNOWN',
    runningTasks: c.runningTasksCount ?? 0,
    pendingTasks: c.pendingTasksCount ?? 0,
    activeServices: c.activeServicesCount ?? 0,
    containerInstances: c.registeredContainerInstancesCount ?? 0,
    capacityProviders: c.capacityProviders ?? [],
    containerInsights: (c.settings ?? []).find((s: any) => s.name === 'containerInsights')?.value,
    execLogging: c.configuration?.executeCommandConfiguration?.logging,
    tags: tagMap(c.tags),
  };
}

export function toService(s: any): EcsService {
  const awsvpc = s.networkConfiguration?.awsvpcConfiguration;
  return {
    arn: s.serviceArn,
    name: s.serviceName,
    clusterArn: s.clusterArn,
    status: s.status ?? 'UNKNOWN',
    desired: s.desiredCount ?? 0,
    running: s.runningCount ?? 0,
    pending: s.pendingCount ?? 0,
    launchType: s.launchType,
    capacityProviders: (s.capacityProviderStrategy ?? []).map((c: any) => c.capacityProvider),
    platformVersion: s.platformVersion,
    schedulingStrategy: s.schedulingStrategy,
    taskDefinition: s.taskDefinition,
    deployments: (s.deployments ?? []).map((d: any) => ({
      id: d.id,
      status: d.status,
      rolloutState: d.rolloutState,
      rolloutReason: d.rolloutStateReason,
      taskDefinition: d.taskDefinition,
      desired: d.desiredCount ?? 0,
      running: d.runningCount ?? 0,
      pending: d.pendingCount ?? 0,
      failed: d.failedTasks ?? 0,
      createdAt: ms(d.createdAt),
      updatedAt: ms(d.updatedAt),
    })),
    loadBalancers: (s.loadBalancers ?? []).map((l: any) => ({ targetGroupArn: l.targetGroupArn, loadBalancerName: l.loadBalancerName, containerName: l.containerName, containerPort: l.containerPort })),
    serviceRegistries: (s.serviceRegistries ?? []).length,
    network: awsvpc ? { subnets: awsvpc.subnets ?? [], securityGroups: awsvpc.securityGroups ?? [], assignPublicIp: awsvpc.assignPublicIp } : undefined,
    enableExecuteCommand: !!s.enableExecuteCommand,
    circuitBreaker: s.deploymentConfiguration?.deploymentCircuitBreaker ? { enable: !!s.deploymentConfiguration.deploymentCircuitBreaker.enable, rollback: !!s.deploymentConfiguration.deploymentCircuitBreaker.rollback } : undefined,
    minimumHealthyPercent: s.deploymentConfiguration?.minimumHealthyPercent,
    maximumPercent: s.deploymentConfiguration?.maximumPercent,
    deploymentController: s.deploymentController?.type,
    healthCheckGracePeriodSeconds: s.healthCheckGracePeriodSeconds,
    createdAt: ms(s.createdAt),
    events: (s.events ?? []).slice(0, 100).map((e: any): EcsEvent => ({ id: e.id, createdAt: ms(e.createdAt) ?? 0, message: e.message ?? '' })),
    tags: tagMap(s.tags),
  };
}

export function toTask(t: any): EcsTask {
  const eni = (t.attachments ?? []).find((a: any) => a.type === 'ElasticNetworkInterface');
  const detail = (n: string) => eni?.details?.find((d: any) => d.name === n)?.value;
  const group: string | undefined = t.group;
  return {
    arn: t.taskArn,
    id: arnName(t.taskArn),
    clusterArn: t.clusterArn,
    group,
    serviceName: group?.startsWith('service:') ? group.slice(8) : undefined,
    taskDefinition: t.taskDefinitionArn,
    lastStatus: t.lastStatus ?? 'UNKNOWN',
    desiredStatus: t.desiredStatus ?? 'UNKNOWN',
    health: t.healthStatus,
    launchType: t.launchType,
    capacityProvider: t.capacityProviderName,
    cpu: t.cpu,
    memory: t.memory,
    az: t.availabilityZone,
    privateIp: detail('privateIPv4Address') ?? t.containers?.[0]?.networkInterfaces?.[0]?.privateIpv4Address,
    eni: detail('networkInterfaceId'),
    containerInstanceArn: t.containerInstanceArn,
    createdAt: ms(t.createdAt),
    startedAt: ms(t.startedAt),
    stoppingAt: ms(t.stoppingAt),
    stoppedAt: ms(t.stoppedAt),
    stoppedReason: t.stoppedReason,
    stopCode: t.stopCode,
    enableExecuteCommand: !!t.enableExecuteCommand,
    containers: (t.containers ?? []).map((c: any) => ({
      name: c.name,
      image: c.image,
      lastStatus: c.lastStatus,
      exitCode: c.exitCode ?? undefined,
      reason: c.reason,
      health: c.healthStatus,
      runtimeId: c.runtimeId,
      cpu: c.cpu,
      memory: c.memory,
      execAgent: (c.managedAgents ?? []).find((a: any) => a.name === 'ExecuteCommandAgent')?.lastStatus,
    })),
  };
}

function toContainerInstance(c: any): EcsContainerInstance {
  const res = (list: any[] | undefined, n: string) => (list ?? []).find((r: any) => r.name === n)?.integerValue;
  return {
    arn: c.containerInstanceArn,
    ec2InstanceId: c.ec2InstanceId,
    status: c.status,
    agentConnected: !!c.agentConnected,
    runningTasks: c.runningTasksCount ?? 0,
    pendingTasks: c.pendingTasksCount ?? 0,
    cpuRegistered: res(c.registeredResources, 'CPU'),
    cpuRemaining: res(c.remainingResources, 'CPU'),
    memRegistered: res(c.registeredResources, 'MEMORY'),
    memRemaining: res(c.remainingResources, 'MEMORY'),
    agentVersion: c.versionInfo?.agentVersion,
    capacityProvider: c.capacityProviderName,
  };
}

/** The ECS operations behind the ECS views. Write operations refuse to run on a read-only connection. */
export class EcsApi {
  private readonly taskDefs = new Map<string, { def: any; tags: Array<{ key: string; value: string }> }>();

  constructor(private readonly aws: AwsClients) {}

  get readOnly(): boolean {
    return this.aws.readOnly;
  }

  get region(): string {
    return this.aws.region;
  }

  private writable(op: string): void {
    if (this.aws.readOnly) throw new ReadOnlyError(op);
  }

  private cluster(arn: string): string {
    if (!isEcsArn(arn, 'cluster') && !isValidEcsName(arn)) throw new Error('Invalid cluster');
    return arn;
  }

  async identity(): Promise<{ account: string; arn: string }> {
    const r = await this.aws.sts.send(new GetCallerIdentityCommand({}));
    return { account: r.Account, arn: r.Arn };
  }

  // ---- Reads ----

  async listClusters(): Promise<EcsCluster[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await this.aws.ecs.send(new ListClustersCommand({ nextToken, maxResults: 100 }));
      arns.push(...(r.clusterArns ?? []));
      nextToken = r.nextToken;
    } while (nextToken && arns.length < 1000);
    const out: EcsCluster[] = [];
    for (const batch of chunks(arns, 100)) {
      const r = await this.aws.ecs.send(new DescribeClustersCommand({ clusters: batch, include: ['STATISTICS', 'SETTINGS', 'CONFIGURATIONS', 'TAGS'] }));
      out.push(...(r.clusters ?? []).map(toCluster));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeCluster(cluster: string): Promise<EcsCluster> {
    const r = await this.aws.ecs.send(new DescribeClustersCommand({ clusters: [this.cluster(cluster)], include: ['STATISTICS', 'SETTINGS', 'CONFIGURATIONS', 'TAGS'] }));
    const c = r.clusters?.[0];
    if (!c) throw new Error(r.failures?.[0]?.reason === 'MISSING' ? 'Cluster not found in this region.' : `Cluster unavailable: ${r.failures?.[0]?.reason ?? 'unknown'}`);
    return toCluster(c);
  }

  async listServices(cluster: string): Promise<EcsService[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await this.aws.ecs.send(new ListServicesCommand({ cluster: this.cluster(cluster), nextToken, maxResults: 100 }));
      arns.push(...(r.serviceArns ?? []));
      nextToken = r.nextToken;
    } while (nextToken && arns.length < 2000);
    const out: EcsService[] = [];
    for (const batch of chunks(arns, 10)) {
      const r = await this.aws.ecs.send(new DescribeServicesCommand({ cluster, services: batch, include: ['TAGS'] }));
      out.push(...(r.services ?? []).map(toService));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getService(cluster: string, service: string): Promise<EcsService> {
    if (!isValidEcsName(service) && !isEcsArn(service, 'service')) throw new Error('Invalid service name');
    const r = await this.aws.ecs.send(new DescribeServicesCommand({ cluster: this.cluster(cluster), services: [service], include: ['TAGS'] }));
    const s = r.services?.[0];
    if (!s) throw new Error('Service not found (it may have been deleted).');
    return toService(s);
  }

  async listTasks(cluster: string, opts: { serviceName?: string; desiredStatus?: 'RUNNING' | 'STOPPED' | 'ALL' } = {}): Promise<EcsTask[]> {
    if (opts.serviceName && !isValidEcsName(opts.serviceName)) throw new Error('Invalid service name');
    const statuses: Array<'RUNNING' | 'STOPPED'> = opts.desiredStatus === 'ALL' || !opts.desiredStatus ? ['RUNNING', 'STOPPED'] : [opts.desiredStatus];
    const arns: string[] = [];
    for (const desiredStatus of statuses) {
      let nextToken: string | undefined;
      do {
        const r = await this.aws.ecs.send(new ListTasksCommand({ cluster: this.cluster(cluster), serviceName: opts.serviceName, desiredStatus, nextToken, maxResults: 100 }));
        arns.push(...(r.taskArns ?? []));
        nextToken = r.nextToken;
      } while (nextToken && arns.length < 1000);
    }
    const out: EcsTask[] = [];
    for (const batch of chunks([...new Set(arns)], 100)) {
      const r = await this.aws.ecs.send(new DescribeTasksCommand({ cluster, tasks: batch }));
      out.push(...(r.tasks ?? []).map(toTask));
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async getTask(cluster: string, task: string): Promise<EcsTask> {
    if (!isEcsArn(task, 'task') && !/^[a-f0-9]{32}$/.test(task)) throw new Error('Invalid task id');
    const r = await this.aws.ecs.send(new DescribeTasksCommand({ cluster: this.cluster(cluster), tasks: [task] }));
    const t = r.tasks?.[0];
    if (!t) throw new Error('Task not found (stopped tasks are kept for about an hour).');
    return toTask(t);
  }

  async listContainerInstances(cluster: string): Promise<EcsContainerInstance[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await this.aws.ecs.send(new ListContainerInstancesCommand({ cluster: this.cluster(cluster), nextToken, maxResults: 100 }));
      arns.push(...(r.containerInstanceArns ?? []));
      nextToken = r.nextToken;
    } while (nextToken && arns.length < 1000);
    const out: EcsContainerInstance[] = [];
    for (const batch of chunks(arns, 100)) {
      const r = await this.aws.ecs.send(new DescribeContainerInstancesCommand({ cluster, containerInstances: batch }));
      out.push(...(r.containerInstances ?? []).map(toContainerInstance));
    }
    return out;
  }

  /** Task definitions are immutable per revision, so described ones are cached. */
  async taskDefinition(arn: string): Promise<{ def: any; tags: Array<{ key: string; value: string }> }> {
    if (!isEcsArn(arn, 'task-definition') && !/^[A-Za-z0-9_-]{1,255}(:\d+)?$/.test(arn)) throw new Error('Invalid task definition');
    const cached = this.taskDefs.get(arn);
    if (cached) return cached;
    const r = await this.aws.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ['TAGS'] }));
    const v = { def: r.taskDefinition, tags: (r.tags ?? []).map((t: any) => ({ key: t.key, value: t.value ?? '' })) };
    if (isEcsArn(arn, 'task-definition')) this.taskDefs.set(arn, v);
    this.taskDefs.set(r.taskDefinition.taskDefinitionArn, v);
    return v;
  }

  async listTaskDefinitionFamilies(prefix?: string): Promise<EcsTaskDefinitionFamily[]> {
    if (prefix && !isValidEcsName(prefix)) throw new Error('Invalid family prefix');
    const families: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await this.aws.ecs.send(new ListTaskDefinitionFamiliesCommand({ familyPrefix: prefix || undefined, status: 'ACTIVE', nextToken, maxResults: 100 }));
      families.push(...(r.families ?? []));
      nextToken = r.nextToken;
    } while (nextToken && families.length < 1000);
    const out: EcsTaskDefinitionFamily[] = [];
    // Latest revision per family (in small parallel batches to stay under API rate limits).
    for (const batch of chunks(families, 8)) {
      const rows = await Promise.all(
        batch.map(async (family) => {
          const r = await this.aws.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: 'ACTIVE', sort: 'DESC', maxResults: 1 }));
          const latest = r.taskDefinitionArns?.[0];
          return latest && arnName(latest).startsWith(`${family}:`) ? { family, latestArn: latest, latestRevision: Number(latest.slice(latest.lastIndexOf(':') + 1)) } : null;
        }),
      );
      out.push(...rows.filter((x): x is EcsTaskDefinitionFamily => !!x));
    }
    return out;
  }

  async listRevisions(family: string): Promise<string[]> {
    if (!isValidEcsName(family)) throw new Error('Invalid family');
    const out: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await this.aws.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: 'ACTIVE', sort: 'DESC', nextToken, maxResults: 100 }));
      out.push(...(r.taskDefinitionArns ?? []).filter((a: string) => arnName(a).startsWith(`${family}:`)));
      nextToken = r.nextToken;
    } while (nextToken && out.length < 500);
    return out;
  }

  async targetHealth(services: EcsService[]): Promise<EcsTargetHealth[]> {
    const arns = [...new Set(services.flatMap((s) => s.loadBalancers.map((l) => l.targetGroupArn).filter((a): a is string => !!a)))];
    const out: EcsTargetHealth[] = [];
    for (const batch of chunks(arns, 20)) {
      const groups = await this.aws.elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: batch }));
      const rows = await Promise.all(
        (groups.TargetGroups ?? []).map(async (g: any) => {
          const h = await this.aws.elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: g.TargetGroupArn }));
          return {
            targetGroupArn: g.TargetGroupArn,
            targetGroupName: g.TargetGroupName,
            loadBalancers: (g.LoadBalancerArns ?? []).map((a: string) => a.split('/').slice(-2, -1)[0] ?? a),
            protocol: g.Protocol,
            port: g.Port,
            healthCheckPath: g.HealthCheckPath,
            targets: (h.TargetHealthDescriptions ?? []).map((t: any) => ({ id: t.Target?.Id, port: t.Target?.Port, state: t.TargetHealth?.State ?? 'unknown', reason: t.TargetHealth?.Reason, description: t.TargetHealth?.Description })),
          } satisfies EcsTargetHealth;
        }),
      );
      out.push(...rows);
    }
    return out;
  }

  /** CloudWatch CPU and memory utilization (percent of reserved) for the cluster and each service. */
  async metrics(cluster: EcsCluster | string, serviceNames: string[], minutes: number): Promise<EcsServiceMetrics> {
    const clusterName = typeof cluster === 'string' ? arnName(cluster) || cluster : cluster.name;
    const span = Math.min(Math.max(Math.round(minutes) || 60, 15), 60 * 24 * 14);
    const periodSec = span <= 180 ? 60 : span <= 24 * 60 ? 300 : 3600;
    const names = serviceNames.filter(isValidEcsName).slice(0, 100);
    const metric = (m: string, svc?: string) => ({
      Metric: { Namespace: 'AWS/ECS', MetricName: m, Dimensions: [{ Name: 'ClusterName', Value: clusterName }, ...(svc ? [{ Name: 'ServiceName', Value: svc }] : [])] },
      Period: periodSec,
      Stat: 'Average',
    });
    const queries = [
      { Id: 'c_cpu', MetricStat: metric('CPUUtilization') },
      { Id: 'c_mem', MetricStat: metric('MemoryUtilization') },
      ...names.flatMap((s, i) => [
        { Id: `s${i}_cpu`, MetricStat: metric('CPUUtilization', s) },
        { Id: `s${i}_mem`, MetricStat: metric('MemoryUtilization', s) },
      ]),
    ];
    const end = new Date();
    const start = new Date(end.getTime() - span * 60_000);
    const results = new Map<string, { t: number[]; v: number[] }>();
    let nextToken: string | undefined;
    do {
      const r = await this.aws.cloudwatch.send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end, ScanBy: 'TimestampAscending', NextToken: nextToken }));
      for (const m of r.MetricDataResults ?? []) {
        const cur = results.get(m.Id) ?? { t: [], v: [] };
        (m.Timestamps ?? []).forEach((ts: Date, i: number) => {
          cur.t.push(ms(ts) ?? 0);
          cur.v.push(Number(m.Values?.[i] ?? NaN));
        });
        results.set(m.Id, cur);
      }
      nextToken = r.NextToken;
    } while (nextToken);
    const pair = (cpuId: string, memId: string): EcsMetrics => {
      const cpu = results.get(cpuId) ?? { t: [], v: [] };
      const mem = results.get(memId) ?? { t: [], v: [] };
      const ts = [...new Set([...cpu.t, ...mem.t])].sort((a, b) => a - b);
      const at = (s: { t: number[]; v: number[] }) => {
        const m = new Map(s.t.map((t, i) => [t, s.v[i]]));
        return ts.map((t) => m.get(t) ?? NaN);
      };
      return { t: ts, cpu: at(cpu), mem: at(mem), periodSec };
    };
    const services: Record<string, EcsMetrics> = {};
    names.forEach((s, i) => (services[s] = pair(`s${i}_cpu`, `s${i}_mem`)));
    const out: EcsServiceMetrics = { cluster: pair('c_cpu', 'c_mem'), services };
    const withData = names.map((n) => services[n]).filter((m) => m.t.length > 0);
    if (out.cluster.t.length === 0 && withData.length === 0) out.note = 'CloudWatch has no ECS utilization data for this period (no running tasks, or metrics are not published yet).';
    else if (out.cluster.t.length === 0) {
      // Fargate-only clusters publish utilization per service, not per cluster.
      out.cluster = averageSeries(withData, periodSec);
      out.note = 'Cluster utilization is the average of its services (CloudWatch publishes Fargate utilization per service).';
    }
    return out;
  }

  async securityGroups(ids: string[]): Promise<EcsSecurityGroupInfo[]> {
    const valid = [...new Set(ids.filter((i) => /^sg-[0-9a-f]{8,17}$/.test(i)))];
    const out: EcsSecurityGroupInfo[] = [];
    for (const batch of chunks(valid, 100)) {
      const r = await this.aws.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: batch }));
      for (const g of r.SecurityGroups ?? []) {
        const open: EcsSecurityGroupInfo['openIngress'] = [];
        for (const p of g.IpPermissions ?? []) {
          const cidrs = [...(p.IpRanges ?? []).map((x: any) => x.CidrIp), ...(p.Ipv6Ranges ?? []).map((x: any) => x.CidrIpv6)].filter((c) => c === '0.0.0.0/0' || c === '::/0');
          for (const cidr of cidrs) open.push({ protocol: String(p.IpProtocol ?? '-1'), fromPort: p.FromPort, toPort: p.ToPort, cidr });
        }
        out.push({ id: g.GroupId, name: g.GroupName, openIngress: open });
      }
    }
    return out;
  }

  async scan(cluster: string): Promise<EcsScanReport & { notes: string[] }> {
    const notes: string[] = [];
    const [c, services] = await Promise.all([this.describeCluster(cluster), this.listServices(cluster)]);
    const defs: Record<string, any> = {};
    for (const arn of [...new Set(services.map((s) => s.taskDefinition))]) {
      try {
        defs[arn] = (await this.taskDefinition(arn)).def;
      } catch (err) {
        notes.push(`Could not read ${arnName(arn)}: ${(err as Error).message}`);
      }
    }
    let sgs: EcsSecurityGroupInfo[] = [];
    try {
      sgs = await this.securityGroups(services.flatMap((s) => s.network?.securityGroups ?? []));
    } catch (err) {
      notes.push(`Security groups were not checked: ${(err as Error).message}`);
    }
    return { ...scanEcs({ cluster: c, services, taskDefinitions: defs, securityGroups: sgs }), notes };
  }

  async serviceMap(cluster: string, serviceName?: string): Promise<ResourceGraph & { notes: string[] }> {
    const notes: string[] = [];
    const all = await this.listServices(cluster);
    const services = serviceName ? all.filter((s) => s.name === serviceName) : all;
    const tasks = await this.listTasks(cluster, { serviceName, desiredStatus: 'ALL' });
    let targets: EcsTargetHealth[] = [];
    try {
      targets = await this.targetHealth(services);
    } catch (err) {
      notes.push(`Load balancer health unavailable: ${(err as Error).message}`);
    }
    return { ...buildEcsGraph({ services, tasks, targets }), notes };
  }

  // ---- Logs ----

  async logSources(task: EcsTask): Promise<EcsLogSource[]> {
    const { def } = await this.taskDefinition(task.taskDefinition);
    return task.containers.map((c) => logSourceFor(def, c.name)).filter((s): s is EcsLogSource => !!s);
  }

  /** One page of log events for one stream (a task container) or a whole service, oldest first. */
  async logPage(src: EcsLogSource, scope: { stream?: string }, opts: { startTime: number; nextToken?: string; filterPattern?: string }): Promise<{ events: EcsLogEvent[]; nextToken?: string }> {
    const logs = this.aws.logs(src.region);
    const { stream } = scope;
    if (stream && !opts.filterPattern) {
      const r = await logs.send(new GetLogEventsCommand({ logGroupName: src.group, logStreamName: stream, startTime: opts.nextToken ? undefined : opts.startTime, startFromHead: true, nextToken: opts.nextToken, limit: 1000 }));
      return { events: (r.events ?? []).map((e: any) => ({ t: e.timestamp ?? 0, message: String(e.message ?? '').replace(/\n$/, ''), stream })), nextToken: r.nextForwardToken };
    }
    const r = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: src.group,
        logStreamNames: stream ? [stream] : undefined,
        logStreamNamePrefix: stream ? undefined : src.streamPrefix ? `${src.streamPrefix}/${src.container}/` : undefined,
        startTime: opts.startTime,
        filterPattern: opts.filterPattern || undefined,
        nextToken: opts.nextToken,
        limit: 1000,
      }),
    );
    return { events: (r.events ?? []).map((e: any) => ({ t: e.timestamp ?? 0, message: String(e.message ?? '').replace(/\n$/, ''), stream: e.logStreamName ?? '' })), nextToken: r.nextToken };
  }

  // ---- Writes ----

  async updateService(cluster: string, service: string, u: EcsServiceUpdate): Promise<EcsService> {
    this.writable('UpdateService');
    if (!isValidEcsName(service)) throw new Error('Invalid service name');
    const input: Record<string, unknown> = { cluster: this.cluster(cluster), service };
    if (u.desiredCount !== undefined) {
      if (!Number.isInteger(u.desiredCount) || u.desiredCount < 0 || u.desiredCount > 5000) throw new Error('Desired count must be a whole number from 0 to 5000');
      input.desiredCount = u.desiredCount;
    }
    if (u.taskDefinition !== undefined) {
      if (!isEcsArn(u.taskDefinition, 'task-definition') && !/^[A-Za-z0-9_-]{1,255}:\d+$/.test(u.taskDefinition)) throw new Error('Invalid task definition revision');
      input.taskDefinition = u.taskDefinition;
    }
    if (u.forceNewDeployment) input.forceNewDeployment = true;
    if (u.enableExecuteCommand !== undefined) input.enableExecuteCommand = !!u.enableExecuteCommand;
    if (Object.keys(input).length === 2) throw new Error('Nothing to change');
    const r = await this.aws.ecs.send(new UpdateServiceCommand(input as any));
    return toService(r.service);
  }

  async stopTask(cluster: string, task: string, reason: string): Promise<EcsTask> {
    this.writable('StopTask');
    if (!isEcsArn(task, 'task')) throw new Error('Invalid task');
    const r = await this.aws.ecs.send(new StopTaskCommand({ cluster: this.cluster(cluster), task, reason: (reason || 'Stopped from K8sConsole').slice(0, 255) }));
    return toTask(r.task);
  }

  async runTask(req: EcsRunTaskRequest): Promise<EcsTask[]> {
    this.writable('RunTask');
    const cluster = this.cluster(req.clusterArn);
    const count = Number(req.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Count must be 1 to 10');
    if (!isEcsArn(req.taskDefinition, 'task-definition') && !/^[A-Za-z0-9_-]{1,255}(:\d+)?$/.test(req.taskDefinition)) throw new Error('Invalid task definition');
    const input: Record<string, any> = { cluster, taskDefinition: req.taskDefinition, count, startedBy: 'k8sconsole', enableExecuteCommand: req.enableExecuteCommand || undefined };
    if (req.fromService) {
      const s = await this.aws.ecs.send(new DescribeServicesCommand({ cluster, services: [req.fromService] }));
      const svc = s.services?.[0];
      if (!svc) throw new Error('Service to copy network settings from was not found');
      if (svc.capacityProviderStrategy?.length) input.capacityProviderStrategy = svc.capacityProviderStrategy;
      else input.launchType = svc.launchType;
      if (svc.networkConfiguration) input.networkConfiguration = svc.networkConfiguration;
      if (svc.platformVersion && svc.launchType === 'FARGATE') input.platformVersion = svc.platformVersion;
    } else {
      input.launchType = req.launchType ?? 'FARGATE';
      if (req.network) {
        const ok = req.network.subnets.every((x) => /^subnet-[0-9a-f]{8,17}$/.test(x)) && req.network.securityGroups.every((x) => /^sg-[0-9a-f]{8,17}$/.test(x));
        if (!ok || !req.network.subnets.length) throw new Error('Network settings need valid subnet and security group ids');
        input.networkConfiguration = { awsvpcConfiguration: { subnets: req.network.subnets, securityGroups: req.network.securityGroups, assignPublicIp: req.network.assignPublicIp === 'ENABLED' ? 'ENABLED' : 'DISABLED' } };
      }
    }
    if (req.commandOverride) {
      const { container, command } = req.commandOverride;
      if (!container || !Array.isArray(command) || !command.length || command.some((c) => typeof c !== 'string')) throw new Error('Invalid command override');
      input.overrides = { containerOverrides: [{ name: container, command }] };
    }
    const r = await this.aws.ecs.send(new RunTaskCommand(input as any));
    if (r.failures?.length && !r.tasks?.length) throw new Error(`RunTask failed: ${r.failures.map((f: any) => `${f.reason}${f.detail ? ` (${f.detail})` : ''}`).join('; ')}`);
    return (r.tasks ?? []).map(toTask);
  }

  async registerTaskDefinition(json: string): Promise<{ arn: string; revision: number }> {
    this.writable('RegisterTaskDefinition');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }
    const input = toRegisterInput(parsed);
    const r = await this.aws.ecs.send(new RegisterTaskDefinitionCommand(input as any));
    return { arn: r.taskDefinition.taskDefinitionArn, revision: r.taskDefinition.revision };
  }

  async deregisterTaskDefinition(arn: string): Promise<void> {
    this.writable('DeregisterTaskDefinition');
    if (!isEcsArn(arn, 'task-definition')) throw new Error('Invalid task definition');
    await this.aws.ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
    this.taskDefs.delete(arn);
  }

  async createService(cluster: string, json: string): Promise<EcsService> {
    this.writable('CreateService');
    let input: any;
    try {
      input = JSON.parse(json);
    } catch (err) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The service definition must be a JSON object');
    if (!isValidEcsName(input.serviceName)) throw new Error('"serviceName" is required (letters, digits, hyphens and underscores)');
    if (!input.taskDefinition) throw new Error('"taskDefinition" is required');
    input.cluster = this.cluster(cluster);
    const r = await this.aws.ecs.send(new CreateServiceCommand(input));
    return toService(r.service);
  }

  async deleteService(cluster: string, service: string, force: boolean): Promise<void> {
    this.writable('DeleteService');
    if (!isValidEcsName(service)) throw new Error('Invalid service name');
    await this.aws.ecs.send(new DeleteServiceCommand({ cluster: this.cluster(cluster), service, force: !!force }));
  }
}
