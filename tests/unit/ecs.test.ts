import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ECSClient, ListServicesCommand, UpdateServiceCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import {
  arnName,
  averageSeries,
  buildEcsGraph,
  isEcsArn,
  isReadOnlyCommand,
  isValidRoleArn,
  logSourceFor,
  logStreamName,
  redactTaskDefinition,
  scanEcs,
  serviceStatus,
  serviceSummary,
  taskStatus,
  toRegisterInput,
  type EcsCluster,
  type EcsService,
  type EcsTask,
} from '../../build/app/src/shared/ecs';
import { listProfiles, parseIni } from '../../build/app/src/main/aws/profiles';
import { ReadOnlyError, describeAwsError, memoizeCredentials, readOnlyGuard, type AwsClients, type Sender } from '../../build/app/src/main/aws/session';
import { EcsApi, toService, toTask } from '../../build/app/src/main/aws/ecs';
import { EcsLogTails } from '../../build/app/src/main/aws/logs';
import { AwsWorkspace, sanitizeConnectRequest } from '../../build/app/src/main/aws/controller';
import { sanitizeSettings } from '../../build/app/src/main/settings';
import { buildAwsSuggestions } from '../../build/app/src/main/terminal-setup';

const ACCT = '123456789012';
const CLUSTER = `arn:aws:ecs:eu-west-2:${ACCT}:cluster/prod`;
const TD = (rev: number, fam = 'web') => `arn:aws:ecs:eu-west-2:${ACCT}:task-definition/${fam}:${rev}`;
const TG = `arn:aws:elasticloadbalancing:eu-west-2:${ACCT}:targetgroup/web-tg/0123456789abcdef`;

function awsService(over: any = {}): any {
  return {
    serviceArn: `arn:aws:ecs:eu-west-2:${ACCT}:service/prod/${over.serviceName ?? 'web'}`,
    serviceName: 'web',
    clusterArn: CLUSTER,
    status: 'ACTIVE',
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    launchType: 'FARGATE',
    taskDefinition: TD(7),
    deployments: [{ id: 'ecs-svc/1', status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: TD(7), desiredCount: 2, runningCount: 2, pendingCount: 0, failedTasks: 0, createdAt: new Date(1e12), updatedAt: new Date(1e12 + 1000) }],
    loadBalancers: [{ targetGroupArn: TG, containerName: 'app', containerPort: 8080 }],
    networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-0aaaaaaaaaaaaaaaa'], securityGroups: ['sg-0bbbbbbbbbbbbbbbb'], assignPublicIp: 'DISABLED' } },
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, minimumHealthyPercent: 100, maximumPercent: 200 },
    deploymentController: { type: 'ECS' },
    enableExecuteCommand: false,
    events: [{ id: 'e1', createdAt: new Date(1e12), message: '(service web) has reached a steady state.' }],
    tags: [{ key: 'team', value: 'shop' }],
    ...over,
  };
}

function awsTask(id: string, over: any = {}): any {
  return {
    taskArn: `arn:aws:ecs:eu-west-2:${ACCT}:task/prod/${id}`,
    clusterArn: CLUSTER,
    group: 'service:web',
    taskDefinitionArn: TD(7),
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    healthStatus: 'HEALTHY',
    launchType: 'FARGATE',
    cpu: '512',
    memory: '1024',
    availabilityZone: 'eu-west-2a',
    attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: '10.0.1.5' }, { name: 'networkInterfaceId', value: 'eni-1' }] }],
    enableExecuteCommand: true,
    containers: [{ name: 'app', image: 'repo/app:1.2.3', lastStatus: 'RUNNING', runtimeId: `${id}-123`, managedAgents: [{ name: 'ExecuteCommandAgent', lastStatus: 'RUNNING' }] }],
    createdAt: new Date(2e12),
    ...over,
  };
}

const svc = (over: any = {}): EcsService => toService(awsService(over));
const task = (id: string, over: any = {}): EcsTask => toTask(awsTask(id, over));

/** Fake SDK client: answers by command class name; records every command it receives. */
function fakeSender(handlers: Record<string, (input: any, n: number) => any>): Sender & { calls: Array<{ name: string; input: any }> } {
  const calls: Array<{ name: string; input: any }> = [];
  return {
    calls,
    async send(cmd: any) {
      const name = cmd.constructor.name as string;
      calls.push({ name, input: cmd.input });
      const h = handlers[name];
      if (!h) throw new Error(`unexpected ${name}`);
      return h(cmd.input, calls.filter((c) => c.name === name).length);
    },
  };
}

function clients(over: Partial<Record<'ecs' | 'cloudwatch' | 'elb' | 'ec2' | 'sts' | 'logs', Sender>>, readOnly = false): AwsClients {
  const none = fakeSender({});
  return { region: 'eu-west-2', readOnly, ecs: over.ecs ?? none, cloudwatch: over.cloudwatch ?? none, elb: over.elb ?? none, ec2: over.ec2 ?? none, sts: over.sts ?? none, logs: () => over.logs ?? none };
}

describe('ECS identifiers', () => {
  it('validates ARNs, names and role ARNs', () => {
    expect(isEcsArn(CLUSTER, 'cluster')).toBe(true);
    expect(isEcsArn(`${CLUSTER};rm`, 'cluster')).toBe(false);
    expect(isEcsArn(TD(3), 'task-definition')).toBe(true);
    expect(isValidRoleArn(`arn:aws:iam::${ACCT}:role/ops/ReadOnly`)).toBe(true);
    expect(isValidRoleArn('arn:aws:iam::12:role/x')).toBe(false);
    expect(arnName(TD(3))).toBe('web:3');
  });

  it('treats only describe/list/get style commands as read-only', () => {
    for (const c of ['DescribeServicesCommand', 'ListTasksCommand', 'GetMetricDataCommand', 'FilterLogEventsCommand', 'GetCallerIdentityCommand']) expect(isReadOnlyCommand(c)).toBe(true);
    for (const c of ['UpdateServiceCommand', 'StopTaskCommand', 'RunTaskCommand', 'DeleteServiceCommand', 'RegisterTaskDefinitionCommand', 'ExecuteCommandCommand', 'TagResourceCommand', 'Listing', 'Describe']) expect(isReadOnlyCommand(c)).toBe(false);
  });
});

describe('service and task status', () => {
  it('summarizes steady, scaled-down, degraded, deploying and failed services', () => {
    expect(serviceStatus(svc())).toBe('ok');
    expect(serviceSummary(svc())).toBe('steady');
    expect(serviceStatus(svc({ desiredCount: 0, runningCount: 0 }))).toBe('done');
    expect(serviceStatus(svc({ runningCount: 1 }))).toBe('warn');
    expect(serviceSummary(svc({ runningCount: 1 }))).toBe('1 of 2 running');
    expect(serviceStatus(svc({ runningCount: 0 }))).toBe('error');
    const deploying = svc({ deployments: [{ id: 'a', status: 'PRIMARY', rolloutState: 'IN_PROGRESS', taskDefinition: TD(8) }, { id: 'b', status: 'ACTIVE', taskDefinition: TD(7) }] });
    expect(serviceStatus(deploying)).toBe('warn');
    expect(serviceSummary(deploying)).toBe('deploying web:8');
    const failed = svc({ deployments: [{ id: 'a', status: 'PRIMARY', rolloutState: 'FAILED', rolloutStateReason: 'circuit breaker triggered', taskDefinition: TD(8) }] });
    expect(serviceStatus(failed)).toBe('error');
    expect(serviceSummary(failed)).toContain('circuit breaker');
  });

  it('marks crashed tasks as errors and clean stops as done', () => {
    expect(taskStatus(task('a'))).toBe('ok');
    expect(taskStatus(task('b', { lastStatus: 'PROVISIONING' }))).toBe('pending');
    expect(taskStatus(task('c', { healthStatus: 'UNHEALTHY' }))).toBe('error');
    expect(taskStatus(task('d', { lastStatus: 'STOPPED', stopCode: 'EssentialContainerExited', containers: [{ name: 'app', exitCode: 1 }] }))).toBe('error');
    expect(taskStatus(task('e', { lastStatus: 'STOPPED', stopCode: 'ServiceSchedulerInitiated', containers: [{ name: 'app', exitCode: 0 }] }))).toBe('done');
  });

  it('maps AWS task shapes, including the ENI address and exec agent', () => {
    const t = task('0123456789abcdef0123456789abcdef');
    expect(t).toMatchObject({ id: '0123456789abcdef0123456789abcdef', serviceName: 'web', privateIp: '10.0.1.5', eni: 'eni-1', enableExecuteCommand: true });
    expect(t.containers[0].execAgent).toBe('RUNNING');
    expect(task('x', { group: 'family:batch' }).serviceName).toBeUndefined();
  });
});

describe('logs', () => {
  const def = {
    containerDefinitions: [
      { name: 'app', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/web', 'awslogs-region': 'eu-west-1', 'awslogs-stream-prefix': 'ecs' } } },
      { name: 'sidecar', logConfiguration: { logDriver: 'awsfirelens', options: {} } },
      { name: 'noprefix', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/x' } } },
    ],
  };
  it('resolves awslogs groups and stream names', () => {
    const src = logSourceFor(def, 'app')!;
    expect(src).toEqual({ group: '/ecs/web', region: 'eu-west-1', streamPrefix: 'ecs', container: 'app' });
    expect(logStreamName(src, 'abc')).toBe('ecs/app/abc');
    expect(logSourceFor(def, 'sidecar')).toBeNull();
    expect(logStreamName(logSourceFor(def, 'noprefix')!, 'abc')).toBeUndefined();
  });

  it('tails a task stream with forward tokens and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const logs = fakeSender({
        GetLogEventsCommand: (_input, n) =>
          n === 1 ? { events: [{ timestamp: 1, message: 'boot\n' }, { timestamp: 2, message: 'ready' }], nextForwardToken: 'f2' } : n === 2 ? { events: [], nextForwardToken: 'f2' } : { events: [{ timestamp: 3, message: 'request' }], nextForwardToken: 'f3' },
      });
      const ecs = fakeSender({
        DescribeTasksCommand: () => ({ tasks: [awsTask('t1')] }),
        DescribeTaskDefinitionCommand: () => ({ taskDefinition: { taskDefinitionArn: TD(7), ...def }, tags: [] }),
      });
      const chunks: any[] = [];
      const tails = new EcsLogTails((c) => chunks.push(c), 1000);
      const api = new EcsApi(clients({ ecs, logs }));
      const { streamId, sources } = await tails.start(api, { clusterArn: CLUSTER, taskArn: awsTask('t1').taskArn, container: 'app', sinceSeconds: 600, follow: true });
      expect(sources.map((s) => s.container)).toEqual(['app']);
      await vi.advanceTimersByTimeAsync(0);
      expect(chunks.flatMap((c) => c.events ?? []).map((e: any) => e.message)).toEqual(['boot', 'ready']);
      expect(logs.calls[0].input).toMatchObject({ logGroupName: '/ecs/web', logStreamName: 'ecs/app/t1', startFromHead: true });
      await vi.advanceTimersByTimeAsync(1000);
      // Follow-up polls continue from the forward token (and stop sending startTime).
      const followUp = logs.calls.slice(1).find((c) => c.input.nextToken === 'f2');
      expect(followUp?.input.startTime).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(chunks.flatMap((c) => c.events ?? []).map((e: any) => e.message)).toEqual(['boot', 'ready', 'request']);
      tails.stop(streamId);
      const before = logs.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(logs.calls.length).toBe(before);
      expect(tails.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads service-wide logs with a stream prefix and de-duplicates the boundary', async () => {
    const page = [
      { timestamp: 10, message: 'a', logStreamName: 'ecs/app/t1' },
      { timestamp: 11, message: 'b', logStreamName: 'ecs/app/t2' },
    ];
    const logs = fakeSender({ FilterLogEventsCommand: (_i, n) => ({ events: n === 1 ? page : [page[1], { timestamp: 12, message: 'c', logStreamName: 'ecs/app/t1' }] }) });
    const ecs = fakeSender({
      DescribeServicesCommand: () => ({ services: [awsService()] }),
      DescribeTaskDefinitionCommand: () => ({ taskDefinition: { taskDefinitionArn: TD(7), ...def }, tags: [] }),
    });
    const chunks: any[] = [];
    const tails = new EcsLogTails((c) => chunks.push(c), 5);
    const api = new EcsApi(clients({ ecs, logs }));
    const { streamId } = await tails.start(api, { clusterArn: CLUSTER, serviceName: 'web', container: 'app', sinceSeconds: 600, follow: true });
    await new Promise((r) => setTimeout(r, 40));
    tails.stop(streamId);
    expect(logs.calls[0].input).toMatchObject({ logGroupName: '/ecs/web', logStreamNamePrefix: 'ecs/app/' });
    expect(chunks.flatMap((c) => c.events ?? []).map((e: any) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('reports containers without CloudWatch logs', async () => {
    const ecs = fakeSender({
      DescribeServicesCommand: () => ({ services: [awsService()] }),
      DescribeTaskDefinitionCommand: () => ({ taskDefinition: { taskDefinitionArn: TD(7), containerDefinitions: [{ name: 'app' }] }, tags: [] }),
    });
    const chunks: any[] = [];
    const tails = new EcsLogTails((c) => chunks.push(c));
    await tails.start(new EcsApi(clients({ ecs })), { clusterArn: CLUSTER, serviceName: 'web', sinceSeconds: 600, follow: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(chunks[0]).toMatchObject({ end: true, error: expect.stringContaining('awslogs') });
  });
});

describe('task definition editing', () => {
  it('drops read-only fields and keeps tags', () => {
    const described = { taskDefinitionArn: TD(3), revision: 3, status: 'ACTIVE', family: 'web', requiresAttributes: [], compatibilities: ['FARGATE'], registeredAt: 'x', registeredBy: 'y', containerDefinitions: [{ name: 'app', image: 'repo/app:1' }], cpu: '256', tags: [{ key: 'a', value: 'b' }] };
    const input = toRegisterInput(described);
    expect(Object.keys(input).sort()).toEqual(['containerDefinitions', 'cpu', 'family', 'tags']);
    expect(() => toRegisterInput({ family: 'web', containerDefinitions: [] })).toThrow(/containerDefinitions/);
    expect(() => toRegisterInput({ family: 'bad name', containerDefinitions: [{ name: 'a', image: 'b' }] })).toThrow(/family/);
    expect(() => toRegisterInput({ family: 'web', containerDefinitions: [{ name: 'a' }] })).toThrow(/image/);
  });

  it('redacts environment values and secret references for the assistant', () => {
    const red = redactTaskDefinition({ containerDefinitions: [{ name: 'a', environment: [{ name: 'DB_PASSWORD', value: 'hunter2' }], secrets: [{ name: 'K', valueFrom: 'arn:aws:ssm:x' }] }] });
    expect(JSON.stringify(red)).not.toContain('hunter2');
    expect(JSON.stringify(red)).not.toContain('arn:aws:ssm');
  });
});

describe('service map', () => {
  it('links load balancer, target group, service, tasks, revisions and security groups', () => {
    const g = buildEcsGraph({
      services: [svc()],
      tasks: [task('t1'), task('t2'), task('t3', { lastStatus: 'STOPPED', stoppedReason: 'Essential container exited', stopCode: 'EssentialContainerExited', containers: [{ name: 'app', exitCode: 137 }] })],
      targets: [{ targetGroupArn: TG, targetGroupName: 'web-tg', loadBalancers: ['shop-alb'], targets: [{ id: '10.0.1.5', state: 'healthy' }, { id: '10.0.1.6', state: 'unhealthy' }] }],
    });
    const kinds = g.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(['EcsService', 'LoadBalancer', 'SecurityGroup', 'TargetGroup', 'Task', 'Task', 'Task', 'TaskDefinition']);
    expect(g.nodes.find((n) => n.kind === 'TargetGroup')!.status).toBe('warn');
    expect(g.nodes.find((n) => n.name === '1 failed task')!.status).toBe('error');
    expect(g.edges).toContainEqual({ from: 'LoadBalancer//shop-alb', to: 'TargetGroup//web-tg', type: 'routes' });
    expect(g.edges).toContainEqual({ from: 'EcsService//web', to: 'Task//t1', type: 'owns' });
    expect(g.edges.every((e) => g.nodes.some((n) => n.id === e.from) && g.nodes.some((n) => n.id === e.to))).toBe(true);
  });
});

describe('security scan', () => {
  const cluster: EcsCluster = { arn: CLUSTER, name: 'prod', status: 'ACTIVE', runningTasks: 2, pendingTasks: 0, activeServices: 1, containerInstances: 0, capacityProviders: [], containerInsights: 'disabled', tags: {} };
  it('finds risky task definitions, services and open security groups', () => {
    const r = scanEcs({
      cluster,
      services: [svc({ networkConfiguration: { awsvpcConfiguration: { subnets: [], securityGroups: ['sg-1'], assignPublicIp: 'ENABLED' } }, loadBalancers: [], desiredCount: 1, runningCount: 1, deploymentConfiguration: {} })],
      taskDefinitions: {
        [TD(7)]: {
          networkMode: 'awsvpc',
          containerDefinitions: [
            { name: 'app', image: 'repo/app:latest', privileged: true, environment: [{ name: 'API_TOKEN', value: 'abc' }, { name: 'AWS_SECRET_ACCESS_KEY', value: 'x' }], linuxParameters: { capabilities: { add: ['SYS_ADMIN'] } } },
            { name: 'ok', image: 'repo/ok@sha256:abc', user: '1000', readonlyRootFilesystem: true, healthCheck: { command: ['CMD', 'true'] }, logConfiguration: { logDriver: 'awslogs' }, essential: true },
          ],
        },
      },
      securityGroups: [
        { id: 'sg-1', openIngress: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '0.0.0.0/0' }, { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' }, { protocol: '-1', cidr: '::/0' }] },
      ],
    });
    const rules = r.findings.map((f) => f.rule);
    for (const rule of ['privileged', 'static-aws-keys', 'plaintext-secret', 'mutable-tag', 'dangerous-capabilities', 'runs-as-root', 'public-ip', 'circuit-breaker', 'single-task', 'cluster-insights', 'open-ingress']) expect(rules).toContain(rule);
    expect(r.findings.filter((f) => f.rule === 'open-ingress')).toHaveLength(2); // port 443 is allowed
    expect(r.findings.filter((f) => f.target.includes('container ok'))).toHaveLength(0);
    expect(new Set(r.findings.map((f) => f.id)).size).toBe(r.findings.length);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.score).toBeLessThan(50);
  });

  it('scores a hardened service highly', () => {
    const r = scanEcs({
      cluster: { ...cluster, containerInsights: 'enhanced' },
      services: [svc()],
      taskDefinitions: { [TD(7)]: { taskRoleArn: 'arn:aws:iam::1:role/x', containerDefinitions: [{ name: 'app', image: 'repo/app:1.2.3', user: '1000', readonlyRootFilesystem: true, healthCheck: { command: ['CMD', 'true'] }, logConfiguration: { logDriver: 'awslogs' } }] } },
      securityGroups: [{ id: 'sg-0bbbbbbbbbbbbbbbb', openIngress: [] }],
    });
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(100);
  });
});

describe('metrics helpers', () => {
  it('averages series over the union of timestamps, skipping gaps', () => {
    const a = { t: [1, 2], cpu: [10, 20], mem: [50, NaN], periodSec: 60 };
    const b = { t: [2, 3], cpu: [40, 60], mem: [70, 80], periodSec: 60 };
    expect(averageSeries([a, b], 60)).toEqual({ t: [1, 2, 3], cpu: [10, 30, 60], mem: [50, 70, 80], periodSec: 60 });
  });
});

describe('AWS profiles', () => {
  it('lists profiles without reading key material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k8sc-aws-'));
    writeFileSync(join(dir, 'config'), `[default]\nregion = us-east-1\n\n[profile ops]\nrole_arn = arn:aws:iam::${ACCT}:role/Ops\nsource_profile = default\nregion = eu-west-2\n\n[profile sso-dev]\nsso_session = corp\nsso_account_id = ${ACCT}\n\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\n`);
    writeFileSync(join(dir, 'credentials'), '[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = SECRETVALUE\n[legacy]\naws_access_key_id = AKIA2\naws_secret_access_key = S2\n');
    const p = listProfiles({ configPath: join(dir, 'config'), credentialsPath: join(dir, 'credentials') });
    expect(p.map((x) => `${x.name}:${x.kind}`)).toEqual(['default:static', 'legacy:static', 'ops:assume-role', 'sso-dev:sso']);
    expect(p.find((x) => x.name === 'ops')).toMatchObject({ region: 'eu-west-2', roleArn: `arn:aws:iam::${ACCT}:role/Ops` });
    expect(JSON.stringify(p)).not.toMatch(/SECRET|AKIA/);
    expect(parseIni('; c\n[a]\nk = v = w\n').get('a')!.get('k')).toBe('v = w');
  });

  it('validates connect requests and defaults to read-only', () => {
    expect(sanitizeConnectRequest({ mode: 'profile', profile: 'super', region: 'eu-west-2' })).toEqual({ mode: 'profile', profile: 'super', region: 'eu-west-2', readOnly: true });
    expect(sanitizeConnectRequest({ mode: 'default', region: 'us-east-1', readOnly: false, assumeRoleArn: ` arn:aws:iam::${ACCT}:role/Admin `, externalId: 'ext-1' })).toMatchObject({ mode: 'default', assumeRoleArn: `arn:aws:iam::${ACCT}:role/Admin`, externalId: 'ext-1', readOnly: false });
    expect(() => sanitizeConnectRequest({ mode: 'profile', profile: 'a b', region: 'eu-west-2' })).toThrow(/profile/);
    expect(() => sanitizeConnectRequest({ mode: 'default', region: 'mars-1' })).toThrow(/region/);
    expect(() => sanitizeConnectRequest({ mode: 'default', region: 'eu-west-2', assumeRoleArn: 'role/x' })).toThrow(/role ARN/);
  });

  it('keeps only valid remembered connections in settings', () => {
    const s = sanitizeSettings({ workspace: 'ecs', awsLastConnection: { mode: 'profile', profile: 'super', region: 'eu-west-2', readOnly: false, secret: 'x' }, ecsLastCluster: { 'super|eu-west-2': CLUSTER, bad: 'x y' } });
    expect(s.workspace).toBe('ecs');
    expect(s.awsLastConnection).toEqual({ mode: 'profile', profile: 'super', region: 'eu-west-2', assumeRoleArn: undefined, externalId: undefined, readOnly: false });
    expect(s.ecsLastCluster).toEqual({ 'super|eu-west-2': CLUSTER });
    expect(sanitizeSettings({ awsLastConnection: { mode: 'profile', region: 'nowhere' } }).awsLastConnection).toBeNull();
  });
});

describe('read-only enforcement', () => {
  it('blocks state-changing commands in the SDK middleware before any request is sent', async () => {
    const handle = vi.fn(async () => {
      throw new Error('network must not be reached');
    });
    const client = new ECSClient({ region: 'eu-west-2', credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test' }, requestHandler: { handle } as any, maxAttempts: 1 });
    let readOnly = true;
    client.middlewareStack.use(readOnlyGuard(() => readOnly));
    await expect(client.send(new UpdateServiceCommand({ cluster: 'prod', service: 'web', desiredCount: 0 }))).rejects.toBeInstanceOf(ReadOnlyError);
    expect(handle).not.toHaveBeenCalled();
    // Reads pass through to the transport.
    await expect(client.send(new ListServicesCommand({ cluster: 'prod' }))).rejects.toThrow('network must not be reached');
    expect(handle).toHaveBeenCalledTimes(1);
    readOnly = false;
    await expect(client.send(new DescribeServicesCommand({ cluster: 'prod', services: ['web'] }))).rejects.toThrow('network');
    await expect(client.send(new UpdateServiceCommand({ cluster: 'prod', service: 'web', desiredCount: 0 }))).rejects.toThrow('network must not be reached');
  });

  it('refuses writes in the service layer on a read-only connection', async () => {
    const ecs = fakeSender({});
    const api = new EcsApi(clients({ ecs }, true));
    await expect(api.updateService(CLUSTER, 'web', { desiredCount: 0 })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(api.stopTask(CLUSTER, awsTask('t').taskArn, 'x')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(api.runTask({ clusterArn: CLUSTER, taskDefinition: 'web:1', count: 1 })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(api.registerTaskDefinition('{}')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(api.deregisterTaskDefinition(TD(1))).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(api.createService(CLUSTER, '{}')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(api.deleteService(CLUSTER, 'web', true)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(ecs.calls).toEqual([]);
  });

  it('explains common credential problems without echoing secrets', () => {
    expect(describeAwsError(Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }), { mode: 'profile', profile: 'dev', region: 'eu-west-2', readOnly: true })).toMatch(/profile "dev"/);
    expect(describeAwsError(Object.assign(new Error('The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login'), { name: 'TokenProviderError' }), { mode: 'profile', profile: 'dev', region: 'eu-west-2', readOnly: true })).toBe('AWS SSO session expired or missing. Run: aws sso login --profile dev');
    expect(describeAwsError(Object.assign(new Error('x'), { name: 'ExpiredTokenException' }))).toMatch(/expired/);
  });

  it('fetches credentials once and refreshes before expiry', async () => {
    let n = 0;
    const p = memoizeCredentials(async () => ({ accessKeyId: `k${++n}`, secretAccessKey: 's', expiration: new Date(Date.now() + (n === 1 ? 2 * 60_000 : 3600_000)) }));
    const [a, b] = await Promise.all([p(), p()]);
    expect(a.accessKeyId).toBe('k1');
    expect(b.accessKeyId).toBe('k1');
    expect((await p()).accessKeyId).toBe('k2'); // first one expires within 5 minutes
    expect((await p()).accessKeyId).toBe('k2');
  });
});

describe('EcsApi', () => {
  it('pages through services and describes them in batches of 10', async () => {
    const names = Array.from({ length: 23 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
    const ecs = fakeSender({
      ListServicesCommand: (input) => (input.nextToken ? { serviceArns: names.slice(20).map((n) => `arn:aws:ecs:eu-west-2:${ACCT}:service/prod/${n}`) } : { serviceArns: names.slice(0, 20).map((n) => `arn:aws:ecs:eu-west-2:${ACCT}:service/prod/${n}`), nextToken: 'p2' }),
      DescribeServicesCommand: (input) => ({ services: input.services.map((a: string) => awsService({ serviceName: arnName(a) })) }),
    });
    const list = await new EcsApi(clients({ ecs })).listServices(CLUSTER);
    expect(list.map((s) => s.name)).toEqual(names);
    expect(ecs.calls.filter((c) => c.name === 'DescribeServicesCommand').map((c) => c.input.services.length)).toEqual([10, 10, 3]);
  });

  it('builds CloudWatch queries per service and falls back to the service average for Fargate clusters', async () => {
    const cw = fakeSender({
      GetMetricDataCommand: (input) => ({
        MetricDataResults: input.MetricDataQueries.map((q: any) => (q.Id.startsWith('c_') ? { Id: q.Id, Timestamps: [], Values: [] } : { Id: q.Id, Timestamps: [new Date(1000), new Date(2000)], Values: q.Id.endsWith('cpu') ? [10, 30] : [40, 60] })),
      }),
    });
    const m = await new EcsApi(clients({ cloudwatch: cw })).metrics(CLUSTER, ['web', 'api', 'bad name'], 60);
    const q = cw.calls[0].input;
    expect(q.MetricDataQueries.map((x: any) => x.Id)).toEqual(['c_cpu', 'c_mem', 's0_cpu', 's0_mem', 's1_cpu', 's1_mem']);
    expect(q.MetricDataQueries[2].MetricStat.Metric.Dimensions).toEqual([{ Name: 'ClusterName', Value: 'prod' }, { Name: 'ServiceName', Value: 'web' }]);
    expect(q.MetricDataQueries[0].MetricStat.Period).toBe(60);
    expect(m.services.web).toEqual({ t: [1000, 2000], cpu: [10, 30], mem: [40, 60], periodSec: 60 });
    expect(m.cluster.cpu).toEqual([10, 30]);
    expect(m.note).toMatch(/average of its services/);
  });

  it('copies network settings from a service when running a one-off task', async () => {
    const ecs = fakeSender({
      DescribeServicesCommand: () => ({ services: [awsService({ platformVersion: 'LATEST' })] }),
      RunTaskCommand: (input) => ({ tasks: [awsTask('new', { taskDefinitionArn: input.taskDefinition, group: 'family:web' })] }),
    });
    const tasks = await new EcsApi(clients({ ecs })).runTask({ clusterArn: CLUSTER, taskDefinition: TD(7), count: 1, fromService: 'web', commandOverride: { container: 'app', command: ['npm', 'run', 'migrate'] } });
    const input = ecs.calls.find((c) => c.name === 'RunTaskCommand')!.input;
    expect(input).toMatchObject({ cluster: CLUSTER, launchType: 'FARGATE', platformVersion: 'LATEST', startedBy: 'k8sconsole', networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-0aaaaaaaaaaaaaaaa'] } }, overrides: { containerOverrides: [{ name: 'app', command: ['npm', 'run', 'migrate'] }] } });
    expect(tasks[0].id).toBe('new');
    await expect(new EcsApi(clients({ ecs })).runTask({ clusterArn: CLUSTER, taskDefinition: TD(7), count: 50 })).rejects.toThrow(/1 to 10/);
  });

  it('validates service updates before calling AWS', async () => {
    const ecs = fakeSender({ UpdateServiceCommand: (input) => ({ service: awsService({ desiredCount: input.desiredCount ?? 2 }) }) });
    const api = new EcsApi(clients({ ecs }));
    await expect(api.updateService(CLUSTER, 'web', {})).rejects.toThrow(/Nothing to change/);
    await expect(api.updateService(CLUSTER, 'web', { desiredCount: -1 })).rejects.toThrow(/whole number/);
    await expect(api.updateService(CLUSTER, 'web', { taskDefinition: 'not a revision' })).rejects.toThrow(/revision/);
    expect((await api.updateService(CLUSTER, 'web', { desiredCount: 3 })).desired).toBe(3);
    expect(ecs.calls).toHaveLength(1);
  });

  it('finds open ingress rules on the services security groups', async () => {
    const ec2 = fakeSender({
      DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: 'sg-0bbbbbbbbbbbbbbbb', GroupName: 'web', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }, { CidrIp: '10.0.0.0/8' }] }] }] }),
    });
    const sgs = await new EcsApi(clients({ ec2 })).securityGroups(['sg-0bbbbbbbbbbbbbbbb', 'not-an-sg']);
    expect(sgs).toEqual([{ id: 'sg-0bbbbbbbbbbbbbbbb', name: 'web', openIngress: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '0.0.0.0/0' }] }]);
    expect(ec2.calls[0].input.GroupIds).toEqual(['sg-0bbbbbbbbbbbbbbbb']);
  });
});

describe('AWS workspace', () => {
  const deps = (extra: Partial<ConstructorParameters<typeof AwsWorkspace>[0]> = {}) => ({
    home: '/nonexistent',
    version: 'test',
    emitStatus: vi.fn(),
    emitLogs: vi.fn(),
    findExecutable: (n: string) => (n === 'aws' ? '/usr/bin/aws' : n === 'session-manager-plugin' ? '/usr/bin/session-manager-plugin' : null),
    remember: vi.fn(),
    ...extra,
  });

  it('connects with injected clients, remembers the request and reports identity', async () => {
    const d = deps({ clients: () => clients({ sts: fakeSender({ GetCallerIdentityCommand: () => ({ Account: ACCT, Arn: `arn:aws:iam::${ACCT}:user/dev` }) }) }) });
    const w = new AwsWorkspace(d);
    const s = await w.connect({ mode: 'profile', profile: 'dev', region: 'eu-west-2' });
    expect(s).toMatchObject({ state: 'connected', account: ACCT });
    expect(d.remember).toHaveBeenCalledWith({ mode: 'profile', profile: 'dev', region: 'eu-west-2', readOnly: true });
    w.disconnect();
    expect(w.current().state).toBe('disconnected');
  });

  it('reports a failed connection as an error status', async () => {
    const w = new AwsWorkspace(deps({ clients: () => clients({ sts: fakeSender({ GetCallerIdentityCommand: () => Promise.reject(Object.assign(new Error('bad'), { name: 'InvalidClientTokenId' })) }) }) }));
    const s = await w.connect({ mode: 'default', region: 'eu-west-2' });
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/rejected the credentials/);
    expect(() => w.require()).toThrow(/Not connected/);
  });

  it('only offers ECS Exec on writable profile connections with the CLI and plugin', async () => {
    const ecs = fakeSender({ DescribeTasksCommand: () => ({ tasks: [awsTask('t1')] }) });
    const sts = fakeSender({ GetCallerIdentityCommand: () => ({ Account: ACCT, Arn: 'a' }) });
    const w = new AwsWorkspace(deps({ clients: (r) => clients({ ecs, sts }, r.readOnly) }));
    await w.connect({ mode: 'profile', profile: 'dev', region: 'eu-west-2' });
    expect((await w.execInfo(CLUSTER, awsTask('t1').taskArn, 'app')).reason).toMatch(/read-only/);
    await w.connect({ mode: 'profile', profile: 'dev', region: 'eu-west-2', readOnly: false });
    const info = await w.execInfo(CLUSTER, awsTask('t1').taskArn, 'app');
    expect(info.available).toBe(true);
    expect(info.command).toEqual(['/usr/bin/aws', 'ecs', 'execute-command', '--region', 'eu-west-2', '--profile', 'dev', '--cluster', CLUSTER, '--task', awsTask('t1').taskArn, '--container', 'app', '--interactive', '--command', '/bin/sh']);
    const noPlugin = new AwsWorkspace(deps({ findExecutable: (n: string) => (n === 'aws' ? '/usr/bin/aws' : null), clients: (r) => clients({ ecs, sts }, r.readOnly) }));
    await noPlugin.connect({ mode: 'profile', profile: 'dev', region: 'eu-west-2', readOnly: false });
    expect((await noPlugin.execInfo(CLUSTER, awsTask('t1').taskArn, 'app')).reason).toMatch(/Session Manager plugin/);
  });

  it('binds terminals to the profile and region without credentials', async () => {
    const ecs = fakeSender({
      ListServicesCommand: () => ({ serviceArns: [`arn:aws:ecs:eu-west-2:${ACCT}:service/prod/web`] }),
      DescribeServicesCommand: () => ({ services: [awsService()] }),
      DescribeTaskDefinitionCommand: () => ({ taskDefinition: { taskDefinitionArn: TD(7), containerDefinitions: [{ name: 'app', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/web' } } }] }, tags: [] }),
    });
    const sts = fakeSender({ GetCallerIdentityCommand: () => ({ Account: ACCT, Arn: 'a' }) });
    const w = new AwsWorkspace(deps({ clients: () => clients({ ecs, sts }) }));
    expect(await w.terminalExtras(CLUSTER)).toEqual({});
    await w.connect({ mode: 'profile', profile: 'dev', region: 'eu-west-2' });
    const x = await w.terminalExtras(CLUSTER);
    expect(x.env).toEqual({ AWS_REGION: 'eu-west-2', AWS_DEFAULT_REGION: 'eu-west-2', K8SC_AWS_REGION: 'eu-west-2', AWS_PROFILE: 'dev', K8SC_ECS_CLUSTER: 'prod' });
    expect(x.suggestions).toContain('aws ecs describe-services --cluster prod --services web');
    expect(x.suggestions).toContain('aws logs tail /ecs/web --follow');
  });

  it('only emits safe characters in aws suggestions', () => {
    const s = buildAwsSuggestions({ cluster: 'prod', services: ['web', 'bad;rm -rf', 'x$(id)'], logGroups: ['/ecs/a'] });
    expect(s.some((l) => l.includes(';') || l.includes('$'))).toBe(false);
    expect(s).toContain('aws ecs list-services --cluster prod');
  });
});
