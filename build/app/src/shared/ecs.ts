// Amazon ECS: shared types and pure helpers (service map, security rules, log stream mapping).
// The renderer only ever receives these shapes; AWS credentials stay in the main process.
import type { ConnectionState } from './types';
import type { ResourceGraph, GraphNode, GraphEdge, NodeStatus } from './graph';

export const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1', 'sa-east-1', 'mx-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'me-south-1', 'me-central-1', 'il-central-1', 'af-south-1',
  'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-7',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-east-1', 'ap-east-2',
] as const;

export const isValidRegion = (r: unknown): r is string => typeof r === 'string' && /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(r);
export const isValidRoleArn = (a: unknown): a is string => typeof a === 'string' && /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(a);
export const isValidProfileName = (p: unknown): p is string => typeof p === 'string' && /^[\w.@+-]{1,128}$/.test(p);
/** ECS cluster/service/family names: letters, digits, hyphens and underscores (up to 255). */
export const isValidEcsName = (n: unknown): n is string => typeof n === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(n);
export const isEcsArn = (a: unknown, type: 'cluster' | 'service' | 'task' | 'task-definition' | 'container-instance'): a is string =>
  typeof a === 'string' && a.length < 2048 && new RegExp(`^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\\d{12}:${type}/[A-Za-z0-9_:/.-]+$`).test(a);

/** The last path segment of an ARN, e.g. a task id or `family:revision`. */
export const arnName = (arn: string | undefined): string => (arn ? arn.slice(arn.lastIndexOf('/') + 1) : '');

// ---- Connection ----

export type AwsProfileKind = 'static' | 'sso' | 'assume-role' | 'process' | 'web-identity' | 'unknown';

export interface AwsProfileInfo {
  name: string;
  region?: string;
  kind: AwsProfileKind;
  /** Role a profile assumes (an identifier, not a secret). */
  roleArn?: string;
}

export interface AwsConnectRequest {
  /** `profile`: a named profile from ~/.aws. `default`: the standard credential chain (environment, SSO cache, EC2/ECS IAM role). */
  mode: 'profile' | 'default';
  profile?: string;
  region: string;
  /** Optional IAM role assumed on top of the base credentials. */
  assumeRoleArn?: string;
  externalId?: string;
  /** When true every AWS call that changes state is refused in the main process. */
  readOnly: boolean;
}

export interface AwsConnectionStatus {
  state: ConnectionState;
  request?: AwsConnectRequest;
  account?: string;
  /** Caller identity ARN (user or assumed role). */
  arn?: string;
  error?: string;
}

// ---- ECS objects (sanitized views of the AWS API shapes) ----

export interface EcsCluster {
  arn: string;
  name: string;
  status: string;
  runningTasks: number;
  pendingTasks: number;
  activeServices: number;
  containerInstances: number;
  capacityProviders: string[];
  containerInsights?: string;
  execLogging?: string;
  tags: Record<string, string>;
}

export interface EcsDeployment {
  id: string;
  status: string;
  rolloutState?: string;
  rolloutReason?: string;
  taskDefinition: string;
  desired: number;
  running: number;
  pending: number;
  failed: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface EcsEvent {
  id: string;
  createdAt: number;
  message: string;
}

export interface EcsServiceLb {
  targetGroupArn?: string;
  loadBalancerName?: string;
  containerName?: string;
  containerPort?: number;
}

export interface EcsNetwork {
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: string;
}

export interface EcsService {
  arn: string;
  name: string;
  clusterArn: string;
  status: string;
  desired: number;
  running: number;
  pending: number;
  launchType?: string;
  capacityProviders: string[];
  platformVersion?: string;
  schedulingStrategy?: string;
  taskDefinition: string;
  deployments: EcsDeployment[];
  loadBalancers: EcsServiceLb[];
  serviceRegistries: number;
  network?: EcsNetwork;
  enableExecuteCommand: boolean;
  circuitBreaker?: { enable: boolean; rollback: boolean };
  minimumHealthyPercent?: number;
  maximumPercent?: number;
  deploymentController?: string;
  healthCheckGracePeriodSeconds?: number;
  createdAt?: number;
  events: EcsEvent[];
  tags: Record<string, string>;
}

export interface EcsContainer {
  name: string;
  image?: string;
  lastStatus?: string;
  exitCode?: number;
  reason?: string;
  health?: string;
  runtimeId?: string;
  cpu?: string;
  memory?: string;
  /** Status of the ECS Exec agent in this container (RUNNING when a shell can be opened). */
  execAgent?: string;
}

export interface EcsTask {
  arn: string;
  id: string;
  clusterArn: string;
  group?: string;
  serviceName?: string;
  taskDefinition: string;
  lastStatus: string;
  desiredStatus: string;
  health?: string;
  launchType?: string;
  capacityProvider?: string;
  cpu?: string;
  memory?: string;
  az?: string;
  privateIp?: string;
  eni?: string;
  containerInstanceArn?: string;
  createdAt?: number;
  startedAt?: number;
  stoppingAt?: number;
  stoppedAt?: number;
  stoppedReason?: string;
  stopCode?: string;
  enableExecuteCommand: boolean;
  containers: EcsContainer[];
}

export interface EcsContainerInstance {
  arn: string;
  ec2InstanceId?: string;
  status: string;
  agentConnected: boolean;
  runningTasks: number;
  pendingTasks: number;
  cpuRegistered?: number;
  cpuRemaining?: number;
  memRegistered?: number;
  memRemaining?: number;
  agentVersion?: string;
  capacityProvider?: string;
}

export interface EcsTaskDefinitionFamily {
  family: string;
  latestArn: string;
  latestRevision: number;
}

export interface EcsTargetHealth {
  targetGroupArn: string;
  targetGroupName: string;
  loadBalancers: string[];
  protocol?: string;
  port?: number;
  healthCheckPath?: string;
  targets: Array<{ id: string; port?: number; state: string; reason?: string; description?: string }>;
}

export interface EcsMetrics {
  /** Epoch ms, ascending. */
  t: number[];
  cpu: number[];
  mem: number[];
  periodSec: number;
}

export interface EcsServiceMetrics {
  cluster: EcsMetrics;
  services: Record<string, EcsMetrics>;
  note?: string;
}

export interface EcsLogEvent {
  t: number;
  message: string;
  stream: string;
}

export interface EcsLogChunk {
  streamId: string;
  events?: EcsLogEvent[];
  error?: string;
  /** True when the log source could not be resolved (e.g. no awslogs driver). */
  end?: boolean;
}

export interface EcsLogRequest {
  clusterArn: string;
  /** A task (single container) or a whole service (all its tasks). */
  taskArn?: string;
  serviceName?: string;
  container?: string;
  /** Look back this far for the first page. */
  sinceSeconds: number;
  follow: boolean;
  filterPattern?: string;
}

export interface EcsLogSource {
  group: string;
  region?: string;
  streamPrefix?: string;
  container: string;
}

export interface EcsRunTaskRequest {
  clusterArn: string;
  taskDefinition: string;
  count: number;
  /** Copy launch type, capacity providers and network settings from this service. */
  fromService?: string;
  launchType?: 'FARGATE' | 'EC2' | 'EXTERNAL';
  network?: EcsNetwork;
  /** Optional command override for one container. */
  commandOverride?: { container: string; command: string[] };
  enableExecuteCommand?: boolean;
}

export interface EcsServiceUpdate {
  desiredCount?: number;
  taskDefinition?: string;
  forceNewDeployment?: boolean;
  enableExecuteCommand?: boolean;
}

export interface EcsExecInfo {
  available: boolean;
  /** Why ECS Exec cannot start, in plain language. */
  reason?: string;
  command?: string[];
}

// ---- Status helpers ----

export function serviceStatus(s: Pick<EcsService, 'status' | 'desired' | 'running' | 'deployments'>): NodeStatus {
  if (s.status !== 'ACTIVE') return s.status === 'DRAINING' ? 'pending' : 'unknown';
  const primary = s.deployments.find((d) => d.status === 'PRIMARY');
  if (primary?.rolloutState === 'FAILED') return 'error';
  if (s.desired === 0) return 'done';
  if (s.running === 0) return 'error';
  if (s.running < s.desired || s.deployments.length > 1 || primary?.rolloutState === 'IN_PROGRESS') return 'warn';
  return 'ok';
}

export function taskStatus(t: Pick<EcsTask, 'lastStatus' | 'desiredStatus' | 'health' | 'stopCode' | 'containers'>): NodeStatus {
  if (t.lastStatus === 'STOPPED') {
    const failedContainer = t.containers.some((c) => c.exitCode !== undefined && c.exitCode !== 0);
    return t.stopCode === 'TaskFailedToStart' || t.stopCode === 'EssentialContainerExited' || failedContainer ? 'error' : 'done';
  }
  if (t.lastStatus !== 'RUNNING') return 'pending';
  if (t.health === 'UNHEALTHY') return 'error';
  if (t.desiredStatus === 'STOPPED') return 'pending';
  return 'ok';
}

/** Plain-language summary of a service's rollout, for tables and the overview. */
export function serviceSummary(s: EcsService): string {
  const primary = s.deployments.find((d) => d.status === 'PRIMARY');
  if (s.status !== 'ACTIVE') return s.status.toLowerCase();
  if (primary?.rolloutState === 'FAILED') return `rollout failed${primary.rolloutReason ? `: ${primary.rolloutReason}` : ''}`;
  if (s.deployments.length > 1 || primary?.rolloutState === 'IN_PROGRESS') return `deploying ${arnName(primary?.taskDefinition)}`;
  if (s.desired === 0) return 'scaled to zero';
  if (s.running < s.desired) return `${s.running} of ${s.desired} running`;
  return 'steady';
}

// ---- Logs ----

/**
 * Where a container's logs live. ECS writes awslogs streams as `<prefix>/<container>/<task id>`.
 * Returns null when the container does not use the awslogs driver (or FireLens forwarding to CloudWatch).
 */
export function logSourceFor(taskDefinition: any, container: string): EcsLogSource | null {
  const def = (taskDefinition?.containerDefinitions ?? []).find((c: any) => c?.name === container);
  const cfg = def?.logConfiguration;
  if (!cfg || cfg.logDriver !== 'awslogs') return null;
  const o = cfg.options ?? {};
  if (!o['awslogs-group']) return null;
  return { group: o['awslogs-group'], region: o['awslogs-region'], streamPrefix: o['awslogs-stream-prefix'], container };
}

/** The awslogs stream of one task's container; undefined when no stream prefix is set (ECS then names streams by container id). */
export function logStreamName(src: EcsLogSource, taskId: string): string | undefined {
  return src.streamPrefix ? `${src.streamPrefix}/${src.container}/${taskId}` : undefined;
}

// ---- Task definition editing ----

/** Fields returned by DescribeTaskDefinition that RegisterTaskDefinition does not accept. */
const READ_ONLY_TD_FIELDS = ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt', 'deleteRequested'];

/** Turns a described task definition (optionally edited by the user) into a RegisterTaskDefinition input. */
export function toRegisterInput(def: any, tags?: Array<{ key: string; value: string }>): Record<string, unknown> {
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('The task definition must be a JSON object');
  const src = def.taskDefinition && typeof def.taskDefinition === 'object' ? def.taskDefinition : def;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (!READ_ONLY_TD_FIELDS.includes(k) && v !== null && v !== undefined) out[k] = v;
  if (!isValidEcsName(out.family)) throw new Error('"family" is required (letters, digits, hyphens and underscores)');
  if (!Array.isArray(out.containerDefinitions) || out.containerDefinitions.length === 0) throw new Error('"containerDefinitions" must list at least one container');
  for (const c of out.containerDefinitions as any[]) {
    if (!c || typeof c !== 'object' || !c.name || !c.image) throw new Error('Every container needs a "name" and an "image"');
  }
  const t = tags ?? (Array.isArray(def.tags) ? def.tags : undefined);
  if (t?.length) out.tags = t;
  return out;
}

const SECRET_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth|dsn|conn(ection)?[_-]?str/i;

/** A copy safe to send to the AI assistant: environment values and secret references are removed. */
export function redactTaskDefinition(def: any): any {
  const copy = structuredClone(def ?? {});
  for (const c of copy.containerDefinitions ?? []) {
    if (Array.isArray(c.environment)) c.environment = c.environment.map((e: any) => ({ name: e.name, value: '[redacted]' }));
    if (Array.isArray(c.secrets)) c.secrets = c.secrets.map((e: any) => ({ name: e.name, valueFrom: '[reference]' }));
    if (c.repositoryCredentials) c.repositoryCredentials = { credentialsParameter: '[reference]' };
  }
  return copy;
}

// ---- Service map ----

export const ecsNodeId = (kind: string, name: string) => `${kind}//${name}`;

export interface EcsMapInput {
  services: EcsService[];
  tasks: EcsTask[];
  targets: EcsTargetHealth[];
}

/** Load balancer → target group → service → tasks, with the task definition revision and security groups each uses. */
export function buildEcsGraph({ services, tasks, targets }: EcsMapInput): ResourceGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const edge = (from: string, to: string, type: GraphEdge['type']) => {
    if (!edges.some((e) => e.from === from && e.to === to && e.type === type)) edges.push({ from, to, type });
  };
  const tgByArn = new Map(targets.map((t) => [t.targetGroupArn, t]));
  for (const s of services) {
    const sid = add({ id: ecsNodeId('EcsService', s.name), kind: 'EcsService', apiVersion: 'ecs', name: s.name, status: serviceStatus(s), detail: `${s.running}/${s.desired} running · ${serviceSummary(s)}` });
    const tdName = arnName(s.taskDefinition);
    edge(sid, add({ id: ecsNodeId('TaskDefinition', tdName), kind: 'TaskDefinition', apiVersion: 'ecs', name: tdName, status: 'ok' }), 'uses');
    for (const d of s.deployments) {
      if (d.taskDefinition === s.taskDefinition) continue;
      const old = arnName(d.taskDefinition);
      edge(sid, add({ id: ecsNodeId('TaskDefinition', old), kind: 'TaskDefinition', apiVersion: 'ecs', name: old, status: 'pending', detail: `${d.status.toLowerCase()} deployment` }), 'uses');
    }
    for (const lb of s.loadBalancers) {
      if (!lb.targetGroupArn) continue;
      const tg = tgByArn.get(lb.targetGroupArn);
      const tgName = tg?.targetGroupName ?? arnName(lb.targetGroupArn.replace(/\/[0-9a-f]+$/, ''));
      const healthy = tg ? tg.targets.filter((x) => x.state === 'healthy').length : undefined;
      const tgStatus: NodeStatus = !tg ? 'unknown' : tg.targets.length === 0 ? (s.desired === 0 ? 'done' : 'warn') : healthy === tg.targets.length ? 'ok' : healthy === 0 ? 'error' : 'warn';
      const tgId = add({ id: ecsNodeId('TargetGroup', tgName), kind: 'TargetGroup', apiVersion: 'elbv2', name: tgName, status: tgStatus, detail: tg ? `${healthy}/${tg.targets.length} healthy · ${lb.containerName}:${lb.containerPort}` : undefined });
      edge(tgId, sid, 'routes');
      for (const lbName of tg?.loadBalancers ?? []) edge(add({ id: ecsNodeId('LoadBalancer', lbName), kind: 'LoadBalancer', apiVersion: 'elbv2', name: lbName, status: 'ok' }), tgId, 'routes');
    }
    for (const sg of s.network?.securityGroups ?? []) edge(add({ id: ecsNodeId('SecurityGroup', sg), kind: 'SecurityGroup', apiVersion: 'ec2', name: sg, status: 'ok' }), sid, 'guards');
  }
  const byService = new Map<string, EcsTask[]>();
  for (const t of tasks) {
    const key = t.serviceName ?? '';
    (byService.get(key) ?? byService.set(key, []).get(key)!).push(t);
  }
  for (const [svc, list] of byService) {
    const shown = list.filter((t) => t.lastStatus !== 'STOPPED').slice(0, 8);
    const stopped = list.filter((t) => t.lastStatus === 'STOPPED');
    for (const t of shown) {
      const tid = add({ id: ecsNodeId('Task', t.id), kind: 'Task', apiVersion: 'ecs', name: t.id, status: taskStatus(t), detail: `${t.lastStatus.toLowerCase()}${t.health && t.health !== 'UNKNOWN' ? ` · ${t.health.toLowerCase()}` : ''} · ${arnName(t.taskDefinition)}` });
      if (svc) edge(ecsNodeId('EcsService', svc), tid, 'owns');
      else edge(tid, add({ id: ecsNodeId('TaskDefinition', arnName(t.taskDefinition)), kind: 'TaskDefinition', apiVersion: 'ecs', name: arnName(t.taskDefinition), status: 'ok' }), 'uses');
    }
    const failed = stopped.filter((t) => taskStatus(t) === 'error');
    if (svc && failed.length) {
      const id = add({ id: ecsNodeId('Task', `${svc}-stopped`), kind: 'Task', apiVersion: 'ecs', name: `${failed.length} failed task${failed.length > 1 ? 's' : ''}`, status: 'error', detail: failed[0].stoppedReason });
      edge(ecsNodeId('EcsService', svc), id, 'owns');
    }
    const hidden = list.length - shown.length - stopped.length;
    if (hidden > 0 && svc) {
      const id = add({ id: ecsNodeId('Task', `${svc}-more`), kind: 'Task', apiVersion: 'ecs', name: `+${hidden} more tasks`, status: 'ok' });
      edge(ecsNodeId('EcsService', svc), id, 'owns');
    }
  }
  // Drop edges that point at nodes we never created (e.g. tasks of services outside the selection).
  return { nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) };
}

// ---- Security scan ----

export type EcsSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface EcsFinding {
  id: string;
  rule: string;
  severity: EcsSeverity;
  title: string;
  /** What the finding is about, e.g. `service web` or `task definition web:12 / container app`. */
  target: string;
  targetKind: 'cluster' | 'service' | 'task-definition' | 'security-group';
  targetName: string;
  detail: string;
  remediation: string;
}

export interface EcsSecurityGroupInfo {
  id: string;
  name?: string;
  /** Ingress rules open to the internet. */
  openIngress: Array<{ protocol: string; fromPort?: number; toPort?: number; cidr: string }>;
}

export interface EcsScanInput {
  cluster: EcsCluster;
  services: EcsService[];
  /** Task definitions in use, keyed by ARN. */
  taskDefinitions: Record<string, any>;
  securityGroups: EcsSecurityGroupInfo[];
}

export interface EcsScanReport {
  score: number;
  findings: EcsFinding[];
  counts: Record<EcsSeverity, number>;
  scanned: { services: number; taskDefinitions: number; securityGroups: number };
}

const WEIGHT: Record<EcsSeverity, number> = { critical: 20, high: 10, medium: 4, low: 1 };

export function scanEcs({ cluster, services, taskDefinitions, securityGroups }: EcsScanInput): EcsScanReport {
  const findings: EcsFinding[] = [];
  const ids = new Map<string, number>();
  const push = (f: Omit<EcsFinding, 'id'>) => {
    const base = `${f.rule}:${f.targetKind}:${f.target}`;
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    findings.push({ ...f, id: n > 1 ? `${base}#${n}` : base });
  };

  if (cluster.containerInsights !== 'enabled' && cluster.containerInsights !== 'enhanced') {
    push({ rule: 'cluster-insights', severity: 'low', title: 'Container Insights is off', target: `cluster ${cluster.name}`, targetKind: 'cluster', targetName: cluster.name, detail: 'Task-level CPU, memory, network and restart metrics are not collected.', remediation: 'Enable Container Insights in the cluster settings (it adds CloudWatch cost).' });
  }

  for (const s of services) {
    if (s.network?.assignPublicIp === 'ENABLED') {
      push({ rule: 'public-ip', severity: s.loadBalancers.length ? 'medium' : 'high', title: 'Tasks get public IP addresses', target: `service ${s.name}`, targetKind: 'service', targetName: s.name, detail: `Every task has a public IP${s.loadBalancers.length ? ' even though traffic arrives through a load balancer' : ''}. Only the security group stands between the task and the internet.`, remediation: 'Run tasks in private subnets with assignPublicIp DISABLED, and reach the internet through a NAT gateway or VPC endpoints.' });
    }
    if (s.deploymentController !== 'CODE_DEPLOY' && s.deploymentController !== 'EXTERNAL' && !s.circuitBreaker?.enable) {
      push({ rule: 'circuit-breaker', severity: 'low', title: 'No deployment circuit breaker', target: `service ${s.name}`, targetKind: 'service', targetName: s.name, detail: 'A broken deployment keeps replacing failing tasks instead of stopping and rolling back.', remediation: 'Turn on the deployment circuit breaker with rollback.' });
    }
    if (s.enableExecuteCommand) {
      push({ rule: 'exec-enabled', severity: 'low', title: 'ECS Exec is enabled', target: `service ${s.name}`, targetKind: 'service', targetName: s.name, detail: 'Anyone with ecs:ExecuteCommand on this cluster can open a shell inside the running containers.', remediation: 'Keep it on only where needed, restrict ecs:ExecuteCommand in IAM and enable exec session logging on the cluster.' });
    }
    if (s.desired > 0 && s.desired < 2 && s.schedulingStrategy !== 'DAEMON') {
      push({ rule: 'single-task', severity: 'low', title: 'Runs a single task', target: `service ${s.name}`, targetKind: 'service', targetName: s.name, detail: 'One task means downtime whenever it is replaced or its Availability Zone has a problem.', remediation: 'Run at least two tasks spread across Availability Zones.' });
    }
  }

  for (const [arn, td] of Object.entries(taskDefinitions)) {
    const tdName = arnName(arn);
    const tdTarget = (c?: string) => `task definition ${tdName}${c ? ` / container ${c}` : ''}`;
    if (td?.networkMode === 'host') {
      push({ rule: 'host-network', severity: 'high', title: 'Uses the host network', target: tdTarget(), targetKind: 'task-definition', targetName: tdName, detail: 'Containers share the instance network stack and can reach the instance metadata service directly.', remediation: 'Use the awsvpc network mode.' });
    }
    if (td?.pidMode === 'host' || td?.ipcMode === 'host') {
      push({ rule: 'host-namespaces', severity: 'high', title: 'Shares host process or IPC namespaces', target: tdTarget(), targetKind: 'task-definition', targetName: tdName, detail: 'Containers can see or signal processes on the host.', remediation: 'Remove pidMode/ipcMode "host".' });
    }
    if (!td?.taskRoleArn && (td?.containerDefinitions ?? []).some((c: any) => (c.environment ?? []).some((e: any) => /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)$/.test(e?.name)))) {
      push({ rule: 'static-aws-keys', severity: 'critical', title: 'AWS access keys in the environment', target: tdTarget(), targetKind: 'task-definition', targetName: tdName, detail: 'Long-lived AWS keys are stored in plain text in the task definition, readable by anyone who can describe it.', remediation: 'Remove the keys, rotate them, and give the task an IAM task role instead.' });
    }
    for (const c of td?.containerDefinitions ?? []) {
      const name = String(c?.name ?? '');
      if (c?.privileged) push({ rule: 'privileged', severity: 'critical', title: 'Privileged container', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: 'The container has full access to the host devices and kernel capabilities.', remediation: 'Set "privileged": false and add only the Linux capabilities it needs.' });
      const user = String(c?.user ?? '');
      if (!user || user === 'root' || user === '0' || user.startsWith('0:')) push({ rule: 'runs-as-root', severity: 'medium', title: 'Runs as root', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: user ? 'The container user is root.' : 'No user is set, so the image default applies, which is root for most images.', remediation: 'Set "user" to a non-root UID (and build the image to run as that user).' });
      if (!c?.readonlyRootFilesystem) push({ rule: 'writable-root', severity: 'low', title: 'Writable root filesystem', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: 'An attacker who gets code execution can modify the container filesystem.', remediation: 'Set "readonlyRootFilesystem": true and mount writable volumes only where needed.' });
      const plain = (c?.environment ?? []).filter((e: any) => SECRET_NAME.test(String(e?.name ?? '')) && e?.value && !/^arn:aws/.test(String(e.value)));
      if (plain.length) push({ rule: 'plaintext-secret', severity: 'high', title: 'Secrets in plain environment variables', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: `${plain.map((e: any) => e.name).join(', ')} ${plain.length > 1 ? 'look' : 'looks'} like secret${plain.length > 1 ? 's' : ''} but ${plain.length > 1 ? 'are' : 'is'} stored as plain text.`, remediation: 'Move the values to Secrets Manager or SSM Parameter Store and reference them under "secrets".' });
      if (!c?.logConfiguration) push({ rule: 'no-logging', severity: 'medium', title: 'No log configuration', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: 'Container output is not collected, so crashes leave no trace.', remediation: 'Configure the awslogs (or FireLens) log driver.' });
      if (c?.essential !== false && !c?.healthCheck) push({ rule: 'no-healthcheck', severity: 'low', title: 'No container health check', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: 'ECS only knows whether the process is running, not whether it is serving.', remediation: 'Add a "healthCheck" command.' });
      const image = String(c?.image ?? '');
      const tag = image.includes('@') ? 'digest' : image.slice(image.lastIndexOf('/') + 1).split(':')[1];
      if (!tag || tag === 'latest') push({ rule: 'mutable-tag', severity: 'medium', title: 'Image uses a moving tag', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: `"${image}" ${tag ? 'uses :latest' : 'has no tag'}, so a restart can silently run different code.`, remediation: 'Pin a version tag or an image digest.' });
      const caps: string[] = c?.linuxParameters?.capabilities?.add ?? [];
      const risky = caps.filter((x) => ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'ALL'].includes(String(x).toUpperCase()));
      if (risky.length) push({ rule: 'dangerous-capabilities', severity: 'high', title: 'Dangerous Linux capabilities', target: tdTarget(name), targetKind: 'task-definition', targetName: tdName, detail: `Adds ${risky.join(', ')}.`, remediation: 'Remove capabilities the container does not strictly need.' });
    }
  }

  for (const sg of securityGroups) {
    for (const r of sg.openIngress) {
      const all = r.protocol === '-1' || (r.fromPort === 0 && r.toPort === 65535);
      const web = r.fromPort !== undefined && r.fromPort === r.toPort && (r.fromPort === 80 || r.fromPort === 443);
      if (web) continue;
      const ports = all ? 'all ports' : r.fromPort === r.toPort ? `port ${r.fromPort}` : `ports ${r.fromPort}-${r.toPort}`;
      push({ rule: 'open-ingress', severity: all ? 'critical' : 'high', title: `Open to the internet on ${ports}`, target: `security group ${sg.id}${sg.name ? ` (${sg.name})` : ''}`, targetKind: 'security-group', targetName: sg.id, detail: `Inbound ${r.protocol === '-1' ? 'all traffic' : r.protocol.toUpperCase()} from ${r.cidr} on ${ports}.`, remediation: 'Allow only the load balancer security group (or specific address ranges) to reach the tasks.' });
    }
  }

  const order: EcsSeverity[] = ['critical', 'high', 'medium', 'low'];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.target.localeCompare(b.target));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<EcsSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  const units = Math.max(1, services.length + Object.keys(taskDefinitions).length);
  const penalty = findings.reduce((a, f) => a + WEIGHT[f.severity], 0) / units;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty * 2.5)));
  return { score, findings, counts, scanned: { services: services.length, taskDefinitions: Object.keys(taskDefinitions).length, securityGroups: securityGroups.length } };
}

/** Average of several series on the union of their timestamps (NaN gaps are skipped). */
export function averageSeries(list: EcsMetrics[], periodSec: number): EcsMetrics {
  const ts = [...new Set(list.flatMap((m) => m.t))].sort((a, b) => a - b);
  const avg = (pick: (m: EcsMetrics) => number[]) =>
    ts.map((t) => {
      const vals = list.map((m) => pick(m)[m.t.indexOf(t)]).filter((v) => Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    });
  return { t: ts, cpu: avg((m) => m.cpu), mem: avg((m) => m.mem), periodSec };
}

/** Is this command allowed while the connection is read-only? Only describe/list/get style calls are. */
export function isReadOnlyCommand(commandName: string): boolean {
  return /^(Describe|List|Get|Filter|Lookup|Search|BatchGet)[A-Z]/.test(commandName.replace(/Command$/, ''));
}
