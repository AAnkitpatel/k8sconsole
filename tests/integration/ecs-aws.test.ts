// Integration tests against a real AWS account (opt-in).
//
//   K8SC_AWS_PROFILE=<profile> K8SC_AWS_REGION=<region> npx vitest run --project integration tests/integration/ecs-aws.test.ts
//
// The read suite connects read-only and only describes/lists. The write suite runs only when
// K8SC_AWS_WRITE_CLUSTER names the one cluster ARN approved for write tests AND K8SC_AWS_WRITE_CONFIRM is
// "create-and-delete-selftest-resources". It creates and then deletes its own resources (named k8sconsole-selftest-*),
// and checks that every pre-existing service in that cluster is unchanged afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeleteTaskDefinitionsCommand, DescribeServicesCommand, ListServicesCommand, ListTaskDefinitionsCommand } from '@aws-sdk/client-ecs';
import { createAwsClients, ReadOnlyError } from '../../build/app/src/main/aws/session';
import { EcsApi } from '../../build/app/src/main/aws/ecs';
import { EcsLogTails } from '../../build/app/src/main/aws/logs';
import { SsmSession } from '../../build/app/src/main/aws/ssm-session';
import { arnName, type EcsLogChunk } from '../../build/app/src/shared/ecs';

const PROFILE = process.env.K8SC_AWS_PROFILE;
const REGION = process.env.K8SC_AWS_REGION ?? 'eu-west-2';
const WRITE_CONFIRMED = process.env.K8SC_AWS_WRITE_CONFIRM === 'create-and-delete-selftest-resources';
const WRITE_CLUSTER = WRITE_CONFIRMED ? process.env.K8SC_AWS_WRITE_CLUSTER : undefined;
const PREFIX = 'k8sconsole-selftest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 240_000, everyMs = 6000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

describe.skipIf(!PROFILE)('Amazon ECS (read-only, live AWS)', () => {
  const api = new EcsApi(createAwsClients({ mode: 'profile', profile: PROFILE!, region: REGION, readOnly: true }, 'test'));

  it('reads identity, clusters, services, tasks, task definitions, metrics, targets, map and scan', async () => {
    const id = await api.identity();
    expect(id.account).toMatch(/^\d{12}$/);
    const clusters = await api.listClusters();
    expect(clusters.length).toBeGreaterThan(0);
    const busiest = [...clusters].sort((a, b) => b.activeServices - a.activeServices)[0];
    const services = await api.listServices(busiest.arn);
    // Counts can move while deployments run, so allow a small difference.
    expect(Math.abs(services.length - busiest.activeServices)).toBeLessThanOrEqual(1);
    const tasks = await api.listTasks(busiest.arn, { desiredStatus: 'RUNNING' });
    expect(Math.abs(tasks.length - busiest.runningTasks)).toBeLessThanOrEqual(3);
    const fams = await api.listTaskDefinitionFamilies();
    expect(fams.length).toBeGreaterThan(0);
    const td = await api.taskDefinition(services[0].taskDefinition);
    expect(td.def.taskDefinitionArn).toBe(services[0].taskDefinition);
    const m = await api.metrics(busiest, services.map((s) => s.name), 60);
    expect(Object.keys(m.services)).toEqual(services.map((s) => s.name));
    const withTasks = services.filter((s) => s.running > 0);
    if (withTasks.length) expect(withTasks.some((s) => m.services[s.name].t.length > 0)).toBe(true);
    const targets = await api.targetHealth(services);
    expect(targets.length).toBe(new Set(services.flatMap((s) => s.loadBalancers.map((l) => l.targetGroupArn).filter(Boolean))).size);
    const map = await api.serviceMap(busiest.arn);
    expect(map.nodes.filter((n) => n.kind === 'EcsService')).toHaveLength(services.length);
    const scan = await api.scan(busiest.arn);
    expect(scan.scanned.services).toBe(services.length);
    expect(scan.score).toBeGreaterThanOrEqual(0);
  });

  it('streams CloudWatch logs of a running task', async () => {
    const clusters = await api.listClusters();
    let found: { cluster: string; task: string } | null = null;
    for (const c of clusters.filter((x) => x.runningTasks > 0)) {
      for (const t of await api.listTasks(c.arn, { desiredStatus: 'RUNNING' })) {
        if ((await api.logSources(t)).length) {
          found = { cluster: c.arn, task: t.arn };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return; // nothing running with awslogs in this region
    const chunks: EcsLogChunk[] = [];
    const tails = new EcsLogTails((c) => chunks.push(c));
    await tails.start(api, { clusterArn: found.cluster, taskArn: found.task, sinceSeconds: 7 * 86400, follow: false });
    await until('log page', async () => chunks.some((c) => c.end), 60_000, 500);
    expect(chunks.some((c) => c.error && !/No log stream yet/.test(c.error))).toBe(false);
  });

  it('refuses writes on a read-only connection', async () => {
    const clusters = await api.listClusters();
    const c = clusters.find((x) => x.activeServices > 0)!;
    const s = (await api.listServices(c.arn))[0];
    await expect(api.updateService(c.arn, s.name, { forceNewDeployment: true })).rejects.toBeInstanceOf(ReadOnlyError);
  });
});

describe.skipIf(!PROFILE || !WRITE_CLUSTER)('Amazon ECS writes (live AWS, approved cluster only)', () => {
  if (WRITE_CLUSTER && !/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/.test(WRITE_CLUSTER)) throw new Error('K8SC_AWS_WRITE_CLUSTER must be a full cluster ARN');
  const clients = createAwsClients({ mode: 'profile', profile: PROFILE!, region: REGION, readOnly: false }, 'test');
  const api = new EcsApi(clients);
  const cluster = WRITE_CLUSTER!;
  const family = `${PREFIX}-task`;
  const service = `${PREFIX}-svc`;
  const registered: string[] = [];
  let before: string;

  /** Everything that would show if a pre-existing service had been touched. */
  async function existingServicesFingerprint(): Promise<string> {
    const list = await clients.ecs.send(new ListServicesCommand({ cluster, maxResults: 100 }));
    const arns = (list.serviceArns ?? []).filter((a: string) => !arnName(a).startsWith(PREFIX));
    const d = await clients.ecs.send(new DescribeServicesCommand({ cluster, services: arns }));
    return JSON.stringify(
      (d.services ?? [])
        .map((s: any) => ({ n: s.serviceName, desired: s.desiredCount, td: s.taskDefinition, deployments: (s.deployments ?? []).map((x: any) => `${x.id}:${x.status}:${x.updatedAt?.toISOString()}`), exec: s.enableExecuteCommand }))
        .sort((a: any, b: any) => a.n.localeCompare(b.n)),
    );
  }

  beforeAll(async () => {
    before = await existingServicesFingerprint();
  });

  afterAll(async () => {
    // Clean up everything this suite created, even after a failure.
    try {
      const s = await api.getService(cluster, service).catch(() => null);
      if (s && s.status === 'ACTIVE') await api.deleteService(cluster, service, true);
    } catch (err) {
      console.error('cleanup: delete service failed', err);
    }
    for (const t of await api.listTasks(cluster, { desiredStatus: 'RUNNING' }).catch(() => [])) {
      if (arnName(t.taskDefinition).startsWith(`${family}:`)) await api.stopTask(cluster, t.arn, 'k8sconsole self-test cleanup').catch(() => undefined);
    }
    for (const arn of registered) {
      await api.deregisterTaskDefinition(arn).catch(() => undefined);
    }
    if (registered.length) await clients.ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: registered })).catch((err: unknown) => console.error('cleanup: delete task definitions failed', err));
    const after = await existingServicesFingerprint();
    expect(after).toBe(before);
  }, 300_000);

  it('registers a task definition, creates, scales, stops, runs and deletes its own service', async () => {
    // Reuse the network settings of an existing Fargate service (read only) so the task can start.
    const template = (await api.listServices(cluster)).find((s) => !s.name.startsWith(PREFIX) && s.launchType === 'FARGATE' && s.network);
    expect(template, 'a Fargate service to copy network settings from').toBeTruthy();

    const reg = await api.registerTaskDefinition(
      JSON.stringify({
        family,
        requiresCompatibilities: ['FARGATE'],
        networkMode: 'awsvpc',
        cpu: '256',
        memory: '512',
        containerDefinitions: [{ name: 'sleep', image: 'public.ecr.aws/docker/library/busybox:1.36', command: ['sleep', '900'], essential: true }],
        tags: [{ key: 'purpose', value: 'k8sconsole-self-test' }],
      }),
    );
    registered.push(reg.arn);
    expect(arnName(reg.arn)).toBe(`${family}:${reg.revision}`);

    const created = await api.createService(
      cluster,
      JSON.stringify({
        serviceName: service,
        taskDefinition: reg.arn,
        desiredCount: 0,
        launchType: 'FARGATE',
        networkConfiguration: { awsvpcConfiguration: { subnets: template!.network!.subnets, securityGroups: template!.network!.securityGroups, assignPublicIp: 'ENABLED' } },
        deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: false }, minimumHealthyPercent: 0, maximumPercent: 100 },
        tags: [{ key: 'purpose', value: 'k8sconsole-self-test' }],
      }),
    );
    expect(created).toMatchObject({ name: service, desired: 0, status: 'ACTIVE' });

    // Scale up and wait for the task to run.
    await api.updateService(cluster, service, { desiredCount: 1 });
    const first = await until('task running', async () => (await api.listTasks(cluster, { serviceName: service, desiredStatus: 'RUNNING' })).find((t) => t.lastStatus === 'RUNNING'));
    expect(first.serviceName).toBe(service);

    // Stop it: the service scheduler must replace it.
    await api.stopTask(cluster, first.arn, 'k8sconsole self-test: replacement check');
    const replacement = await until('replacement task', async () => (await api.listTasks(cluster, { serviceName: service, desiredStatus: 'RUNNING' })).find((t) => t.arn !== first.arn));
    expect(replacement.arn).not.toBe(first.arn);
    const stopped = await api.getTask(cluster, first.arn);
    expect(stopped.desiredStatus).toBe('STOPPED');

    // One-off task copied from the service's network settings, with a command override.
    const [oneOff] = await api.runTask({ clusterArn: cluster, taskDefinition: reg.arn, count: 1, fromService: service, commandOverride: { container: 'sleep', command: ['sleep', '60'] } });
    expect(oneOff.group).toBe(`family:${family}`);
    await api.stopTask(cluster, oneOff.arn, 'k8sconsole self-test');

    // Events and the service map include the self-test service.
    const map = await api.serviceMap(cluster, service);
    expect(map.nodes.some((n) => n.kind === 'EcsService' && n.name === service)).toBe(true);

    // Scale to zero and delete.
    await api.updateService(cluster, service, { desiredCount: 0 });
    await api.deleteService(cluster, service, false);
    const gone = await api.getService(cluster, service);
    expect(['DRAINING', 'INACTIVE']).toContain(gone.status);
  }, 600_000);
});

// Live ECS Exec through the built-in Session Manager client (no aws CLI / plugin).
// Requires the approved write cluster plus a task role that allows ECS Exec (ssmmessages:*): K8SC_AWS_EXEC_TASK_ROLE.
const EXEC_ROLE = process.env.K8SC_AWS_EXEC_TASK_ROLE;
describe.skipIf(!PROFILE || !WRITE_CLUSTER || !EXEC_ROLE)('ECS Exec, built-in client (live AWS, approved cluster only)', () => {
  const clients = createAwsClients({ mode: 'profile', profile: PROFILE!, region: REGION, readOnly: false }, 'test');
  const api = new EcsApi(clients);
  const cluster = WRITE_CLUSTER!;
  const family = `${PREFIX}-task`;
  const registered: string[] = [];
  let taskArn: string | undefined;

  afterAll(async () => {
    if (taskArn) await api.stopTask(cluster, taskArn, 'k8sconsole exec self-test cleanup').catch(() => undefined);
    // Remove every revision of the self-test family (including leftovers from earlier runs).
    const all = (await clients.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: 'ACTIVE' }))).taskDefinitionArns ?? [];
    for (const arn of all) await api.deregisterTaskDefinition(arn).catch(() => undefined);
    const inactive = (await clients.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: 'INACTIVE' }))).taskDefinitionArns ?? [];
    if (inactive.length) await clients.ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: inactive.slice(0, 10) })).catch((err: unknown) => console.error('cleanup: delete task definitions failed', err));
  }, 300_000);

  it('opens a shell in a running task and round-trips commands', async () => {
    const before = JSON.stringify((await api.listServices(cluster)).map((s) => [s.name, s.desired, s.taskDefinition, s.deployments.map((d) => d.id)]));
    const template = (await api.listServices(cluster)).find((s) => !s.name.startsWith(PREFIX) && s.launchType === 'FARGATE' && s.network);
    const reg = await api.registerTaskDefinition(
      JSON.stringify({ family, taskRoleArn: EXEC_ROLE, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '256', memory: '512', containerDefinitions: [{ name: 'shell', image: 'public.ecr.aws/docker/library/busybox:1.36', command: ['sleep', '900'], essential: true, linuxParameters: { initProcessEnabled: true } }] }),
    );
    registered.push(reg.arn);
    const [t] = await api.runTask({ clusterArn: cluster, taskDefinition: reg.arn, count: 1, launchType: 'FARGATE', network: { subnets: template!.network!.subnets, securityGroups: template!.network!.securityGroups, assignPublicIp: 'ENABLED' }, enableExecuteCommand: true });
    taskArn = t.arn;
    await until('exec agent running', async () => {
      const task = await api.getTask(cluster, t.arn);
      return task.lastStatus === 'RUNNING' && task.containers[0]?.execAgent === 'RUNNING' ? task : undefined;
    }, 300_000, 8000);

    const session = await api.executeCommand(cluster, t.arn, 'shell', '/bin/sh');
    let out = '';
    let closed: string | undefined | null = null;
    const ssm = new SsmSession({ streamUrl: session.streamUrl, token: session.tokenValue, cols: 120, rows: 40, onData: (d) => (out += d), onClose: (e) => (closed = e ?? '') }).start();
    await until('shell prompt', async () => out.length > 0 || closed !== null, 60_000, 500);
    expect(closed).toBeNull();
    ssm.input('echo K8SC-$((6*7))\n');
    await until('command output', async () => /K8SC-42/.test(out), 30_000, 300);
    ssm.resize(160, 50);
    ssm.input('stty size; uname -s\n');
    await until('resize + uname', async () => /50 160/.test(out) && /Linux/.test(out), 30_000, 300);
    ssm.input('exit\n');
    await until('session closed by exit', async () => closed !== null, 30_000, 300);
    expect(closed).toBe('');
    const after = JSON.stringify((await api.listServices(cluster)).map((s) => [s.name, s.desired, s.taskDefinition, s.deployments.map((d) => d.id)]));
    expect(after).toBe(before);
  }, 600_000);
});
