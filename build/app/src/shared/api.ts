import type { ResourceGraph } from './graph';
import type { Finding, SecurityReport } from './security';
import type { EffectiveRule, Subject, WhoCanEntry } from './rbac';
import type { GitOpsAction, GitOpsItem } from './gitops';
import type { CostReport, EcsCostLine } from './cost';
import type { ImageScan, ImageUse } from './images';
import type { ExtFinding, InstalledExtension } from './extensions';
import type {
  AwsConnectRequest,
  AwsConnectionStatus,
  AwsProfileInfo,
  EcsCluster,
  EcsContainerInstance,
  EcsEvent,
  EcsExecInfo,
  EcsLogChunk,
  EcsLogRequest,
  EcsLogSource,
  EcsRunTaskRequest,
  EcsScanReport,
  EcsService,
  EcsServiceMetrics,
  EcsServiceUpdate,
  EcsTargetHealth,
  EcsTask,
  EcsTaskDefinitionFamily,
} from './ecs';
import type {
  ApiResourceInfo,
  AssistantEvent,
  AssistantStatus,
  HelmChartVersion,
  HelmInstallRequest,
  HelmInstallResult,
  HelmRepo,
  AppSettings,
  ApplyResult,
  ClusterContext,
  ConnectionStatus,
  ExecRequest,
  HelmHistoryEntry,
  HelmRelease,
  KubeconfigSource,
  KubeObject,
  ListRequest,
  LogChunk,
  LogRequest,
  MetricsSnapshot,
  MonitorSnapshot,
  UsageHistory,
  TerminalStartRequest,
  TerminalSessionInfo,
  PortForwardInfo,
  PortForwardRequest,
  ResourceRef,
  Result,
  TerminalData,
  WatchEvent,
} from './types';

/** Request/response methods. Each maps to `ipcMain.handle('k8sc:<method>')`. */
export interface InvokeApi {
  'settings:get': () => AppSettings;
  'settings:update': (patch: Partial<AppSettings>) => AppSettings;

  'kubeconfig:list': () => { sources: KubeconfigSource[]; contexts: ClusterContext[] };
  'kubeconfig:addFile': () => { added: string | null };
  'kubeconfig:addFolder': () => { added: string | null };
  'kubeconfig:removeSource': (path: string) => void;
  'kubeconfig:importYaml': (yaml: string, name: string) => { path: string; contexts: number };

  'cluster:connect': (contextId: string) => ConnectionStatus;
  'cluster:disconnect': () => void;
  'cluster:status': () => ConnectionStatus;
  'cluster:discovery': () => ApiResourceInfo[];

  'resource:list': (req: ListRequest) => KubeObject[];
  'resource:get': (ref: ResourceRef, namespace: string | undefined, name: string) => KubeObject;
  'resource:yaml': (ref: ResourceRef, namespace: string | undefined, name: string) => string;
  'resource:apply': (yaml: string, opts: { dryRun: boolean; mode: 'replace' | 'create' | 'apply'; original?: { ref: ResourceRef; namespace?: string; name: string } }) => ApplyResult[];
  'resource:delete': (ref: ResourceRef, namespace: string | undefined, name: string) => void;
  'resource:watch': (req: ListRequest) => { subscriptionId: string };
  'resource:unwatch': (subscriptionId: string) => void;
  'resource:events': (namespace: string | undefined, uid: string) => KubeObject[];

  'action:scale': (ref: ResourceRef, namespace: string, name: string, replicas: number) => void;
  'action:restart': (ref: ResourceRef, namespace: string, name: string) => void;
  'action:cordon': (node: string, unschedulable: boolean) => void;
  'action:drain': (node: string) => { evicted: string[]; skipped: string[]; failed: string[] };
  'action:evict': (namespace: string, pod: string) => void;
  'action:triggerCronJob': (namespace: string, name: string) => { jobName: string };
  'action:suspendCronJob': (namespace: string, name: string, suspend: boolean) => void;

  'logs:start': (req: LogRequest) => { streamId: string };
  'logs:stop': (streamId: string) => void;
  'logs:save': (suggestedName: string, content: string) => { saved: boolean; path?: string };

  'exec:start': (req: ExecRequest) => { sessionId: string };
  'exec:input': (sessionId: string, data: string) => void;
  'exec:resize': (sessionId: string, cols: number, rows: number) => void;
  'exec:stop': (sessionId: string) => void;

  'portforward:start': (req: PortForwardRequest) => PortForwardInfo;
  'portforward:stop': (id: string) => void;
  'portforward:list': () => PortForwardInfo[];
  'portforward:openBrowser': (id: string) => void;

  'metrics:get': () => MetricsSnapshot;

  'terminal:start': (req: TerminalStartRequest) => TerminalSessionInfo;
  'terminal:input': (sessionId: string, data: string) => void;
  'terminal:resize': (sessionId: string, cols: number, rows: number) => void;
  'terminal:stop': (sessionId: string) => void;
  'terminal:suggestions': (namespace?: string) => string[];

  'monitor:start': () => MonitorSnapshot | null;
  'monitor:stop': () => void;
  'monitor:snapshot': () => MonitorSnapshot | null;
  'monitor:podHistory': (namespace: string, pod: string) => UsageHistory | null;

  'helm:available': () => { available: boolean; version?: string; path?: string };
  'helm:list': (namespace?: string) => HelmRelease[];
  'helm:history': (namespace: string, release: string) => HelmHistoryEntry[];
  'helm:values': (namespace: string, release: string, all: boolean) => string;
  'helm:manifest': (namespace: string, release: string) => string;
  'helm:rollback': (namespace: string, release: string, revision: number) => void;
  'helm:uninstall': (namespace: string, release: string) => void;

  'graph:namespace': (namespace?: string) => ResourceGraph & { notes: string[] };
  'graph:object': (kind: string, namespace: string | undefined, name: string, depth?: number) => ResourceGraph & { notes: string[] };

  'security:scan': (namespace?: string) => SecurityReport & { notes: string[] };
  'security:fix': (finding: Finding, dryRun: boolean) => ApplyResult;

  'access:overview': () => { subjects: Subject[]; resources: Array<{ group: string; resource: string; namespaced: boolean }>; notes: string[] };
  'access:permissions': (subject: Subject, namespace?: string) => { rules: EffectiveRule[]; matrix: Array<{ group: string; resource: string; verbs: Record<string, boolean> }> };
  'access:whoCan': (verb: string, group: string, resource: string, namespace?: string, name?: string) => WhoCanEntry[];
  'access:self': (namespace?: string) => { user?: string; groups?: string[]; rules: Array<{ verbs: string[]; apiGroups?: string[]; resources?: string[]; resourceNames?: string[] }>; incomplete: boolean };
  'access:check': (verb: string, group: string, resource: string, namespace?: string, name?: string) => { allowed: boolean; reason?: string };

  'helm:repos': () => HelmRepo[];
  'helm:repoAdd': (name: string, url: string) => void;
  'helm:repoRemove': (name: string) => void;
  'helm:repoUpdate': () => string;
  'helm:search': (query: string, allVersions?: boolean) => HelmChartVersion[];
  'helm:showReadme': (chart: string, version?: string) => string;
  'helm:showValues': (chart: string, version?: string) => string;
  'helm:install': (req: HelmInstallRequest) => HelmInstallResult;
  'helm:upgrade': (req: HelmInstallRequest) => HelmInstallResult;

  'assistant:status': () => AssistantStatus;
  'assistant:setKey': (key: string | null) => AssistantStatus;
  'assistant:send': (conversationId: string, text: string, context?: string) => void;
  'assistant:stop': (conversationId: string) => void;
  'assistant:reset': (conversationId: string) => void;

  'aws:profiles': () => { profiles: AwsProfileInfo[]; regions: string[]; cli: { aws: boolean; sessionManagerPlugin: boolean }; envCredentials: boolean };
  'aws:connect': (req: AwsConnectRequest) => AwsConnectionStatus;
  'aws:disconnect': () => void;
  'aws:status': () => AwsConnectionStatus;

  'ecs:clusters': () => EcsCluster[];
  'ecs:cluster': (cluster: string) => EcsCluster;
  'ecs:services': (cluster: string) => EcsService[];
  'ecs:service': (cluster: string, service: string) => EcsService;
  'ecs:tasks': (cluster: string, opts?: { serviceName?: string; desiredStatus?: 'RUNNING' | 'STOPPED' | 'ALL' }) => EcsTask[];
  'ecs:task': (cluster: string, task: string) => EcsTask;
  'ecs:containerInstances': (cluster: string) => EcsContainerInstance[];
  'ecs:taskDefinition': (arn: string) => { arn: string; family: string; revision: number; status: string; json: string; registeredAt?: number };
  'ecs:families': (prefix?: string) => EcsTaskDefinitionFamily[];
  'ecs:revisions': (family: string) => string[];
  'ecs:targetHealth': (cluster: string, service: string) => EcsTargetHealth[];
  'ecs:metrics': (cluster: string, services: string[], minutes: number) => EcsServiceMetrics;
  'ecs:map': (cluster: string, service?: string) => ResourceGraph & { notes: string[] };
  'ecs:scan': (cluster: string) => EcsScanReport & { notes: string[] };
  'ecs:events': (cluster: string) => Array<EcsEvent & { service: string }>;
  'ecs:logsStart': (req: EcsLogRequest) => { streamId: string; sources: EcsLogSource[] };
  'ecs:logsStop': (streamId: string) => void;
  'ecs:updateService': (cluster: string, service: string, update: EcsServiceUpdate) => EcsService;
  'ecs:stopTask': (cluster: string, task: string, reason: string) => EcsTask;
  'ecs:runTask': (req: EcsRunTaskRequest) => EcsTask[];
  'ecs:registerTaskDefinition': (json: string) => { arn: string; revision: number };
  'ecs:deregisterTaskDefinition': (arn: string) => void;
  'ecs:createService': (cluster: string, json: string) => EcsService;
  'ecs:deleteService': (cluster: string, service: string, force: boolean) => void;
  'ecs:execInfo': (cluster: string, task: string, container: string) => EcsExecInfo;
  'ecs:execStart': (cluster: string, task: string, container: string, cols: number, rows: number) => TerminalSessionInfo;

  'gitops:list': (namespace?: string) => { items: GitOpsItem[]; engines: string[]; notes: string[] };
  'gitops:action': (ref: ResourceRef, namespace: string, name: string, action: GitOpsAction) => void;

  'cost:cluster': (namespace?: string) => CostReport & { notes: string[]; usageSource?: string };
  'cost:ecs': (cluster: string) => { total: number; idle: number; lines: EcsCostLine[]; notes: string[] };

  'images:list': (namespace?: string) => { images: Array<ImageUse & { scan?: ImageScan }>; operator: boolean; trivyPath: string | null; notes: string[] };
  'images:ecs': (cluster: string) => { images: Array<ImageUse & { scan?: ImageScan }>; trivyPath: string | null; notes: string[] };
  'images:scan': (image: string, source: 'kubernetes' | 'ecs') => ImageScan;

  'extensions:list': () => { installed: InstalledExtension[]; errors: Array<{ path: string; errors: string[] }>; folder: string };
  'extensions:installFile': () => { installed: string | null };
  'extensions:installJson': (json: string) => { installed: string };
  'extensions:remove': (id: string) => void;
  'extensions:setEnabled': (id: string, enabled: boolean) => void;
  'extensions:findings': (namespace?: string) => { findings: ExtFinding[]; notes: string[] };
  'extensions:openFolder': () => void;

  'mcp:status': () => { enabled: boolean; running: boolean; url: string; token: string; error?: string; calls: Array<{ at: number; tool: string; ok: boolean }> };
  'mcp:setEnabled': (enabled: boolean, port?: number) => { enabled: boolean; running: boolean; url: string; token: string; error?: string; calls: Array<{ at: number; tool: string; ok: boolean }> };
  'mcp:regenerateToken': () => { enabled: boolean; running: boolean; url: string; token: string; error?: string; calls: Array<{ at: number; tool: string; ok: boolean }> };

  'app:info': () => { version: string; electron: string; chrome: string; node: string; platform: string };
  'app:openExternal': (url: string) => void;
}

export type InvokeMethod = keyof InvokeApi;

/** Events pushed from main to renderer. */
export interface EventApi {
  'watch:event': WatchEvent;
  'logs:chunk': LogChunk;
  'exec:data': TerminalData;
  'portforward:update': PortForwardInfo[];
  'connection:status': ConnectionStatus;
  'kubeconfig:changed': { reason: string };
  'terminal:data': TerminalData;
  'monitor:update': MonitorSnapshot;
  'assistant:event': AssistantEvent;
  'aws:status': AwsConnectionStatus;
  'ecs:logs': EcsLogChunk;
}

export type EventName = keyof EventApi;

export const INVOKE_METHODS: InvokeMethod[] = [
  'settings:get', 'settings:update',
  'kubeconfig:list', 'kubeconfig:addFile', 'kubeconfig:addFolder', 'kubeconfig:removeSource', 'kubeconfig:importYaml',
  'cluster:connect', 'cluster:disconnect', 'cluster:status', 'cluster:discovery',
  'resource:list', 'resource:get', 'resource:yaml', 'resource:apply', 'resource:delete', 'resource:watch', 'resource:unwatch', 'resource:events',
  'action:scale', 'action:restart', 'action:cordon', 'action:drain', 'action:evict', 'action:triggerCronJob', 'action:suspendCronJob',
  'logs:start', 'logs:stop', 'logs:save',
  'exec:start', 'exec:input', 'exec:resize', 'exec:stop',
  'portforward:start', 'portforward:stop', 'portforward:list', 'portforward:openBrowser',
  'metrics:get',
  'terminal:start', 'terminal:input', 'terminal:resize', 'terminal:stop', 'terminal:suggestions',
  'monitor:start', 'monitor:stop', 'monitor:snapshot', 'monitor:podHistory',
  'helm:available', 'helm:list', 'helm:history', 'helm:values', 'helm:manifest', 'helm:rollback', 'helm:uninstall',
  'graph:namespace', 'graph:object',
  'security:scan', 'security:fix',
  'access:overview', 'access:permissions', 'access:whoCan', 'access:self', 'access:check',
  'helm:repos', 'helm:repoAdd', 'helm:repoRemove', 'helm:repoUpdate', 'helm:search', 'helm:showReadme', 'helm:showValues', 'helm:install', 'helm:upgrade',
  'assistant:status', 'assistant:setKey', 'assistant:send', 'assistant:stop', 'assistant:reset',
  'aws:profiles', 'aws:connect', 'aws:disconnect', 'aws:status',
  'ecs:clusters', 'ecs:cluster', 'ecs:services', 'ecs:service', 'ecs:tasks', 'ecs:task', 'ecs:containerInstances', 'ecs:taskDefinition', 'ecs:families', 'ecs:revisions',
  'ecs:targetHealth', 'ecs:metrics', 'ecs:map', 'ecs:scan', 'ecs:events', 'ecs:logsStart', 'ecs:logsStop',
  'ecs:updateService', 'ecs:stopTask', 'ecs:runTask', 'ecs:registerTaskDefinition', 'ecs:deregisterTaskDefinition', 'ecs:createService', 'ecs:deleteService', 'ecs:execInfo', 'ecs:execStart',
  'gitops:list', 'gitops:action',
  'cost:cluster', 'cost:ecs',
  'images:list', 'images:ecs', 'images:scan',
  'extensions:list', 'extensions:installFile', 'extensions:installJson', 'extensions:remove', 'extensions:setEnabled', 'extensions:findings', 'extensions:openFolder',
  'mcp:status', 'mcp:setEnabled', 'mcp:regenerateToken',
  'app:info', 'app:openExternal',
];

export const EVENT_NAMES: EventName[] = ['watch:event', 'logs:chunk', 'exec:data', 'portforward:update', 'connection:status', 'kubeconfig:changed', 'terminal:data', 'monitor:update', 'assistant:event', 'aws:status', 'ecs:logs'];

export const CHANNEL_PREFIX = 'k8sc:';

/** The object exposed to the renderer as `window.k8sc`. */
export interface BridgeApi {
  invoke<M extends InvokeMethod>(method: M, ...args: Parameters<InvokeApi[M]>): Promise<Result<Awaited<ReturnType<InvokeApi[M]>>>>;
  on<E extends EventName>(event: E, listener: (payload: EventApi[E]) => void): () => void;
}
