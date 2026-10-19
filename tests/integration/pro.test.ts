/**
 * Insights, access, Helm repositories/install/upgrade and the AI assistant against a DISPOSABLE cluster.
 * Requires K8SC_TEST_KUBECONFIG (and K8SC_TEST_HELM for the Helm part). HOME, Helm config and the Claude API are all isolated:
 * the assistant talks to a local mock of the Messages API, never to the real service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AppController } from '../../build/app/src/main/controller';
import type { EventApi, EventName } from '../../build/app/src/shared/api';
import { nodeId } from '../../build/app/src/shared/graph';
import { mockClaude } from '../unit/mock-claude';

const KUBECONFIG = process.env.K8SC_TEST_KUBECONFIG;
const HELM = process.env.K8SC_TEST_HELM;
const NS = 'k8sc-demo';
const d = KUBECONFIG ? describe : describe.skip;
type Ev = { [E in EventName]: { event: E; payload: EventApi[E] } }[EventName];

d('Insights, access, Helm and assistant (disposable cluster)', () => {
  let dir: string;
  let ctrl: AppController;
  const events: Ev[] = [];
  let secret: string | null = null;
  let claudeUrl = '';
  const h = () => ctrl.handlers;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'k8sc-pro-'));
    // Keep Helm's repository config and cache away from the developer's own.
    process.env.HELM_CONFIG_HOME = join(dir, 'helm-config');
    process.env.HELM_CACHE_HOME = join(dir, 'helm-cache');
    process.env.HELM_DATA_HOME = join(dir, 'helm-data');
    ctrl = new AppController({
      userDataDir: join(dir, 'ud'),
      home: join(dir, 'home'),
      envKubeconfig: KUBECONFIG,
      autosuggestPlugin: resolve(__dirname, '../../build/app/resources/shell/zsh-autosuggestions.zsh'),
      emit: (event, payload) => events.push({ event, payload } as Ev),
      appInfo: () => ({ version: 't', electron: '-', chrome: '-', node: '-', platform: '-' }),
      dialogs: { pickFile: async () => null, pickFolder: async () => null, saveFile: async () => null, openExternal: async () => undefined },
      secretStore: { available: () => true, get: () => secret, set: (v) => (secret = v) },
      assistantClient: (key) => new Anthropic({ apiKey: key, baseURL: claudeUrl, maxRetries: 0 }),
    });
    if (HELM) ctrl.handlers['settings:update']({ helmPath: HELM });
    const { contexts } = await h()['kubeconfig:list']();
    expect((await h()['cluster:connect'](contexts[0].id)).state).toBe('connected');
  });

  afterAll(() => {
    ctrl?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps the namespace: ingress → service → pods, deployment → replicaset → pods, pods → configmap', async () => {
    const g = await h()['graph:namespace'](NS);
    const has = (from: string, toPrefix: string, type: string) => g.edges.some((e) => e.from === from && e.to.startsWith(toPrefix) && e.type === type);
    expect(has(nodeId('Ingress', NS, 'web'), nodeId('Service', NS, 'web'), 'routes')).toBe(true);
    expect(has(nodeId('Service', NS, 'web'), `Pod/${NS}/web-`, 'selects')).toBe(true);
    expect(has(nodeId('Deployment', NS, 'web'), `ReplicaSet/${NS}/web-`, 'owns')).toBe(true);
    expect(g.edges.some((e) => e.from.startsWith(`Pod/${NS}/web-`) && e.to === nodeId('ConfigMap', NS, 'app-config') && e.type === 'mounts')).toBe(true);
    expect(g.nodes.find((n) => n.name === 'crasher')?.status).toBe('error');
  });

  it('builds an object neighbourhood for a pod', async () => {
    const pods = await h()['resource:list']({ resource: { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true }, namespace: NS, labelSelector: 'app=web' });
    const g = await h()['graph:object']('Pod', NS, pods[0].metadata.name, 2);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of ['Pod', 'ReplicaSet', 'Deployment', 'Service', 'ConfigMap', 'Node']) expect(kinds.has(k)).toBe(true);
  });

  it('scans security, dry-runs and applies a fix, and the finding disappears', async () => {
    const DEP = { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true };
    // A throwaway target, so the test does not depend on earlier runs.
    await Promise.resolve(h()['resource:delete'](DEP, NS, 'scan-target')).catch(() => undefined);
    const manifest = `apiVersion: apps/v1
kind: Deployment
metadata: {name: scan-target, namespace: ${NS}}
spec:
  replicas: 0
  selector: {matchLabels: {app: scan-target}}
  template:
    metadata: {labels: {app: scan-target}}
    spec:
      containers: [{name: app, image: "busybox:1.36", command: [sleep, "3600"]}]
`;
    const created = await h()['resource:apply'](manifest, { dryRun: false, mode: 'apply' });
    expect(created[0].ok).toBe(true);
    const report = await h()['security:scan'](NS);
    expect(report.score).toBeLessThan(100);
    expect(report.findings.some((f) => f.rule === 'no-network-policy')).toBe(true);
    const f = report.findings.find((x) => x.rule === 'privilege-escalation' && x.target.kind === 'Deployment' && x.target.name === 'scan-target')!;
    expect(f.fix).toBeDefined();
    expect((await h()['security:fix'](f, true)).ok).toBe(true);
    expect((await h()['resource:get'](DEP, NS, 'scan-target')).spec.template.spec.containers[0].securityContext?.allowPrivilegeEscalation).toBeUndefined();
    expect((await h()['security:fix'](f, false)).ok).toBe(true);
    const dep = await h()['resource:get'](DEP, NS, 'scan-target');
    expect(dep.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation).toBe(false);
    expect(dep.spec.template.spec.containers[0].command).toEqual(['sleep', '3600']);
    const after = await h()['security:scan'](NS);
    expect(after.findings.some((x) => x.id === f.id)).toBe(false);
    await h()['resource:delete'](DEP, NS, 'scan-target');
  });

  it('answers access questions and applies a role built in the editor', async () => {
    const overview = await h()['access:overview']();
    expect(overview.resources.some((r) => r.resource === 'pods' && r.group === '')).toBe(true);
    const who = await h()['access:whoCan']('delete', '', 'pods', NS);
    expect(who.some((w) => w.subject.kind === 'Group' && w.subject.name === 'system:masters')).toBe(true);
    const self = await h()['access:self'](NS);
    expect(self.rules.length).toBeGreaterThan(0);
    expect((await h()['access:check']('delete', '', 'pods', NS)).allowed).toBe(true);

    const yaml = `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: k8sc-readers, namespace: ${NS}}
rules:
- apiGroups: [""]
  resources: [pods, pods/log]
  verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: k8sc-readers-binding, namespace: ${NS}}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: k8sc-readers}
subjects:
- {kind: ServiceAccount, name: reporter, namespace: ${NS}}
`;
    expect((await h()['resource:apply'](yaml, { dryRun: true, mode: 'apply' })).every((r) => r.ok)).toBe(true);
    expect((await h()['resource:apply'](yaml, { dryRun: false, mode: 'apply' })).every((r) => r.ok)).toBe(true);
    // Re-applying is idempotent with server-side apply.
    expect((await h()['resource:apply'](yaml, { dryRun: false, mode: 'apply' })).every((r) => r.ok)).toBe(true);
    const perms = await h()['access:permissions']({ kind: 'ServiceAccount', name: 'reporter', namespace: NS }, NS);
    const pods = perms.matrix.find((m) => m.resource === 'pods' && m.group === '')!;
    expect(pods.verbs).toMatchObject({ get: true, list: true, delete: false });
    const rbac = (kind: string, plural: string) => ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind, plural, namespaced: true });
    await h()['resource:delete'](rbac('RoleBinding', 'rolebindings'), NS, 'k8sc-readers-binding');
    await h()['resource:delete'](rbac('Role', 'roles'), NS, 'k8sc-readers');
  });

  describe.runIf(!!HELM)('Helm repositories, install and upgrade', () => {
    let repoServer: http.Server;
    let repoUrl = '';
    beforeAll(async () => {
      // Package the fixture chart into a throwaway chart repository served from 127.0.0.1.
      const repoDir = join(dir, 'repo');
      execFileSync(HELM!, ['package', resolve(__dirname, '../fixtures/chart'), '--destination', repoDir]);
      repoServer = http.createServer((req, res) => {
        try {
          res.end(readFileSync(join(repoDir, (req.url ?? '/').replace(/^\/+/, '').replace(/\.\./g, ''))));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((r) => repoServer.listen(0, '127.0.0.1', r));
      repoUrl = `http://127.0.0.1:${(repoServer.address() as AddressInfo).port}`;
      execFileSync(HELM!, ['repo', 'index', repoDir, '--url', repoUrl]);
    });
    afterAll(() => {
      repoServer?.close();
    });

    it('adds a repository, searches and shows chart values', async () => {
      await h()['helm:repoAdd']('k8sc-test', repoUrl);
      expect((await h()['helm:repos']()).map((r) => r.name)).toContain('k8sc-test');
      await expect(h()['helm:repoAdd']('bad name', repoUrl)).rejects.toThrow(/Invalid repository name/);
      await expect(h()['helm:repoAdd']('x', 'file:///etc')).rejects.toThrow(/https/);
      const found = await h()['helm:search']('k8sc-test');
      expect(found.map((c) => c.name)).toContain('k8sc-test/k8sc-test-chart');
      expect(await h()['helm:showValues']('k8sc-test/k8sc-test-chart')).toContain('message: first');
    });

    it('installs with a dry run first, then upgrades with new values', async () => {
      const base = { release: 'k8sc-ui', chart: 'k8sc-test/k8sc-test-chart', namespace: NS, values: 'message: from-ui\n' };
      const dry = await h()['helm:install']({ ...base, dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.manifest).toContain('k8sc-ui-config');
      expect((await h()['helm:list'](NS)).some((r) => r.name === 'k8sc-ui')).toBe(false);
      const inst = await h()['helm:install']({ ...base, dryRun: false });
      expect(inst.status).toBe('deployed');
      const cm = () => h()['resource:get']({ apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true }, NS, 'k8sc-ui-config');
      expect((await cm()).data.message).toBe('from-ui');
      const up = await h()['helm:upgrade']({ ...base, values: 'message: upgraded\n' });
      expect(up.revision).toBe(2);
      expect((await cm()).data.message).toBe('upgraded');
      await expect(h()['helm:install']({ ...base, chart: '../../etc/passwd' })).rejects.toThrow(/Chart must be/);
      await h()['helm:uninstall'](NS, 'k8sc-ui');
      await h()['helm:repoRemove']('k8sc-test');
      expect((await h()['helm:repos']()).map((r) => r.name)).not.toContain('k8sc-test');
    });
  });

  it('assistant investigates real cluster data through read-only tools and never sees secret values', async () => {
    const token = `run-${Date.now()}`;
    const api = await mockClaude([
      {
        blocks: [
          { type: 'tool_use', id: 't1', name: 'list_resources', input: { kind: 'po', namespace: NS } },
          { type: 'tool_use', id: 't2', name: 'get_resource', input: { kind: 'Secret', name: 'app-secret', namespace: NS } },
          { type: 'tool_use', id: 't3', name: 'get_resource', input: { kind: 'deploy', name: 'web', namespace: NS } },
        ],
        stop: 'tool_use',
      },
      { blocks: [{ type: 'tool_use', id: 't4', name: 'propose_change', input: { summary: 'Add a label', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n  namespace: ${NS}\n  labels: {reviewed: "${token}"}\n` } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: 'crasher exits with code 3.' }], stop: 'end_turn' },
    ]);
    claudeUrl = api.url;
    expect((await h()['assistant:status']()).configured).toBe(false);
    expect(() => h()['assistant:setKey']('short')).toThrow(/does not look like/);
    expect((await h()['assistant:setKey']('sk-ant-test-0123456789abcdefghij')).source).toBe('stored-key');
    await h()['assistant:send']('conv-1', 'Why is crasher failing?', `namespace: ${NS}`);
    const t0 = Date.now();
    while (!events.some((e) => e.event === 'assistant:event' && (e.payload as any).type === 'done') && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
    await api.close();

    const toolResults = api.requests[1].body.messages.at(-1).content;
    const pods = JSON.parse(toolResults[0].content);
    expect(pods.kind).toBe('Pod');
    expect(pods.items.some((p: any) => p.name === 'crasher')).toBe(true);
    expect(toolResults[1].content).toContain('<redacted>');
    expect(JSON.stringify(api.requests)).not.toContain('s3cr3t-test-value');
    expect(toolResults[2].content).toContain('kind: Deployment');
    const proposal = events.find((e) => e.event === 'assistant:event' && (e.payload as any).type === 'proposal')?.payload as any;
    expect(proposal.proposal.summary).toBe('Add a label');
    // Proposals are never applied by the assistant itself.
    const cfg = await h()['resource:get']({ apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true }, NS, 'app-config');
    expect(cfg.metadata.labels?.reviewed).not.toBe(token);
    // The user's review flow applies it with server-side apply.
    const applied = await h()['resource:apply'](proposal.proposal.yaml, { dryRun: false, mode: 'apply' });
    expect(applied[0].ok).toBe(true);
    const after = await h()['resource:get']({ apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true }, NS, 'app-config');
    expect(after.metadata.labels?.reviewed).toBe(token);
    expect(after.data.greeting).toBe('hello from k8sconsole');
  }, 60000);
});
