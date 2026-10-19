import {
  AWS_REGIONS,
  arnName,
  isEcsArn,
  isValidEcsName,
  isValidProfileName,
  isValidRegion,
  isValidRoleArn,
  type AwsConnectRequest,
  type AwsConnectionStatus,
  type EcsExecInfo,
  type EcsLogChunk,
  type EcsRunTaskRequest,
  type EcsServiceUpdate,
} from '../../shared/ecs';
import { awsFiles, listProfiles } from './profiles';
import { createAwsClients, describeAwsError, type AwsClients } from './session';
import { EcsApi } from './ecs';
import { EcsLogTails } from './logs';
import { buildAwsSuggestions } from '../terminal-setup';
import type { TerminalExtras } from '../terminal';

export interface AwsWorkspaceDeps {
  home: string;
  version: string;
  emitStatus: (s: AwsConnectionStatus) => void;
  emitLogs: (c: EcsLogChunk) => void;
  findExecutable: (name: string) => string | null;
  /** Remembers the last connection (never includes credentials). */
  remember: (req: AwsConnectRequest) => void;
  /** Tests inject fake clients. */
  clients?: (req: AwsConnectRequest) => AwsClients;
}

/** Validates an untrusted connect request from the renderer. */
export function sanitizeConnectRequest(input: unknown): AwsConnectRequest {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const mode = r.mode === 'default' ? 'default' : 'profile';
  if (mode === 'profile' && !isValidProfileName(r.profile)) throw new Error('Choose an AWS profile');
  if (!isValidRegion(r.region)) throw new Error('Choose a valid AWS region');
  const assumeRoleArn = typeof r.assumeRoleArn === 'string' && r.assumeRoleArn.trim() ? r.assumeRoleArn.trim() : undefined;
  if (assumeRoleArn && !isValidRoleArn(assumeRoleArn)) throw new Error('The role ARN should look like arn:aws:iam::123456789012:role/name');
  const externalId = typeof r.externalId === 'string' && r.externalId.trim() ? r.externalId.trim() : undefined;
  if (externalId && !/^[\w+=,.@:/-]{2,1224}$/.test(externalId)) throw new Error('Invalid external ID');
  return { mode, profile: mode === 'profile' ? (r.profile as string) : undefined, region: r.region as string, assumeRoleArn, externalId: assumeRoleArn ? externalId : undefined, readOnly: r.readOnly !== false };
}

export class AwsWorkspace {
  private ecs: EcsApi | null = null;
  private request: AwsConnectRequest | null = null;
  private status: AwsConnectionStatus = { state: 'disconnected' };
  readonly logs: EcsLogTails;

  constructor(private readonly deps: AwsWorkspaceDeps) {
    this.logs = new EcsLogTails(deps.emitLogs);
  }

  private set(next: AwsConnectionStatus) {
    this.status = next;
    this.deps.emitStatus(next);
  }

  current(): AwsConnectionStatus {
    return this.status;
  }

  require(): EcsApi {
    if (!this.ecs) throw new Error('Not connected to AWS');
    return this.ecs;
  }

  profiles() {
    return {
      profiles: listProfiles(awsFiles(this.deps.home)),
      regions: [...AWS_REGIONS],
      cli: { aws: !!this.deps.findExecutable('aws'), sessionManagerPlugin: !!this.deps.findExecutable('session-manager-plugin') },
      envCredentials: !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_WEB_IDENTITY_TOKEN_FILE || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
    };
  }

  async connect(input: unknown): Promise<AwsConnectionStatus> {
    const req = sanitizeConnectRequest(input);
    this.disconnect();
    this.set({ state: 'connecting', request: req });
    try {
      const clients = this.deps.clients ? this.deps.clients(req) : createAwsClients(req, this.deps.version);
      const ecs = new EcsApi(clients);
      const id = await ecs.identity();
      this.ecs = ecs;
      this.request = req;
      this.deps.remember(req);
      this.set({ state: 'connected', request: req, account: id.account, arn: id.arn });
    } catch (err) {
      this.ecs = null;
      this.set({ state: 'error', request: req, error: describeAwsError(err, req) });
    }
    return this.status;
  }

  disconnect(): void {
    this.logs.stopAll();
    this.ecs = null;
    this.request = null;
    if (this.status.state !== 'disconnected') this.set({ state: 'disconnected' });
  }

  /** Environment and suggestions for a terminal opened while ECS is connected. Credentials are never placed in the environment. */
  async terminalExtras(cluster?: string): Promise<TerminalExtras> {
    const req = this.request;
    if (!req || !this.ecs) return {};
    const env: Record<string, string> = { AWS_REGION: req.region, AWS_DEFAULT_REGION: req.region, K8SC_AWS_REGION: req.region };
    if (req.mode === 'profile' && req.profile) env.AWS_PROFILE = req.profile;
    let services: string[] = [];
    let logGroups: string[] = [];
    let clusterName: string | undefined;
    if (cluster && (isEcsArn(cluster, 'cluster') || isValidEcsName(cluster))) {
      clusterName = arnName(cluster) || cluster;
      env.K8SC_ECS_CLUSTER = clusterName;
      try {
        const list = await this.ecs.listServices(cluster);
        services = list.map((s) => s.name);
        const groups = new Set<string>();
        for (const s of list.slice(0, 20)) {
          const { def } = await this.ecs.taskDefinition(s.taskDefinition);
          for (const c of def.containerDefinitions ?? []) if (c.logConfiguration?.logDriver === 'awslogs' && c.logConfiguration.options?.['awslogs-group']) groups.add(c.logConfiguration.options['awslogs-group']);
        }
        logGroups = [...groups];
      } catch {
        // suggestions are best effort
      }
    }
    return { env, suggestions: buildAwsSuggestions({ cluster: clusterName, services, logGroups }) };
  }

  /** Whether an ECS Exec shell can be opened for a task container, and the aws CLI command that opens it. */
  async execInfo(cluster: string, taskArn: string, container: string): Promise<EcsExecInfo> {
    const ecs = this.require();
    const req = this.request!;
    if (req.readOnly) return { available: false, reason: 'This connection is read-only. ECS Exec opens an interactive shell in a running container, so reconnect with read-only switched off to use it.' };
    if (req.assumeRoleArn) return { available: false, reason: 'ECS Exec runs through the aws CLI, which cannot reuse a role assumed by the app. Add a profile with role_arn to ~/.aws/config and connect with that profile.' };
    const aws = this.deps.findExecutable('aws');
    if (!aws) return { available: false, reason: 'The aws CLI v2 was not found on PATH.' };
    if (!this.deps.findExecutable('session-manager-plugin')) return { available: false, reason: 'The AWS Session Manager plugin is not installed. Install "session-manager-plugin" from AWS to use ECS Exec.' };
    const task = await ecs.getTask(cluster, taskArn);
    if (task.lastStatus !== 'RUNNING') return { available: false, reason: `The task is ${task.lastStatus.toLowerCase()}, not running.` };
    if (!task.enableExecuteCommand) return { available: false, reason: 'ECS Exec is not enabled for this task. Enable it on the service, then start new tasks (force a new deployment).' };
    const c = task.containers.find((x) => x.name === container);
    if (!c) return { available: false, reason: 'Container not found in this task.' };
    if (c.execAgent && c.execAgent !== 'RUNNING') return { available: false, reason: `The ECS Exec agent in this container is ${c.execAgent.toLowerCase()}.` };
    const command = [aws, 'ecs', 'execute-command', '--region', req.region, ...(req.profile ? ['--profile', req.profile] : []), '--cluster', task.clusterArn, '--task', task.arn, '--container', container, '--interactive', '--command', '/bin/sh'];
    return { available: true, command };
  }

  // Validation helpers shared by the IPC handlers.
  static cluster(v: unknown): string {
    const s = String(v ?? '');
    if (!isEcsArn(s, 'cluster') && !isValidEcsName(s)) throw new Error('Invalid cluster');
    return s;
  }

  static update(u: unknown): EcsServiceUpdate {
    const r = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
    const out: EcsServiceUpdate = {};
    if (r.desiredCount !== undefined) out.desiredCount = Number(r.desiredCount);
    if (typeof r.taskDefinition === 'string') out.taskDefinition = r.taskDefinition;
    if (r.forceNewDeployment === true) out.forceNewDeployment = true;
    if (typeof r.enableExecuteCommand === 'boolean') out.enableExecuteCommand = r.enableExecuteCommand;
    return out;
  }

  static runTask(r: unknown): EcsRunTaskRequest {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, any>;
    return {
      clusterArn: AwsWorkspace.cluster(x.clusterArn),
      taskDefinition: String(x.taskDefinition ?? ''),
      count: Number(x.count ?? 1),
      fromService: x.fromService && isValidEcsName(x.fromService) ? x.fromService : undefined,
      launchType: x.launchType === 'EC2' || x.launchType === 'EXTERNAL' ? x.launchType : x.launchType === 'FARGATE' ? 'FARGATE' : undefined,
      network: x.network && Array.isArray(x.network.subnets) ? { subnets: x.network.subnets.map(String), securityGroups: (x.network.securityGroups ?? []).map(String), assignPublicIp: x.network.assignPublicIp === 'ENABLED' ? 'ENABLED' : 'DISABLED' } : undefined,
      commandOverride: x.commandOverride && typeof x.commandOverride.container === 'string' && Array.isArray(x.commandOverride.command) ? { container: x.commandOverride.container, command: x.commandOverride.command.map(String) } : undefined,
      enableExecuteCommand: x.enableExecuteCommand === true,
    };
  }
}
