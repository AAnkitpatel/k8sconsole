// Types shared by the main process, the preload bridge and the renderer.
// The renderer never receives credentials: only these sanitized shapes.

export interface KubeObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string; controller?: boolean }>;
  generation?: number;
  managedFields?: unknown[];
}

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: KubeObjectMeta;
  spec?: any;
  status?: any;
  [key: string]: any;
}

export interface KubeconfigSource {
  /** Absolute path of the kubeconfig file. */
  path: string;
  /** Where the file came from. */
  origin: 'default' | 'env' | 'user-file' | 'user-folder' | 'managed';
  /** Parse error, if the file could not be loaded. */
  error?: string;
}

export interface ClusterContext {
  /** Stable identifier: `<file path>#<context name>`. */
  id: string;
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  server?: string;
  sourcePath: string;
  origin: KubeconfigSource['origin'];
  isCurrentInFile: boolean;
  /** Short description of the auth method, e.g. "client certificate", "exec: aws". Never the secret itself. */
  authMethod: string;
  insecureSkipTlsVerify: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionStatus {
  contextId: string | null;
  state: ConnectionState;
  serverVersion?: string;
  platform?: string;
  error?: string;
  /** Namespaces the user can list; empty when listing namespaces is forbidden. */
  namespaces: string[];
  canListNamespaces: boolean;
}

export interface ApiResourceInfo {
  group: string;
  version: string;
  /** `group/version` or `version` for the core group. */
  apiVersion: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  verbs: string[];
  shortNames?: string[];
}

export interface ResourceRef {
  apiVersion: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

export interface ListRequest {
  resource: ResourceRef;
  /** Undefined or empty means all namespaces. */
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
}

export interface WatchEvent {
  subscriptionId: string;
  type: 'SNAPSHOT' | 'ADDED' | 'MODIFIED' | 'DELETED' | 'STATUS';
  items?: KubeObject[];
  object?: KubeObject;
  /** For STATUS events: watch health. */
  status?: 'live' | 'reconnecting' | 'error';
  error?: string;
}

export interface LogRequest {
  namespace: string;
  pod: string;
  container: string;
  follow: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  timestamps: boolean;
  previous: boolean;
}

export interface LogChunk {
  streamId: string;
  data?: string;
  end?: boolean;
  error?: string;
}

export interface ExecRequest {
  namespace: string;
  pod: string;
  container: string;
  /** Shell command; defaults to an auto-detected shell. */
  command?: string[];
  cols: number;
  rows: number;
}

export interface TerminalData {
  sessionId: string;
  data?: string;
  exit?: boolean;
  error?: string;
}

export interface PortForwardRequest {
  namespace: string;
  /** Pod or service the forward targets. */
  targetKind: 'Pod' | 'Service';
  targetName: string;
  remotePort: number;
  /** 0 picks a free port. */
  localPort: number;
}

export interface PortForwardInfo {
  id: string;
  contextId: string;
  namespace: string;
  targetKind: 'Pod' | 'Service';
  targetName: string;
  podName: string;
  remotePort: number;
  localPort: number;
  state: 'active' | 'error' | 'stopped';
  error?: string;
  connections: number;
}

export interface MetricsSnapshot {
  available: boolean;
  /** key: `namespace/name` (pods) or `name` (nodes); values in millicores and bytes. */
  pods: Record<string, { cpuMillis: number; memoryBytes: number }>;
  nodes: Record<string, { cpuMillis: number; memoryBytes: number }>;
  error?: string;
}

export interface ApplyResult {
  ok: boolean;
  object?: KubeObject;
  error?: string;
  dryRun: boolean;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

export interface HelmHistoryEntry {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

export type ThemePreference = 'dark' | 'light' | 'system';

export interface AppSettings {
  theme: ThemePreference;
  /** Extra kubeconfig files added by the user. */
  kubeconfigFiles: string[];
  /** Folders scanned for kubeconfig files. */
  kubeconfigFolders: string[];
  lastContextId: string | null;
  /** Per-context last selected namespace ('' = all). */
  lastNamespaces: Record<string, string>;
  logTailLines: number;
  logTimestamps: boolean;
  confirmDestructiveActions: boolean;
  /** Hide managedFields when showing YAML. */
  hideManagedFields: boolean;
  /** Path to the helm binary; empty means look it up on PATH. */
  helmPath: string;
  assistantModel: AssistantModel;
  assistantEffort: 'low' | 'medium' | 'high';
  /** Allow the assistant to read pod logs (logs are sent to the Claude API). */
  assistantReadLogs: boolean;
  /** Which workspace the sidebar shows. */
  workspace: 'kubernetes' | 'ecs';
  /** Last AWS connection (profile, region, role; never credentials). */
  awsLastConnection: import('./ecs').AwsConnectRequest | null;
  /** Last selected ECS cluster per `<profile or default>|<region>`. */
  ecsLastCluster: Record<string, string>;
  /** Hotbar: pinned Kubernetes contexts (ids), in display order. */
  pinnedContexts: string[];
  /** Cost monitoring rates. */
  costPrices: import('./cost').CostPrices;
  /** Built-in MCP server (127.0.0.1 only). */
  mcpEnabled: boolean;
  mcpPort: number;
  /** Ids of installed extensions that are switched off. */
  disabledExtensions: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  kubeconfigFiles: [],
  kubeconfigFolders: [],
  lastContextId: null,
  lastNamespaces: {},
  logTailLines: 500,
  logTimestamps: false,
  confirmDestructiveActions: true,
  hideManagedFields: true,
  helmPath: '',
  assistantModel: 'claude-opus-5-5',
  assistantEffort: 'medium',
  assistantReadLogs: true,
  workspace: 'kubernetes',
  awsLastConnection: null,
  ecsLastCluster: {},
  pinnedContexts: [],
  costPrices: { cpuHour: 0.04048, memGiBHour: 0.004445, currency: 'USD' },
  mcpEnabled: false,
  mcpPort: 3929,
  disabledExtensions: [],
};

/** Result wrapper used for every IPC call so errors cross the bridge as data. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: number };

// ---- Integrated terminal ----

export type ShellKind = 'auto' | 'zsh' | 'bash';

export interface TerminalStartRequest {
  cols: number;
  rows: number;
  shell: ShellKind;
  /** Bind kubectl in this shell to the connected context/namespace (without modifying the user's kubeconfig). */
  bindToCluster: boolean;
  namespace?: string;
  /** Bind the aws CLI to the connected AWS profile and region. */
  bindToAws?: boolean;
  /** When ECS is connected: the cluster used for aws CLI suggestions. */
  ecsCluster?: string;
}

export interface TerminalSessionInfo {
  sessionId: string;
  shell: string;
  context?: string;
  namespace?: string;
  kubectlFound: boolean;
  autosuggest: 'user' | 'bundled' | 'none';
}

// ---- Monitoring (ktop-style) ----

export type MetricsSource = 'kubelet-summary' | 'metrics-server' | 'requests-only';

export interface UsageHistory {
  t: number[];
  cpu: number[];
  mem: number[];
  rx?: number[];
  tx?: number[];
}

export interface ResourceTotals {
  cpuAllocMillis: number;
  memAllocBytes: number;
  cpuRequestsMillis: number;
  memRequestsBytes: number;
  cpuLimitsMillis: number;
  memLimitsBytes: number;
}

export interface NodeStat extends ResourceTotals {
  name: string;
  ready: boolean;
  unschedulable: boolean;
  roles: string;
  cpuUsageMillis?: number;
  memUsageBytes?: number;
  rxBps?: number;
  txBps?: number;
  fsUsedBytes?: number;
  fsCapacityBytes?: number;
  pods: number;
  podCapacity: number;
  history: UsageHistory;
}

export interface PodStat {
  namespace: string;
  name: string;
  node: string;
  status: string;
  restarts: number;
  cpuUsageMillis?: number;
  memUsageBytes?: number;
  cpuRequestsMillis: number;
  cpuLimitsMillis: number;
  memRequestsBytes: number;
  memLimitsBytes: number;
  /** Last ~30 samples for sparklines. */
  spark: { cpu: number[]; mem: number[] };
}

export interface MonitorSnapshot {
  source: MetricsSource;
  intervalSec: number;
  sampledAt: number;
  error?: string;
  cluster: ResourceTotals & {
    cpuUsageMillis?: number;
    memUsageBytes?: number;
    rxBps?: number;
    txBps?: number;
    pods: number;
    podCapacity: number;
    nodesReady: number;
    nodesTotal: number;
    history: UsageHistory;
  };
  nodes: NodeStat[];
  pods: PodStat[];
}

// ---- Helm (repositories and charts) ----

export interface HelmRepo {
  name: string;
  url: string;
}

export interface HelmChartVersion {
  name: string;
  version: string;
  app_version: string;
  description: string;
}

export interface HelmInstallRequest {
  release: string;
  chart: string;
  version?: string;
  namespace: string;
  values?: string;
  createNamespace?: boolean;
  reuseValues?: boolean;
  dryRun?: boolean;
}

export interface HelmInstallResult {
  release: string;
  namespace: string;
  revision: number;
  status: string;
  notes: string;
  manifest: string;
  dryRun: boolean;
}

// ---- AI Assistant ----

export type AssistantModel = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

export interface AssistantEvent {
  conversationId: string;
  type: 'text' | 'tool' | 'proposal' | 'error' | 'done';
  text?: string;
  tool?: { name: string; input: string };
  proposal?: { id: string; summary: string; yaml: string };
  error?: string;
}

export interface AssistantStatus {
  configured: boolean;
  source: 'stored-key' | 'environment' | 'none';
  secureStorage: boolean;
  model: AssistantModel;
}
