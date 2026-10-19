import type { KubeConfig } from '@kubernetes/client-node';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { EventApi, EventName, InvokeApi } from '../shared/api';
import type { ApiResourceInfo, ClusterContext, ConnectionStatus, KubeconfigSource, ListRequest, ResourceRef } from '../shared/types';
import { isValidName } from '../shared/resources';
import { SettingsStore } from './settings';
import { contextsFromSource, discoverSources, importKubeconfigYaml, kubeConfigForContext, KubeconfigWatcher, parseContextId } from './kube/kubeconfig';
import { KubeApiError, KubeRest } from './kube/rest';
import * as res from './kube/resources';
import { ResourceWatch } from './kube/watch';
import { ExecSessions, LogStreams } from './kube/streams';
import { PortForwardManager } from './kube/portforward';
import { readMetrics } from './kube/metrics';
import { findExecutable, HelmClient } from './helm';
import { MonitorCollector } from './kube/monitor';
import { TerminalManager, type ClusterBinding } from './terminal';
import { buildSuggestions } from './terminal-setup';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { Assistant } from './assistant';
import { FeatureService } from './features';
import type { AssistantStatus } from '../shared/types';
import { AwsWorkspace } from './aws/controller';
import { ecsAssistantHost } from './aws/assistant-tools';
import type { AwsClients } from './aws/session';
import { arnName, type AwsConnectRequest } from '../shared/ecs';

export interface Dialogs {
  pickFile(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  saveFile(suggestedName: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}

/** Encrypted storage for the Claude API key (Electron safeStorage in the app). */
export interface SecretStore {
  available(): boolean;
  get(): string | null;
  set(value: string | null): void;
}

export interface ControllerDeps {
  secretStore?: SecretStore;
  /** Builds the Claude client; tests inject a base URL. */
  assistantClient?: (apiKey: string | undefined) => Anthropic;
  userDataDir: string;
  home: string;
  envKubeconfig?: string;
  dialogs: Dialogs;
  /** Path of the bundled zsh-autosuggestions plugin. */
  autosuggestPlugin: string;
  emit: <E extends EventName>(event: E, payload: EventApi[E]) => void;
  /** Tests inject fake AWS clients. */
  awsClients?: (req: AwsConnectRequest) => AwsClients;
  appInfo: () => ReturnType<InvokeApi['app:info']>;
}

type Handlers = { [M in keyof InvokeApi]: (...args: Parameters<InvokeApi[M]>) => Promise<Awaited<ReturnType<InvokeApi[M]>>> | Awaited<ReturnType<InvokeApi[M]>> };

interface Session {
  contextId: string;
  kc: KubeConfig;
  rest: KubeRest;
  discovery: ApiResourceInfo[];
  defaultNamespace: string;
}

export class AppController {
  readonly settings: SettingsStore;
  readonly managedDir: string;
  private sources: KubeconfigSource[] = [];
  private contexts: ClusterContext[] = [];
  private session: Session | null = null;
  private status: ConnectionStatus = { contextId: null, state: 'disconnected', namespaces: [], canListNamespaces: false };
  private readonly watches = new Map<string, ResourceWatch>();
  private readonly logs: LogStreams;
  private readonly execs: ExecSessions;
  readonly portForwards: PortForwardManager;
  private readonly watcher: KubeconfigWatcher;
  private healthTimer: NodeJS.Timeout | null = null;
  private activeConversation: string | null = null;
  readonly terminals: TerminalManager;
  readonly features: FeatureService;
  readonly assistant: Assistant;
  private monitor: MonitorCollector | null = null;
  readonly aws: AwsWorkspace;

  constructor(private readonly deps: ControllerDeps) {
    this.settings = new SettingsStore(join(deps.userDataDir, 'settings.json'));
    this.managedDir = join(deps.userDataDir, 'kubeconfigs');
    this.logs = new LogStreams((c) => deps.emit('logs:chunk', c));
    this.execs = new ExecSessions((d) => deps.emit('exec:data', d));
    this.portForwards = new PortForwardManager((l) => deps.emit('portforward:update', l));
    this.features = new FeatureService(
      () => {
        const s = this.requireSession();
        return { rest: s.rest, discovery: s.discovery, contextName: parseContextId(s.contextId).context, serverVersion: this.status.serverVersion };
      },
      () => this.settings.get(),
      () => this.monitor?.current ?? null,
    );
    this.aws = new AwsWorkspace({
      home: deps.home,
      version: deps.appInfo().version,
      emitStatus: (st) => deps.emit('aws:status', st),
      emitLogs: (c) => deps.emit('ecs:logs', c),
      findExecutable: (name) => findExecutable(name, undefined),
      remember: (req) => this.settings.update({ awsLastConnection: req }),
      clients: deps.awsClients,
    });
    this.assistant = new Assistant({
      client: () => this.assistantClient(),
      host: this.assistantHost(),
      emit: (e) => deps.emit('assistant:event', e),
      model: () => this.settings.get().assistantModel,
      effort: () => this.settings.get().assistantEffort,
    });
    this.terminals = new TerminalManager((d) => deps.emit('terminal:data', d), { home: deps.home, autosuggestPlugin: deps.autosuggestPlugin });
    this.watcher = new KubeconfigWatcher((reason) => {
      this.refreshSources();
      deps.emit('kubeconfig:changed', { reason });
    });
    this.refreshSources();
  }

  refreshSources(): void {
    const s = this.settings.get();
    this.sources = discoverSources({
      home: this.deps.home,
      envKubeconfig: this.deps.envKubeconfig,
      userFiles: s.kubeconfigFiles,
      userFolders: s.kubeconfigFolders,
      managedDir: this.managedDir,
    });
    this.contexts = [];
    for (const src of this.sources) {
      const { contexts, error } = contextsFromSource(src);
      if (error) src.error = error;
      this.contexts.push(...contexts);
    }
    this.watcher.watchPaths([...this.sources.map((x) => x.path), ...s.kubeconfigFolders, this.managedDir]);
  }

  private requireSession(): Session {
    if (!this.session) throw new Error('Not connected to a cluster');
    return this.session;
  }

  private setStatus(next: Partial<ConnectionStatus>) {
    this.status = { ...this.status, ...next };
    this.deps.emit('connection:status', this.status);
  }

  private validateRef(ref: ResourceRef): ResourceRef {
    if (!ref || typeof ref !== 'object') throw new Error('Invalid resource reference');
    return { apiVersion: String(ref.apiVersion), kind: String(ref.kind), plural: String(ref.plural), namespaced: !!ref.namespaced };
  }

  private validateList(req: ListRequest): ListRequest {
    return {
      resource: this.validateRef(req.resource),
      namespace: req.namespace ? String(req.namespace) : undefined,
      labelSelector: req.labelSelector ? String(req.labelSelector).slice(0, 1024) : undefined,
      fieldSelector: req.fieldSelector ? String(req.fieldSelector).slice(0, 1024) : undefined,
    };
  }

  async connect(contextId: string): Promise<ConnectionStatus> {
    this.disconnect();
    this.setStatus({ contextId, state: 'connecting', error: undefined, serverVersion: undefined, namespaces: [], canListNamespaces: false });
    try {
      const kc = kubeConfigForContext(contextId, this.sources);
      const rest = new KubeRest(kc);
      const version = await rest.get('/version', { timeoutMs: 15000 });
      const discovery = await res.discoverResources(rest);
      let namespaces: string[] = [];
      let canList = true;
      try {
        const ns = await rest.get('/api/v1/namespaces', { timeoutMs: 15000 });
        namespaces = (ns.items ?? []).map((n: any) => n.metadata.name).sort();
      } catch (err) {
        if (err instanceof KubeApiError && err.code === 403) canList = false;
        else throw err;
      }
      const ctx = kc.getContextObject(kc.getCurrentContext());
      const defaultNamespace = ctx?.namespace || 'default';
      if (!canList) namespaces = [defaultNamespace];
      this.session = { contextId, kc, rest, discovery, defaultNamespace };
      this.settings.update({ lastContextId: contextId });
      this.setStatus({ state: 'connected', serverVersion: version.gitVersion, platform: version.platform, namespaces, canListNamespaces: canList });
      this.startHealthCheck();
    } catch (err) {
      this.session = null;
      this.setStatus({ state: 'error', error: describeConnectError(err) });
    }
    return this.status;
  }

  /** Periodically checks reachability; on failure marks the connection as errored and recovers automatically. */
  private startHealthCheck() {
    this.healthTimer = setInterval(async () => {
      const s = this.session;
      if (!s) return;
      try {
        await s.rest.get('/version', { timeoutMs: 10000 });
        if (this.status.state !== 'connected') this.setStatus({ state: 'connected', error: undefined });
      } catch (err) {
        if (this.session === s) this.setStatus({ state: 'error', error: `Lost connection: ${describeConnectError(err)}` });
      }
    }, 20000);
  }

  disconnect(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    for (const w of this.watches.values()) w.stop();
    this.watches.clear();
    this.logs.stopAll();
    this.execs.stopAll();
    this.monitor?.stop(true);
    this.monitor = null;
    if (this.session) this.portForwards.stopForContext(this.session.contextId);
    this.session = null;
    this.setStatus({ contextId: null, state: 'disconnected', error: undefined, namespaces: [], canListNamespaces: false });
  }

  shutdown(): void {
    this.disconnect();
    this.portForwards.stopAll();
    this.terminals.stopAll();
    this.aws.disconnect();
    this.watcher.close();
  }

  /** Kubernetes tools from the feature service plus read-only ECS tools; context covers whichever is connected. */
  private assistantHost() {
    const k8s = this.features.assistantHost(
      (summary, yaml) => this.deps.emit('assistant:event', { conversationId: this.activeConversation ?? '', type: 'proposal', proposal: { id: randomUUID(), summary, yaml } }),
      () => ({}),
    );
    return {
      ...k8s,
      context: async () => {
        const kubernetes = this.session ? await k8s.context().catch((err: Error) => ({ error: err.message })) : 'not connected';
        const a = this.aws.current();
        const ecs = a.state === 'connected' ? { account: a.account, region: a.request?.region, identity: a.arn, readOnly: a.request?.readOnly } : 'not connected';
        return { kubernetes, amazonEcs: ecs };
      },
      ecs: ecsAssistantHost(this.aws, () => this.settings.get().assistantReadLogs),
    };
  }

  private assistantStatus(): AssistantStatus {
    const stored = this.deps.secretStore?.get();
    const source = stored ? 'stored-key' : process.env.ANTHROPIC_API_KEY ? 'environment' : 'none';
    return { configured: source !== 'none', source, secureStorage: !!this.deps.secretStore?.available(), model: this.settings.get().assistantModel };
  }

  private assistantClient(): Anthropic | null {
    const key = this.deps.secretStore?.get() ?? undefined;
    if (!key && !process.env.ANTHROPIC_API_KEY) return null;
    return this.deps.assistantClient ? this.deps.assistantClient(key) : new Anthropic(key ? { apiKey: key } : {});
  }

  /** Context-aware kubectl command suggestions for the terminal (best effort; empty when not connected). */
  private async suggestions(namespace?: string): Promise<string[]> {
    const s = this.session;
    if (!s) return buildSuggestions({ namespaces: [], pods: [], deployments: [], statefulsets: [], services: [] });
    const ns = namespace && isValidName(namespace) ? namespace : undefined;
    const names = async (path: string) => {
      try {
        const l = await s.rest.get(path, { query: { limit: 100 }, timeoutMs: 8000 });
        return (l.items ?? []).map((i: any) => i.metadata.name as string);
      } catch {
        return [] as string[];
      }
    };
    const scope = ns ? `/namespaces/${ns}` : '';
    const [pods, deployments, statefulsets, services] = await Promise.all([
      names(`/api/v1${scope}/pods`),
      names(`/apis/apps/v1${scope}/deployments`),
      names(`/apis/apps/v1${scope}/statefulsets`),
      names(`/api/v1${scope}/services`),
    ]);
    return buildSuggestions({ namespace: ns, namespaces: this.status.namespaces, pods, deployments, statefulsets, services });
  }

  private async clusterBinding(namespace?: string): Promise<ClusterBinding | null> {
    const s = this.session;
    if (!s) return null;
    const { path, context } = parseContextId(s.contextId);
    const ctx = s.kc.getContextObject(context);
    if (!ctx) return null;
    const ns = namespace && isValidName(namespace) ? namespace : s.defaultNamespace;
    return { kubeconfigPath: path, context: { name: ctx.name, cluster: ctx.cluster, user: ctx.user }, namespace: ns, suggestions: await this.suggestions(ns) };
  }

  private helm(): HelmClient {
    const s = this.requireSession();
    const bin = findExecutable('helm', this.settings.get().helmPath || undefined);
    if (!bin) throw new Error('helm was not found. Install Helm 3 or set its path in Settings.');
    const { path, context } = parseContextId(s.contextId);
    return new HelmClient(bin, { kubeconfigPath: path, context });
  }

  readonly handlers: Handlers = {
    'settings:get': () => this.settings.get(),
    'settings:update': (patch) => {
      const out = this.settings.update(patch);
      if (patch && ('kubeconfigFiles' in patch || 'kubeconfigFolders' in patch)) this.refreshSources();
      return out;
    },

    'kubeconfig:list': () => {
      this.refreshSources();
      return { sources: this.sources, contexts: this.contexts };
    },
    'kubeconfig:addFile': async () => {
      const file = await this.deps.dialogs.pickFile();
      if (!file) return { added: null };
      const s = this.settings.get();
      this.settings.update({ kubeconfigFiles: [...s.kubeconfigFiles, file] });
      this.refreshSources();
      return { added: file };
    },
    'kubeconfig:addFolder': async () => {
      const dir = await this.deps.dialogs.pickFolder();
      if (!dir) return { added: null };
      const s = this.settings.get();
      this.settings.update({ kubeconfigFolders: [...s.kubeconfigFolders, dir] });
      this.refreshSources();
      return { added: dir };
    },
    'kubeconfig:removeSource': (path) => {
      const s = this.settings.get();
      this.settings.update({
        kubeconfigFiles: s.kubeconfigFiles.filter((f) => f !== path),
        kubeconfigFolders: s.kubeconfigFolders.filter((f) => f !== path),
      });
      this.refreshSources();
    },
    'kubeconfig:importYaml': (yaml, name) => {
      const r = importKubeconfigYaml(yaml, name, this.managedDir);
      this.refreshSources();
      return r;
    },

    'cluster:connect': (id) => this.connect(String(id)),
    'cluster:disconnect': () => this.disconnect(),
    'cluster:status': () => this.status,
    'cluster:discovery': () => this.requireSession().discovery,

    'resource:list': async (req) => (await res.listResources(this.requireSession().rest, this.validateList(req))).items,
    'resource:get': (ref, ns, name) => res.getResource(this.requireSession().rest, this.validateRef(ref), ns || undefined, String(name)),
    'resource:yaml': (ref, ns, name) => res.getResourceYaml(this.requireSession().rest, this.validateRef(ref), ns || undefined, String(name), this.settings.get().hideManagedFields),
    'resource:apply': (yaml, opts) => {
      const s = this.requireSession();
      return res.applyYaml(s.rest, s.discovery, String(yaml), {
        dryRun: !!opts?.dryRun,
        mode: opts?.mode === 'create' ? 'create' : opts?.mode === 'apply' ? 'apply' : 'replace',
        defaultNamespace: s.defaultNamespace,
        original: opts?.original ? { ref: this.validateRef(opts.original.ref), namespace: opts.original.namespace, name: String(opts.original.name) } : undefined,
      });
    },
    'resource:delete': (ref, ns, name) => res.deleteResource(this.requireSession().rest, this.validateRef(ref), ns || undefined, String(name)),
    'resource:watch': (req) => {
      const s = this.requireSession();
      const w = new ResourceWatch(s.rest, this.validateList(req), (e) => this.deps.emit('watch:event', e)).start();
      this.watches.set(w.id, w);
      return { subscriptionId: w.id };
    },
    'resource:unwatch': (id) => {
      this.watches.get(id)?.stop();
      this.watches.delete(id);
    },
    'resource:events': (ns, uid) => res.eventsForObject(this.requireSession().rest, ns || undefined, String(uid)),

    'action:scale': (ref, ns, name, replicas) => res.scaleWorkload(this.requireSession().rest, this.validateRef(ref), ns, name, Number(replicas)),
    'action:restart': (ref, ns, name) => res.restartWorkload(this.requireSession().rest, this.validateRef(ref), ns, name),
    'action:cordon': (node, unschedulable) => res.cordonNode(this.requireSession().rest, String(node), !!unschedulable),
    'action:drain': (node) => res.drainNode(this.requireSession().rest, String(node)),
    'action:evict': (ns, pod) => res.evictPod(this.requireSession().rest, ns, pod),
    'action:triggerCronJob': (ns, name) => res.triggerCronJob(this.requireSession().rest, ns, name),
    'action:suspendCronJob': (ns, name, suspend) => res.suspendCronJob(this.requireSession().rest, ns, name, !!suspend),

    'logs:start': (req) => {
      const s = this.requireSession();
      const explain = async () => {
        try {
          await s.rest.get(`/api/v1/namespaces/${req.namespace}/pods/${req.pod}/log`, { query: { container: req.container, previous: req.previous || undefined, tailLines: 1 }, raw: true, timeoutMs: 10000 });
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };
      return this.logs.start(s.kc, req, explain);
    },
    'logs:stop': (id) => this.logs.stop(id),
    'logs:save': async (suggested, content) => {
      const name = String(suggested).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'logs.txt';
      const path = await this.deps.dialogs.saveFile(name);
      if (!path) return { saved: false };
      await writeFile(path, String(content), { mode: 0o600 });
      return { saved: true, path };
    },

    'exec:start': (req) => this.execs.start(this.requireSession().kc, req),
    'exec:input': (id, data) => this.execs.input(id, data),
    'exec:resize': (id, c, r) => this.execs.resize(id, Number(c), Number(r)),
    'exec:stop': (id) => this.execs.stop(id),

    'portforward:start': (req) => {
      const s = this.requireSession();
      return this.portForwards.start(s.kc, s.rest, s.contextId, {
        namespace: String(req.namespace),
        targetKind: req.targetKind === 'Service' ? 'Service' : 'Pod',
        targetName: String(req.targetName),
        remotePort: Number(req.remotePort),
        localPort: Number(req.localPort),
      });
    },
    'portforward:stop': (id) => this.portForwards.stop(id),
    'portforward:list': () => this.portForwards.list(),
    'portforward:openBrowser': async (id) => {
      const f = this.portForwards.get(id);
      if (f) await this.deps.dialogs.openExternal(`http://127.0.0.1:${f.localPort}/`);
    },

    'metrics:get': () => readMetrics(this.requireSession().rest),

    'terminal:start': async (req) => {
      const binding = req?.bindToCluster ? await this.clusterBinding(req.namespace ? String(req.namespace) : undefined) : null;
      const extras = req?.bindToAws ? await this.aws.terminalExtras(req.ecsCluster ? String(req.ecsCluster) : undefined) : {};
      return this.terminals.start(
        { cols: Number(req?.cols), rows: Number(req?.rows), shell: req?.shell === 'zsh' || req?.shell === 'bash' ? req.shell : 'auto', bindToCluster: !!binding, namespace: binding?.namespace },
        binding,
        extras,
      );
    },
    'terminal:input': (id, data) => this.terminals.input(String(id), data),
    'terminal:resize': (id, c, r) => this.terminals.resize(String(id), Number(c), Number(r)),
    'terminal:stop': (id) => this.terminals.stop(String(id)),
    'terminal:suggestions': (ns) => this.suggestions(ns ? String(ns) : undefined),

    'graph:namespace': (ns) => this.features.namespaceGraph(ns ? String(ns) : undefined),
    'graph:object': (kind, ns, name, depth) => this.features.objectGraph(String(kind), ns ? String(ns) : undefined, String(name), Number(depth) || 2),

    'security:scan': (ns) => this.features.scan(ns ? String(ns) : undefined),
    'security:fix': (finding, dryRun) => this.features.fix(finding, !!dryRun),

    'access:overview': () => this.features.accessOverview(),
    'access:permissions': (subject, ns) => this.features.permissions(subject, ns ? String(ns) : undefined),
    'access:whoCan': (verb, group, resource, ns, name) => this.features.whoCan(verb, group, resource, ns, name),
    'access:self': (ns) => this.features.selfRules(ns ? String(ns) : undefined),
    'access:check': (verb, group, resource, ns, name) => this.features.check(String(verb), String(group ?? ''), String(resource), ns ? String(ns) : undefined, name ? String(name) : undefined),

    'helm:repos': () => this.helm().repos(),
    'helm:repoAdd': (name, url) => this.helm().repoAdd(String(name), String(url)),
    'helm:repoRemove': (name) => this.helm().repoRemove(String(name)),
    'helm:repoUpdate': () => this.helm().repoUpdate(),
    'helm:search': (q, all) => this.helm().search(String(q ?? ''), !!all),
    'helm:showReadme': (chart, v) => this.helm().showReadme(String(chart), v ? String(v) : undefined),
    'helm:showValues': (chart, v) => this.helm().showValues(String(chart), v ? String(v) : undefined),
    'helm:install': (req) => this.helm().installOrUpgrade('install', req),
    'helm:upgrade': (req) => this.helm().installOrUpgrade('upgrade', req),

    'assistant:status': () => this.assistantStatus(),
    'assistant:setKey': (key) => {
      const store = this.deps.secretStore;
      if (!store) throw new Error('Secure key storage is not available');
      if (key !== null) {
        const k = String(key).trim();
        if (!/^[A-Za-z0-9_-]{20,300}$/.test(k)) throw new Error('That does not look like a Claude API key');
        if (!store.available()) throw new Error('No OS keyring is available to encrypt the key. Set ANTHROPIC_API_KEY in the environment instead.');
        store.set(k);
      } else store.set(null);
      return this.assistantStatus();
    },
    'assistant:send': (id, text, context) => {
      const conversation = String(id);
      const message = String(text ?? '').slice(0, 20000);
      if (!message.trim()) return;
      this.activeConversation = conversation;
      // Runs in the background; progress arrives as assistant:event.
      void this.assistant.send(conversation, message, context ? String(context).slice(0, 4000) : undefined);
    },
    'assistant:stop': (id) => this.assistant.stop(String(id)),
    'assistant:reset': (id) => this.assistant.reset(String(id)),

    'monitor:start': () => {
      const s = this.requireSession();
      this.monitor ??= new MonitorCollector(s.rest, (snap) => this.deps.emit('monitor:update', snap));
      return this.monitor.start();
    },
    'monitor:stop': () => this.monitor?.stop(),
    'monitor:snapshot': () => this.monitor?.current ?? null,
    'monitor:podHistory': (ns, pod) => this.monitor?.podHistory(String(ns), String(pod)) ?? null,

    'helm:available': async () => {
      const bin = findExecutable('helm', this.settings.get().helmPath || undefined);
      if (!bin) return { available: false };
      try {
        const v = await new HelmClient(bin, { kubeconfigPath: '', context: '' }).version();
        return { available: true, version: v, path: bin };
      } catch {
        return { available: false, path: bin };
      }
    },
    'helm:list': (ns) => this.helm().list(ns || undefined),
    'helm:history': (ns, r) => this.helm().history(ns, r),
    'helm:values': (ns, r, all) => this.helm().values(ns, r, !!all),
    'helm:manifest': (ns, r) => this.helm().manifest(ns, r),
    'helm:rollback': (ns, r, rev) => this.helm().rollback(ns, r, Number(rev)),
    'helm:uninstall': (ns, r) => this.helm().uninstall(ns, r),

    'aws:profiles': () => this.aws.profiles(),
    'aws:connect': (req) => this.aws.connect(req),
    'aws:disconnect': () => this.aws.disconnect(),
    'aws:status': () => this.aws.current(),

    'ecs:clusters': () => this.aws.require().listClusters(),
    'ecs:cluster': (c) => this.aws.require().describeCluster(AwsWorkspace.cluster(c)),
    'ecs:services': (c) => this.aws.require().listServices(AwsWorkspace.cluster(c)),
    'ecs:service': (c, s) => this.aws.require().getService(AwsWorkspace.cluster(c), String(s)),
    'ecs:tasks': (c, o) =>
      this.aws.require().listTasks(AwsWorkspace.cluster(c), {
        serviceName: o?.serviceName ? String(o.serviceName) : undefined,
        desiredStatus: o?.desiredStatus === 'RUNNING' || o?.desiredStatus === 'STOPPED' ? o.desiredStatus : 'ALL',
      }),
    'ecs:task': (c, t) => this.aws.require().getTask(AwsWorkspace.cluster(c), String(t)),
    'ecs:containerInstances': (c) => this.aws.require().listContainerInstances(AwsWorkspace.cluster(c)),
    'ecs:taskDefinition': async (arn) => {
      const { def, tags } = await this.aws.require().taskDefinition(String(arn));
      const registeredAt = def.registeredAt instanceof Date ? def.registeredAt.getTime() : undefined;
      return { arn: def.taskDefinitionArn, family: def.family, revision: def.revision, status: def.status, registeredAt, json: JSON.stringify(tags.length ? { ...def, tags } : def, null, 2) };
    },
    'ecs:families': (p) => this.aws.require().listTaskDefinitionFamilies(p ? String(p) : undefined),
    'ecs:revisions': (f) => this.aws.require().listRevisions(String(f)),
    'ecs:targetHealth': async (c, s) => {
      const ecs = this.aws.require();
      return ecs.targetHealth([await ecs.getService(AwsWorkspace.cluster(c), String(s))]);
    },
    'ecs:metrics': (c, services, minutes) => this.aws.require().metrics(AwsWorkspace.cluster(c), Array.isArray(services) ? services.map(String) : [], Number(minutes)),
    'ecs:map': (c, s) => this.aws.require().serviceMap(AwsWorkspace.cluster(c), s ? String(s) : undefined),
    'ecs:scan': (c) => this.aws.require().scan(AwsWorkspace.cluster(c)),
    'ecs:events': async (c) => {
      const services = await this.aws.require().listServices(AwsWorkspace.cluster(c));
      return services.flatMap((s) => s.events.map((e) => ({ ...e, service: s.name }))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000);
    },
    'ecs:logsStart': (req) =>
      this.aws.logs.start(this.aws.require(), {
        clusterArn: AwsWorkspace.cluster(req?.clusterArn),
        taskArn: req?.taskArn ? String(req.taskArn) : undefined,
        serviceName: req?.serviceName ? String(req.serviceName) : undefined,
        container: req?.container ? String(req.container) : undefined,
        sinceSeconds: Number(req?.sinceSeconds) || 900,
        follow: !!req?.follow,
        filterPattern: req?.filterPattern ? String(req.filterPattern) : undefined,
      }),
    'ecs:logsStop': (id) => this.aws.logs.stop(String(id)),
    'ecs:updateService': (c, s, u) => this.aws.require().updateService(AwsWorkspace.cluster(c), String(s), AwsWorkspace.update(u)),
    'ecs:stopTask': (c, t, reason) => this.aws.require().stopTask(AwsWorkspace.cluster(c), String(t), String(reason ?? '')),
    'ecs:runTask': (req) => this.aws.require().runTask(AwsWorkspace.runTask(req)),
    'ecs:registerTaskDefinition': (json) => this.aws.require().registerTaskDefinition(String(json).slice(0, 2_000_000)),
    'ecs:deregisterTaskDefinition': (arn) => this.aws.require().deregisterTaskDefinition(String(arn)),
    'ecs:createService': (c, json) => this.aws.require().createService(AwsWorkspace.cluster(c), String(json).slice(0, 1_000_000)),
    'ecs:deleteService': (c, s, force) => this.aws.require().deleteService(AwsWorkspace.cluster(c), String(s), !!force),
    'ecs:execInfo': (c, t, container) => this.aws.execInfo(AwsWorkspace.cluster(c), String(t), String(container)),
    'ecs:execStart': async (c, t, container, cols, rows) => {
      const info = await this.aws.execInfo(AwsWorkspace.cluster(c), String(t), String(container));
      if (!info.available || !info.command) throw new Error(info.reason ?? 'ECS Exec is not available');
      const [file, ...args] = info.command;
      const extras = await this.aws.terminalExtras();
      const session = this.terminals.start({ cols: Number(cols), rows: Number(rows), shell: 'auto', bindToCluster: false }, null, { env: extras.env, command: { file, args } });
      return { ...session, context: `ECS Exec ${arnName(String(t)).slice(0, 8)}/${String(container)}` };
    },

    'app:info': () => this.deps.appInfo(),
    'app:openExternal': async (url) => {
      const u = new URL(String(url));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) links can be opened');
      await this.deps.dialogs.openExternal(u.toString());
    },
  };
}

export function describeConnectError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { code?: string | number };
  if (err instanceof KubeApiError) {
    if (err.code === 401) return `Unauthorized (401): credentials were rejected. ${err.message}`;
    if (err.code === 403) return `Forbidden (403): ${err.message}`;
    return err.message;
  }
  switch (e?.code) {
    case 'ECONNREFUSED':
      return 'Connection refused: the API server is not reachable at the configured address.';
    case 'ENOTFOUND':
      return 'Host not found: check the server address and your DNS/VPN.';
    case 'ETIMEDOUT':
      return 'Connection timed out.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `TLS verification failed (${e.code}): the cluster CA is missing or does not match.`;
    case 'CERT_HAS_EXPIRED':
      return 'TLS certificate has expired.';
  }
  return e instanceof Error ? e.message : String(err);
}

export { isValidName };
