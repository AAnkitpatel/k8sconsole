import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitopsPatch, gitopsRefs, gitopsSummary, toGitOpsItem } from '../../build/app/src/shared/gitops';
import { costReport, cpuMonthly, DEFAULT_PRICES, ecsCost, memMonthly, rightsize, workloadOf } from '../../build/app/src/shared/cost';
import { fromOperatorReport, fromTrivyJson, imagesFromPods, isValidImageRef, sameImage, totalCounts } from '../../build/app/src/shared/images';
import { EXAMPLE_EXTENSION, evaluateRule, renderCommand, renderLink, runRules, validateManifest, valuesAt } from '../../build/app/src/shared/extensions';
import { ExtensionStore } from '../../build/app/src/main/platform';
import { McpServer } from '../../build/app/src/main/mcp';
import { READ_ONLY_TOOLS, validateToolInput } from '../../build/app/src/main/assistant';
import { sanitizeSettings } from '../../build/app/src/main/settings';
import type { ApiResourceInfo } from '../../build/app/src/shared/types';

const GiB = 1024 ** 3;

describe('GitOps', () => {
  const discovery: ApiResourceInfo[] = [
    { group: 'argoproj.io', version: 'v1alpha1', apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', plural: 'applications', namespaced: true, verbs: ['list', 'get', 'patch'] },
    { group: 'kustomize.toolkit.fluxcd.io', version: 'v1', apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', plural: 'kustomizations', namespaced: true, verbs: ['list', 'patch'] },
    { group: 'source.toolkit.fluxcd.io', version: 'v1', apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'GitRepository', plural: 'gitrepositories', namespaced: true, verbs: ['list'] },
    { group: '', version: 'v1', apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true, verbs: ['list'] },
  ];
  const refs = gitopsRefs(discovery);
  const ref = (kind: string) => refs.find((r) => r.ref.kind === kind)!.ref;

  it('finds only the GitOps kinds the cluster serves', () => {
    expect(refs.map((r) => `${r.engine}:${r.ref.kind}`)).toEqual(['argocd:Application', 'flux:Kustomization', 'flux:GitRepository']);
  });

  it('maps Argo CD sync and health into a status', () => {
    const app = (status: any, spec: any = {}) => toGitOpsItem({ kind: 'Application', metadata: { name: 'web', namespace: 'argocd' }, spec: { source: { repoURL: 'https://git/x', targetRevision: 'main', path: 'apps/web' }, destination: { server: 'https://kubernetes.default.svc', namespace: 'shop' }, ...spec }, status }, ref('Application'));
    const ok = app({ sync: { status: 'Synced', revision: 'abc123' }, health: { status: 'Healthy' } }, { syncPolicy: { automated: {} } });
    expect(ok).toMatchObject({ status: 'ok', state: 'Synced · Healthy', source: 'https://git/x @ main (apps/web)', destination: 'https://kubernetes.default.svc / shop', revision: 'abc123', actions: ['refresh', 'sync'], suspended: false });
    expect(app({ sync: { status: 'OutOfSync' }, health: { status: 'Healthy' } }).status).toBe('warn');
    expect(app({ sync: { status: 'Synced' }, health: { status: 'Degraded', message: 'crash' } })).toMatchObject({ status: 'error', message: 'crash' });
    expect(app({ sync: { status: 'Synced' }, health: { status: 'Healthy' }, operationState: { phase: 'Running' } }).status).toBe('pending');
    expect(app({ operationState: { phase: 'Failed', message: 'hook failed' } })).toMatchObject({ status: 'error', message: 'hook failed' });
  });

  it('maps Flux Ready/Stalled/suspend into a status', () => {
    const k = (status: any, spec: any = {}) => toGitOpsItem({ kind: 'Kustomization', metadata: { name: 'apps', namespace: 'flux-system' }, spec: { sourceRef: { kind: 'GitRepository', name: 'repo' }, path: './apps', ...spec }, status }, ref('Kustomization'));
    expect(k({ conditions: [{ type: 'Ready', status: 'True' }], lastAppliedRevision: 'main@sha1:abc' })).toMatchObject({ status: 'ok', state: 'Ready', source: 'GitRepository/repo (./apps)', revision: 'main@sha1:abc', actions: ['reconcile', 'suspend'] });
    expect(k({ conditions: [{ type: 'Ready', status: 'False', reason: 'BuildFailed', message: 'kustomize build failed' }] })).toMatchObject({ status: 'error', state: 'Not ready (BuildFailed)', message: 'kustomize build failed' });
    expect(k({ conditions: [{ type: 'Stalled', status: 'True', reason: 'X' }, { type: 'Ready', status: 'False' }] }).state).toBe('Stalled (X)');
    expect(k({}).status).toBe('pending');
    expect(k({ conditions: [{ type: 'Ready', status: 'True' }] }, { suspend: true })).toMatchObject({ status: 'done', state: 'Suspended', actions: ['reconcile', 'resume'] });
    const repo = toGitOpsItem({ kind: 'GitRepository', metadata: { name: 'repo', namespace: 'flux-system' }, spec: { url: 'https://github.com/o/r', ref: { branch: 'main' } }, status: { artifact: { revision: 'main@sha1:1' }, conditions: [{ type: 'Ready', status: 'True' }] } }, ref('GitRepository'));
    expect(repo).toMatchObject({ source: 'https://github.com/o/r @ main', revision: 'main@sha1:1' });
  });

  it('builds the same patches as the flux and argocd CLIs', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(gitopsPatch('flux', 'reconcile', now)).toEqual({ metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': '2026-01-01T00:00:00.000Z' } } });
    expect(gitopsPatch('flux', 'suspend')).toEqual({ spec: { suspend: true } });
    expect(gitopsPatch('argocd', 'refresh')).toEqual({ metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } });
    expect(gitopsPatch('argocd', 'sync')).toMatchObject({ operation: { sync: {} } });
    expect(() => gitopsPatch('flux', 'sync')).toThrow();
    expect(() => gitopsPatch('argocd', 'suspend')).toThrow();
  });

  it('summarizes', () => {
    const items = [
      toGitOpsItem({ kind: 'Kustomization', metadata: { name: 'a', namespace: 'f' }, spec: { suspend: true }, status: {} }, ref('Kustomization')),
      toGitOpsItem({ kind: 'Application', metadata: { name: 'b', namespace: 'a' }, status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } } }, ref('Application')),
    ];
    expect(gitopsSummary(items)).toMatchObject({ total: 2, ok: 1, suspended: 1, engines: ['flux', 'argocd'] });
  });
});

describe('cost', () => {
  const p = DEFAULT_PRICES;
  it('prices a vCPU and a GiB for a month', () => {
    expect(cpuMonthly(1000, p)).toBeCloseTo(0.04048 * 730, 6);
    expect(memMonthly(GiB, p)).toBeCloseTo(0.004445 * 730, 6);
  });

  it('charges max(request, usage), computes idle, groups by namespace and workload', () => {
    const r = costReport(
      [
        { namespace: 'shop', name: 'web-1', workload: 'Deployment/web', cpuReqMillis: 1000, memReqBytes: GiB, cpuUseMillis: 100, memUseBytes: GiB / 4 },
        { namespace: 'shop', name: 'web-2', workload: 'Deployment/web', cpuReqMillis: 1000, memReqBytes: GiB, cpuUseMillis: 100, memUseBytes: GiB / 4 },
        { namespace: 'jobs', name: 'burst', workload: 'Pod/burst', cpuReqMillis: 0, memReqBytes: 0, cpuUseMillis: 500, memUseBytes: GiB / 2 },
      ],
      p,
      { cpuMillis: 8000, memBytes: 32 * GiB },
    );
    const webCost = 2 * (cpuMonthly(1000, p) + memMonthly(GiB, p));
    expect(r.byWorkload[0]).toMatchObject({ workload: 'Deployment/web', pods: 2 });
    expect(r.byWorkload[0].monthly).toBeCloseTo(webCost, 6);
    expect(r.byWorkload.find((w) => w.workload === 'Pod/burst')!.monthly).toBeCloseTo(cpuMonthly(500, p) + memMonthly(GiB / 2, p), 6);
    expect(r.byWorkload[0].idleMonthly).toBeCloseTo(2 * (cpuMonthly(900, p) + memMonthly((3 * GiB) / 4, p)), 6);
    expect(r.byNamespace.map((n) => n.key)).toEqual(['shop', 'jobs']);
    expect(r.capacity!.unallocatedMonthly).toBeCloseTo(cpuMonthly(6000, p) + memMonthly(30 * GiB, p), 6);
    expect(r.hasUsage).toBe(true);
  });

  it('recommends rightsizing from peak usage with headroom', () => {
    const recs = rightsize(
      [
        { namespace: 'a', name: 'x', workload: 'Deployment/big', cpuReqMillis: 2000, memReqBytes: 4 * GiB, cpuPeakMillis: 200, memPeakBytes: GiB / 2 },
        { namespace: 'a', name: 'y', workload: 'Deployment/hot', cpuReqMillis: 100, memReqBytes: GiB, cpuPeakMillis: 400, memPeakBytes: GiB / 2 },
        { namespace: 'a', name: 'z', workload: 'Deployment/none', cpuReqMillis: 0, memReqBytes: 0, cpuPeakMillis: 50, memPeakBytes: GiB / 8 },
        { namespace: 'a', name: 'n', workload: 'Deployment/unknown', cpuReqMillis: 100, memReqBytes: GiB },
      ],
      p,
    );
    const big = recs.find((r) => r.workload === 'Deployment/big' && r.resource === 'cpu')!;
    expect(big).toMatchObject({ kind: 'over-provisioned', current: 2000, suggested: 260 });
    expect(big.monthlyDelta).toBeGreaterThan(0);
    expect(recs.find((r) => r.workload === 'Deployment/hot' && r.resource === 'cpu')).toMatchObject({ kind: 'under-provisioned', suggested: 520 });
    expect(recs.filter((r) => r.workload === 'Deployment/none').map((r) => r.kind)).toEqual(['no-request', 'no-request']);
    expect(recs.some((r) => r.workload === 'Deployment/unknown')).toBe(false);
    expect(recs[0].monthlyDelta).toBeGreaterThanOrEqual(recs[recs.length - 1].monthlyDelta);
  });

  it('names workloads from owner references', () => {
    expect(workloadOf({ metadata: { name: 'web-7f5c-x', labels: { 'pod-template-hash': '7f5c' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7f5c', controller: true }] } })).toBe('Deployment/web');
    expect(workloadOf({ metadata: { name: 'db-0', ownerReferences: [{ kind: 'StatefulSet', name: 'db', controller: true }] } })).toBe('StatefulSet/db');
    expect(workloadOf({ metadata: { name: 'n-29871540-abc', ownerReferences: [{ kind: 'Job', name: 'nightly-29871540', controller: true }] } })).toBe('CronJob/nightly');
    expect(workloadOf({ metadata: { name: 'debug' } })).toBe('Pod/debug');
  });

  it('prices Fargate services and suggests a smaller valid task size', () => {
    const r = ecsCost([{ service: 'web', running: 2, cpuUnits: 1024, memMiB: 2048, cpuPct: 5, memPct: 10 }, { service: 'idle', running: 0, cpuUnits: 256, memMiB: 512 }], p);
    expect(r.lines[0].monthly).toBeCloseTo(2 * (cpuMonthly(1000, p) + memMonthly(2 * GiB, p)), 6);
    expect(r.lines[0].suggestion).toMatch(/1 vCPU \/ 2 GB → 0.25 vCPU \/ 0.5 GB/);
    expect(r.lines.find((l) => l.service === 'idle')!.monthly).toBe(0);
    expect(r.idle).toBeGreaterThan(0);
  });
});

describe('image scanning', () => {
  it('reads Trivy Operator reports and trivy CLI JSON into one shape', () => {
    const op = fromOperatorReport({
      report: {
        registry: { server: 'ghcr.io' },
        artifact: { repository: 'org/app', tag: '1.2' },
        updateTimestamp: '2026-10-01T00:00:00Z',
        vulnerabilities: [
          { vulnerabilityID: 'CVE-1', resource: 'openssl', installedVersion: '3.0.1', fixedVersion: '3.0.9', severity: 'CRITICAL', score: 9.8 },
          { vulnerabilityID: 'CVE-2', resource: 'zlib', installedVersion: '1.2', severity: 'LOW' },
          { vulnerabilityID: 'CVE-1', resource: 'openssl', installedVersion: '3.0.1', fixedVersion: '3.0.9', severity: 'CRITICAL' },
        ],
      },
    });
    expect(op).toMatchObject({ image: 'ghcr.io/org/app:1.2', source: 'trivy-operator', fixable: 1, counts: { CRITICAL: 1, LOW: 1, HIGH: 0 } });
    expect(op.vulns.map((v) => v.id)).toEqual(['CVE-1', 'CVE-2']);
    const cli = fromTrivyJson('nginx:1.25', { Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-9', PkgName: 'libc', InstalledVersion: '1', Severity: 'HIGH', CVSS: { nvd: { V3Score: 7.5 } } }] }, { Target: 'empty' }] });
    expect(cli).toMatchObject({ source: 'trivy', counts: { HIGH: 1 }, fixable: 0 });
    expect(cli.vulns[0].score).toBe(7.5);
    expect(totalCounts([op, cli])).toMatchObject({ CRITICAL: 1, HIGH: 1, LOW: 1 });
  });

  it('collects images from pods with their workloads', () => {
    const uses = imagesFromPods([
      { metadata: { namespace: 'a', name: 'p1' }, workload: 'Deployment/web', spec: { initContainers: [{ image: 'busybox:1.36' }], containers: [{ image: 'nginx:1.25' }] } },
      { metadata: { namespace: 'a', name: 'p2' }, workload: 'Deployment/web', spec: { containers: [{ image: 'nginx:1.25' }] } },
      { metadata: { namespace: 'b', name: 'p3' }, spec: { containers: [{ image: 'nginx:1.25' }] } },
    ]);
    expect(uses).toEqual([
      { image: 'busybox:1.36', usedBy: ['a/Deployment/web'] },
      { image: 'nginx:1.25', usedBy: ['a/Deployment/web', 'b/Pod/p3'] },
    ]);
  });

  it('matches images across registry prefixes and rejects unsafe references', () => {
    expect(sameImage('docker.io/library/nginx:1.25', 'nginx:1.25')).toBe(true);
    expect(sameImage('ghcr.io/org/app:1.2', 'org/app:1.2')).toBe(true);
    expect(sameImage('nginx', 'nginx:latest')).toBe(true);
    expect(sameImage('nginx:1.25', 'nginx:1.26')).toBe(false);
    for (const ok of ['nginx', 'ghcr.io/o/a:1.0', '123456789012.dkr.ecr.eu-west-2.amazonaws.com/app@sha256:abc']) expect(isValidImageRef(ok)).toBe(true);
    for (const bad of ['-v', 'a b', 'x;rm -rf /', '$(id)', '../etc', '']) expect(isValidImageRef(bad)).toBe(false);
  });
});

describe('extensions', () => {
  it('accepts the example manifest and rejects bad ones with reasons', () => {
    expect(validateManifest(EXAMPLE_EXTENSION).ok).toBe(true);
    const bad = validateManifest({ apiVersion: 1, id: 'Bad ID', name: '', version: 'x', commands: [{ id: 'c', title: 't', command: 'echo {{secret}}' }], links: [{ id: 'l', title: 't', url: 'javascript:alert(1)' }], rules: [{ id: 'r', title: 't', kinds: ['Pod'], path: '__proto__.x', check: 'matches', value: '(' }] });
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: string[] }).errors.join('\n');
    for (const e of ['"id"', '"name"', '"version"', 'unknown placeholder {{secret}}', 'http(s) URL', 'invalid "path"', 'regular expression']) expect(errors).toContain(e);
    expect((validateManifest({ apiVersion: 1, id: 'x', name: 'x', version: '1.0.0' }) as { errors: string[] }).errors).toContain('an extension needs at least one command, link or rule');
  });

  it('renders commands only with shell-safe values and links URL-encoded', () => {
    expect(renderCommand('kubectl logs -f deploy/{{name}} -n {{namespace}}', { name: 'web', namespace: 'shop' })).toBe('kubectl logs -f deploy/web -n shop');
    expect(renderCommand('echo {{name}}', { name: 'x;rm -rf /' })).toBeNull();
    expect(renderCommand('echo {{name}}', { name: '$(id)' })).toBeNull();
    expect(renderCommand('echo {{namespace}}', { name: 'x' })).toBeNull();
    expect(renderLink('https://grafana/d/x?var-pod={{name}}', { name: 'a b&c' })).toBe('https://grafana/d/x?var-pod=a%20b%26c');
    expect(renderLink('{{name}}', { name: 'javascript:alert(1)' })).toBeNull();
  });

  it('evaluates rules against objects', () => {
    const dep = { kind: 'Deployment', metadata: { name: 'web', namespace: 'shop', labels: { app: 'web' } }, spec: { template: { spec: { containers: [{ image: 'nginx:latest' }, { image: 'app:1.0' }] } } } };
    expect(valuesAt(dep, 'spec.template.spec.containers[].image')).toEqual(['nginx:latest', 'app:1.0']);
    expect(valuesAt(dep, 'metadata.__proto__')).toEqual([]);
    const findings = runRules([EXAMPLE_EXTENSION], [dep, { kind: 'Pod', metadata: { name: 'p' } }]);
    expect(findings.map((f) => f.rule)).toEqual(['no-latest', 'team-label']);
    expect(findings[0].detail).toContain('nginx:latest');
    expect(evaluateRule({ id: 'e', title: 't', severity: 'low', kinds: ['Deployment'], path: 'metadata.labels.app', check: 'equals', value: 'web' }, dep)).toBeNull();
    expect(evaluateRule({ id: 'e', title: 't', severity: 'low', kinds: ['Deployment'], path: 'metadata.labels.tier', check: 'absent' }, dep)).toBeNull();
  });

  it('installs, lists, disables and removes extensions on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k8sc-ext-'));
    const store = new ExtensionStore(dir);
    expect(store.install(JSON.stringify(EXAMPLE_EXTENSION)).id).toBe('example-team-tools');
    expect(store.list([]).installed.map((e) => [e.manifest.id, e.enabled])).toEqual([['example-team-tools', true]]);
    expect(store.enabled(['example-team-tools'])).toEqual([]);
    mkdirSync(join(dir, 'broken'));
    writeFileSync(join(dir, 'broken', 'extension.json'), '{nope');
    expect(store.list([]).errors[0].errors[0]).toMatch(/Invalid JSON/);
    expect(() => store.install('{"apiVersion":1}')).toThrow(/Invalid extension/);
    expect(() => store.remove('../x')).toThrow();
    store.remove('example-team-tools');
    expect(store.list([]).installed).toEqual([]);
  });
});

describe('settings for the platform features', () => {
  it('sanitizes hotbar, rates, MCP and extension settings', () => {
    const s = sanitizeSettings({ pinnedContexts: ['a', 'a', 'b', 5], costPrices: { cpuHour: 0.05, memGiBHour: -1, currency: 'eur' }, mcpEnabled: true, mcpPort: 80, disabledExtensions: ['ok-id', '../bad'] });
    expect(s.pinnedContexts).toEqual(['a', 'b']);
    expect(s.costPrices).toEqual({ cpuHour: 0.05, memGiBHour: 0.004445, currency: 'USD' });
    expect(s.mcpEnabled).toBe(true);
    expect(s.mcpPort).toBe(3929);
    expect(s.disabledExtensions).toEqual(['ok-id']);
  });
});

describe('MCP server', () => {
  let server: McpServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });
  const start = async (calls: string[] = []) => {
    server = new McpServer({
      port: 0,
      token: 'secret-token-0123456789abcdef0123456789',
      version: '9.9.9',
      tools: () => READ_ONLY_TOOLS,
      validate: validateToolInput,
      call: async (name, input) => {
        calls.push(name);
        if (name === 'get_metrics') throw new Error('metrics unavailable');
        return JSON.stringify({ name, input });
      },
    });
    await server.start();
    return `http://127.0.0.1:${server.port}/mcp`;
  };
  const rpc = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer secret-token-0123456789abcdef0123456789', ...headers }, body: JSON.stringify(body) });

  it('initializes, lists read-only tools and calls them', async () => {
    const calls: string[] = [];
    const url = await start(calls);
    const init = await (await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'k8sconsole', version: '9.9.9' }, capabilities: { tools: {} } });
    expect((await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = await (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_resources', 'get_pod_logs', 'ecs_list_services', 'gitops_status', 'cost_report', 'image_vulnerabilities']));
    expect(names).not.toContain('propose_change');
    expect(list.result.tools[0].inputSchema.type).toBe('object');
    const res = await (await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_resources', arguments: { kind: 'pods', namespace: 'shop' } } })).json();
    expect(JSON.parse(res.result.content[0].text)).toEqual({ name: 'list_resources', input: { kind: 'pods', namespace: 'shop' } });
    const invalid = await (await rpc(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_resource', arguments: {} } })).json();
    expect(invalid.result).toMatchObject({ isError: true });
    const failing = await (await rpc(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_metrics', arguments: {} } })).json();
    expect(failing.result).toMatchObject({ isError: true, content: [{ text: 'metrics unavailable' }] });
    const unknown = await (await rpc(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'propose_change', arguments: {} } })).json();
    expect(unknown.error.code).toBe(-32602);
    expect(calls).toEqual(['list_resources', 'get_metrics']);
  });

  it('rejects missing or wrong tokens, browser origins, foreign hosts and other paths', async () => {
    const url = await start();
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await rpc(url, body, { authorization: '' })).status).toBe(401);
    expect((await rpc(url, body, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await rpc(url, body, { origin: 'https://evil.example' })).status).toBe(403);
    // fetch cannot override Host, so DNS-rebinding is simulated with a raw request.
    const { request } = await import('node:http');
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { host: 'evil.example', authorization: 'Bearer secret-token-0123456789abcdef0123456789' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    expect(hostStatus).toBe(403);
    expect((await rpc(url.replace('/mcp', '/other'), body)).status).toBe(404);
    expect((await fetch(url, { headers: { authorization: 'Bearer secret-token-0123456789abcdef0123456789' } })).status).toBe(405);
    expect((await rpc(url, body, { origin: 'http://localhost:5173' })).status).toBe(200);
    const parse = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer secret-token-0123456789abcdef0123456789', 'content-type': 'application/json' }, body: '{' });
    expect(parse.status).toBe(400);
  });

  it('only listens on loopback', async () => {
    await start();
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return;
    await expect(fetch(`http://${external.address}:${server!.port}/mcp`, { method: 'POST', signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('trivyScan', () => {
  it('runs trivy with an argument vector and parses its JSON', async () => {
    const { trivyScan } = await import('../../build/app/src/main/platform');
    const { chmodSync, readFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'k8sc-trivy-'));
    const fake = join(dir, 'trivy');
    const args = join(dir, 'args');
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${args}"\necho '{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-1","PkgName":"openssl","InstalledVersion":"1","FixedVersion":"2","Severity":"HIGH"}]}]}'\n`,
    );
    chmodSync(fake, 0o755);
    const scan = await trivyScan(fake, 'ghcr.io/org/app:1.0', { AWS_PROFILE: 'dev' });
    expect(scan).toMatchObject({ image: 'ghcr.io/org/app:1.0', source: 'trivy', counts: { HIGH: 1 }, fixable: 1 });
    expect(readFileSync(args, 'utf8').trim().split('\n')).toEqual(['image', '--format', 'json', '--quiet', '--scanners', 'vuln', '--timeout', '15m', '--', 'ghcr.io/org/app:1.0']);
    await expect(trivyScan(fake, '$(id)')).rejects.toThrow(/Invalid image/);
    writeFileSync(fake, '#!/bin/sh\necho "FATAL unable to find image" >&2\nexit 1\n');
    await expect(trivyScan(fake, 'nginx:1')).rejects.toThrow(/trivy failed: FATAL unable to find image/);
  });
});

describe('cost formatting', () => {
  it('keeps significant digits for unit rates', async () => {
    const { formatRate, formatMoney } = await import('../../build/app/src/shared/cost');
    expect(formatRate(0.004445, 'USD')).toBe('$0.00445');
    expect(formatRate(0.04048, 'EUR')).toBe('EUR 0.0405');
    expect(formatMoney(1234.5, 'USD')).toBe('$1235');
    expect(formatMoney(12.345, 'USD')).toBe('$12.35');
  });
});
