/**
 * GitOps, cost, image vulnerabilities, extensions and the MCP server against a DISPOSABLE cluster.
 * Flux, Argo CD and Trivy Operator are represented by their CRDs and sample objects (no controllers run),
 * which is exactly what K8sConsole reads and patches. Everything created here is removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppController } from '../../build/app/src/main/controller';
import { EXAMPLE_EXTENSION } from '../../build/app/src/shared/extensions';

const KUBECONFIG = process.env.K8SC_TEST_KUBECONFIG;
const NS = 'k8sc-demo';
// Unique per run: deleting a namespace can stay pending for a while (for example when an aggregated API is unavailable).
const GNS = `k8sc-gitops-${Date.now().toString(36)}`;
const d = KUBECONFIG ? describe : describe.skip;

const kubectl = (args: string[], input?: string) => execFileSync('kubectl', ['--kubeconfig', KUBECONFIG!, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const crd = (group: string, kind: string, plural: string) => `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: {name: ${plural}.${group}}
spec:
  group: ${group}
  scope: Namespaced
  names: {kind: ${kind}, plural: ${plural}, singular: ${kind.toLowerCase()}}
  versions:
    - name: ${group === 'argoproj.io' || group === 'aquasecurity.github.io' ? 'v1alpha1' : 'v1'}
      served: true
      storage: true
      schema: {openAPIV3Schema: {type: object, x-kubernetes-preserve-unknown-fields: true}}
`;
const CRDS = [
  ['argoproj.io', 'Application', 'applications'],
  ['argoproj.io', 'ApplicationSet', 'applicationsets'],
  ['kustomize.toolkit.fluxcd.io', 'Kustomization', 'kustomizations'],
  ['source.toolkit.fluxcd.io', 'GitRepository', 'gitrepositories'],
  ['aquasecurity.github.io', 'VulnerabilityReport', 'vulnerabilityreports'],
] as const;

d('Platform features (disposable cluster)', () => {
  let dir: string;
  let ctrl: AppController;
  let contextId: string;
  let webImage: string;
  const h = () => ctrl.handlers;

  beforeAll(async () => {
    kubectl(['apply', '-f', '-'], CRDS.map(([g, k, p]) => crd(g, k, p)).join('---\n'));
    kubectl(['wait', '--for', 'condition=Established', '--timeout=60s', ...CRDS.map(([g, , p]) => `crd/${p}.${g}`)]);
    kubectl(['create', 'namespace', GNS]);
    webImage = kubectl(['get', 'deploy', 'web', '-n', NS, '-o', 'jsonpath={.spec.template.spec.containers[0].image}']).trim();
    const [repo, tag] = webImage.includes(':') ? [webImage.slice(0, webImage.lastIndexOf(':')), webImage.slice(webImage.lastIndexOf(':') + 1)] : [webImage, 'latest'];
    kubectl(
      ['apply', '-f', '-'],
      `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: shop, namespace: ${GNS}}
spec:
  source: {repoURL: "https://github.com/example/deploy", targetRevision: main, path: apps/shop}
  destination: {server: "https://kubernetes.default.svc", namespace: shop}
  syncPolicy: {automated: {}}
status:
  sync: {status: OutOfSync, revision: 0123abc}
  health: {status: Healthy}
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {name: infra, namespace: ${GNS}}
spec: {interval: 10m, path: ./infra, sourceRef: {kind: GitRepository, name: platform}}
status:
  lastAppliedRevision: main@sha1:abcdef
  conditions: [{type: Ready, status: "False", reason: BuildFailed, message: "kustomize build failed", lastTransitionTime: "2026-10-01T00:00:00Z"}]
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: {name: platform, namespace: ${GNS}}
spec: {url: "https://github.com/example/platform", ref: {branch: main}}
status:
  artifact: {revision: main@sha1:abcdef}
  conditions: [{type: Ready, status: "True"}]
---
apiVersion: aquasecurity.github.io/v1alpha1
kind: VulnerabilityReport
metadata: {name: web-report, namespace: ${NS}}
report:
  registry: {server: index.docker.io}
  artifact: {repository: "${repo.replace(/^docker\.io\//, '')}", tag: "${tag}"}
  updateTimestamp: "2026-10-01T00:00:00Z"
  vulnerabilities:
    - {vulnerabilityID: CVE-2026-0001, resource: openssl, installedVersion: 3.0.1, fixedVersion: 3.0.9, severity: CRITICAL, title: test}
    - {vulnerabilityID: CVE-2026-0002, resource: zlib, installedVersion: "1.2", severity: MEDIUM}
`,
    );
    dir = mkdtempSync(join(tmpdir(), 'k8sc-platform-'));
    ctrl = new AppController({
      userDataDir: join(dir, 'ud'),
      home: join(dir, 'home'),
      envKubeconfig: KUBECONFIG,
      autosuggestPlugin: resolve(__dirname, '../../build/app/resources/shell/zsh-autosuggestions.zsh'),
      emit: () => undefined,
      appInfo: () => ({ version: '9.9.9', electron: '-', chrome: '-', node: '-', platform: '-' }),
      dialogs: { pickFile: async () => null, pickFolder: async () => null, saveFile: async () => null, openExternal: async () => undefined },
    });
    contextId = (await h()['kubeconfig:list']()).contexts[0].id;
    expect((await h()['cluster:connect'](contextId)).state).toBe('connected');
  }, 120_000);

  afterAll(() => {
    ctrl?.shutdown();
    try {
      kubectl(['delete', 'namespace', GNS, '--wait=false']);
      kubectl(['delete', 'vulnerabilityreport', 'web-report', '-n', NS, '--ignore-not-found']);
      kubectl(['delete', 'crd', ...CRDS.map(([g, , p]) => `${p}.${g}`), '--wait=false']);
    } catch {
      // best effort
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('lists Flux and Argo CD objects with their state', async () => {
    const r = await h()['gitops:list'](GNS);
    expect(r.engines.sort()).toEqual(['argocd', 'flux']);
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(byName.shop).toMatchObject({ engine: 'argocd', status: 'warn', state: 'OutOfSync · Healthy', revision: '0123abc', source: 'https://github.com/example/deploy @ main (apps/shop)' });
    expect(byName.infra).toMatchObject({ engine: 'flux', status: 'error', state: 'Not ready (BuildFailed)', message: 'kustomize build failed' });
    expect(byName.platform).toMatchObject({ status: 'ok', source: 'https://github.com/example/platform @ main' });
  });

  it('performs GitOps actions as merge patches', async () => {
    const { items } = await h()['gitops:list'](GNS);
    const app = items.find((i) => i.name === 'shop')!;
    const ks = items.find((i) => i.name === 'infra')!;
    await h()['gitops:action'](app.ref, GNS, 'shop', 'sync');
    await h()['gitops:action'](app.ref, GNS, 'shop', 'refresh');
    const a = JSON.parse(kubectl(['get', 'application', 'shop', '-n', GNS, '-o', 'json']));
    expect(a.operation).toMatchObject({ initiatedBy: { username: 'k8sconsole' }, sync: {} });
    expect(a.metadata.annotations['argocd.argoproj.io/refresh']).toBe('normal');
    await h()['gitops:action'](ks.ref, GNS, 'infra', 'suspend');
    expect(JSON.parse(kubectl(['get', 'kustomization', 'infra', '-n', GNS, '-o', 'json'])).spec.suspend).toBe(true);
    expect((await h()['gitops:list'](GNS)).items.find((i) => i.name === 'infra')).toMatchObject({ state: 'Suspended', actions: ['reconcile', 'resume'] });
    await h()['gitops:action'](ks.ref, GNS, 'infra', 'resume');
    const k = JSON.parse(kubectl(['get', 'kustomization', 'infra', '-n', GNS, '-o', 'json']));
    expect(k.spec.suspend).toBe(false);
    expect(k.metadata.annotations['reconcile.fluxcd.io/requestedAt']).toBeTruthy();
    expect(k.spec.path).toBe('./infra');
    await expect(Promise.resolve().then(() => h()['gitops:action'](ks.ref, GNS, 'infra', 'sync'))).rejects.toThrow(/not supported/);
    await expect(Promise.resolve().then(() => h()['gitops:action']({ apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true }, NS, 'x', 'reconcile'))).rejects.toThrow(/Not a Flux or Argo CD/);
  });

  it('reads Trivy Operator reports for running images', async () => {
    const r = await h()['images:list'](NS);
    expect(r.operator).toBe(true);
    const web = r.images.find((i) => i.image === webImage)!;
    expect(web.usedBy).toContain(`${NS}/Deployment/web`);
    expect(web.scan).toMatchObject({ source: 'trivy-operator', counts: { CRITICAL: 1, MEDIUM: 1 }, fixable: 1 });
    await expect(Promise.resolve().then(() => h()['images:scan']('x;rm -rf /', 'kubernetes'))).rejects.toThrow(/Invalid image/);
  });

  it('estimates cost by namespace and workload, with usage once Monitor has sampled', async () => {
    const demo = await h()['cost:cluster'](NS);
    // Other suites restart web, so it can briefly run more pods than its 2 replicas.
    expect(demo.byWorkload.some((w) => w.workload === 'Deployment/web' && w.pods >= 1)).toBe(true);
    // The demo pods set no requests: they are listed, and the estimate says why they cost nothing yet.
    expect(demo.notes.some((n) => /no CPU or memory requests/.test(n))).toBe(true);
    const ns = await h()['cost:cluster']('kube-system');
    expect(ns.byWorkload.some((w) => w.workload === 'Deployment/coredns' && w.monthly > 0)).toBe(true);
    expect(ns.total.monthly).toBeGreaterThan(0);
    expect(ns.capacity).toBeUndefined();
    const all = await h()['cost:cluster']();
    expect(all.capacity!.monthly).toBeGreaterThan(all.capacity!.allocatedMonthly);
    expect(all.byNamespace.map((n) => n.key)).toContain('kube-system');
    await h()['monitor:start']();
    await new Promise((r) => setTimeout(r, 4000));
    const withUsage = await h()['cost:cluster'](NS);
    expect(withUsage.hasUsage).toBe(true);
    expect(withUsage.byWorkload.find((w) => w.workload === 'Deployment/web')!.cpuUseMillis).toBeGreaterThanOrEqual(0);
    h()['monitor:stop']();
    // Rates come from settings.
    h()['settings:update']({ costPrices: { cpuHour: 0.08096, memGiBHour: 0.00889, currency: 'EUR' } });
    const doubled = await h()['cost:cluster']('kube-system');
    expect(doubled.prices.currency).toBe('EUR');
    expect(doubled.total.monthly).toBeCloseTo(ns.total.monthly * 2, 1);
  }, 60_000);

  it('installs an extension and evaluates its rules against the cluster', async () => {
    expect(h()['extensions:installJson'](JSON.stringify(EXAMPLE_EXTENSION))).toEqual({ installed: 'example-team-tools' });
    const r = await h()['extensions:findings'](NS);
    expect(r.findings.some((f) => f.rule === 'team-label' && f.name === 'web')).toBe(true);
    h()['extensions:setEnabled']('example-team-tools', false);
    expect((await h()['extensions:findings'](NS)).findings).toEqual([]);
  });

  it('serves read-only tools over MCP against the connected cluster', async () => {
    const port = 39000 + Math.floor(Math.random() * 1000);
    const st = await h()['mcp:setEnabled'](true, port);
    expect(st).toMatchObject({ enabled: true, running: true, url: `http://127.0.0.1:${port}/mcp` });
    const call = async (method: string, params?: unknown) => {
      const res = await fetch(st.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${st.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return (await res.json()).result;
    };
    expect((await call('initialize', { protocolVersion: '2025-06-18' })).serverInfo.version).toBe('9.9.9');
    const pods = JSON.parse((await call('tools/call', { name: 'list_resources', arguments: { kind: 'pods', namespace: NS } })).content[0].text);
    expect(pods.items.some((p: any) => p.name.startsWith('web-'))).toBe(true);
    const gitops = JSON.parse((await call('tools/call', { name: 'gitops_status', arguments: { namespace: GNS } })).content[0].text);
    expect(gitops.items.map((i: any) => i.name).sort()).toEqual(['infra', 'platform', 'shop']);
    const cost = JSON.parse((await call('tools/call', { name: 'cost_report', arguments: { namespace: 'kube-system' } })).content[0].text);
    expect(cost.total.monthly).toBeGreaterThan(0);
    const imgs = JSON.parse((await call('tools/call', { name: 'image_vulnerabilities', arguments: { namespace: NS } })).content[0].text);
    expect(imgs.images.find((i: any) => i.image === webImage).counts.CRITICAL).toBe(1);
    expect((await h()['mcp:status']()).calls.length).toBe(4);
    const rotated = await h()['mcp:regenerateToken']();
    expect(rotated.token).not.toBe(st.token);
    const { request } = await import('node:http');
    const oldTokenStatus = await new Promise<number>((res, rej) => {
      const req = request(st.url, { method: 'POST', agent: false, headers: { authorization: `Bearer ${st.token}` } }, (r) => (r.resume(), res(r.statusCode ?? 0)));
      req.on('error', rej);
      req.end('{}');
    });
    expect(oldTokenStatus).toBe(401);
    await h()['mcp:setEnabled'](false);
    await expect(fetch(st.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
