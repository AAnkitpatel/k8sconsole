import { afterEach, describe, expect, it } from 'vitest';
import { KubeRest, KubeApiError } from '../../build/app/src/main/kube/rest';
import { ResourceWatch } from '../../build/app/src/main/kube/watch';
import { listResources } from '../../build/app/src/main/kube/resources';
import type { WatchEvent } from '../../build/app/src/shared/types';
import { json, startMockApi, status } from './mock-api';

const POD = { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

const pod = (name: string, rv: string) => ({ metadata: { name, namespace: 'default', uid: `uid-${name}`, resourceVersion: rv } });

function waitFor<T>(fn: () => T | undefined, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('KubeRest', () => {
  it('sends bearer auth, preserves server path prefixes, and parses JSON', async () => {
    const api = await startMockApi((r, res) => json(res, 200, { gitVersion: 'v1.31.0', path: r.url.pathname }));
    cleanup.push(api.close);
    api.kc.clusters[0] = { ...api.kc.clusters[0], server: `${api.url}/k8s/clusters/c-123` } as any;
    const rest = new KubeRest(api.kc);
    const v = await rest.get('/version');
    expect(v.path).toBe('/k8s/clusters/c-123/version');
    expect(api.requests[0].headers.authorization).toBe('Bearer test-token');
    expect(api.requests[0].headers['user-agent']).toBe('k8sconsole');
  });

  it('turns Kubernetes Status errors into KubeApiError', async () => {
    const api = await startMockApi((_r, res) => status(res, 403, 'pods is forbidden: User "x" cannot list', 'Forbidden'));
    cleanup.push(api.close);
    const err = await new KubeRest(api.kc).get('/api/v1/pods').catch((e) => e);
    expect(err).toBeInstanceOf(KubeApiError);
    expect(err.code).toBe(403);
    expect(err.message).toContain('forbidden');
  });

  it('reports non-JSON errors with the HTTP status', async () => {
    const api = await startMockApi((_r, res) => {
      res.statusCode = 502;
      res.end('bad gateway');
    });
    cleanup.push(api.close);
    const err = await new KubeRest(api.kc).get('/x').catch((e) => e);
    expect(err.code).toBe(502);
    expect(err.message).toContain('HTTP 502');
  });

  it('sends JSON bodies with a content type and length', async () => {
    const api = await startMockApi((r, res) => json(res, 200, { echoed: JSON.parse(r.body), ct: r.headers['content-type'] }));
    cleanup.push(api.close);
    const r = await new KubeRest(api.kc).request('PATCH', '/x', { body: { a: 1 }, contentType: 'application/merge-patch+json' });
    expect(r).toEqual({ echoed: { a: 1 }, ct: 'application/merge-patch+json' });
  });

  it('times out slow requests', async () => {
    const api = await startMockApi(() => new Promise(() => undefined));
    cleanup.push(api.close);
    await expect(new KubeRest(api.kc).get('/slow', { timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  it('rejects unsupported server protocols', async () => {
    const api = await startMockApi((_r, res) => json(res, 200, {}));
    cleanup.push(api.close);
    api.kc.clusters[0] = { ...api.kc.clusters[0], server: 'ftp://example' } as any;
    expect(() => new KubeRest(api.kc)).toThrow(/Unsupported/);
  });
});

describe('listResources', () => {
  it('follows continue tokens and adds type metadata', async () => {
    const api = await startMockApi((r, res) => {
      if (!r.url.searchParams.get('continue')) json(res, 200, { metadata: { continue: 'next', resourceVersion: '10' }, items: [pod('a', '1')] });
      else json(res, 200, { metadata: { resourceVersion: '11' }, items: [pod('b', '2')] });
    });
    cleanup.push(api.close);
    const r = await listResources(new KubeRest(api.kc), { resource: POD, namespace: 'default', labelSelector: 'app=web' });
    expect(r.items.map((i) => i.metadata.name)).toEqual(['a', 'b']);
    expect(r.items[0].kind).toBe('Pod');
    expect(r.resourceVersion).toBe('11');
    expect(api.requests[0].url.pathname).toBe('/api/v1/namespaces/default/pods');
    expect(api.requests[0].url.searchParams.get('labelSelector')).toBe('app=web');
  });
});

describe('ResourceWatch', () => {
  it('lists, streams events, handles bookmarks and relists after 410 Gone', async () => {
    let lists = 0;
    let watches = 0;
    const api = await startMockApi((r, res) => {
      if (r.url.searchParams.get('watch')) {
        watches++;
        res.setHeader('Content-Type', 'application/json');
        if (watches === 1) {
          expect(r.url.searchParams.get('resourceVersion')).toBe('100');
          res.write(JSON.stringify({ type: 'ADDED', object: pod('b', '101') }) + '\n');
          res.write(JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '150' } } }) + '\n');
          res.write(JSON.stringify({ type: 'MODIFIED', object: pod('a', '151') }) + '\n');
          res.end(JSON.stringify({ type: 'ERROR', object: { code: 410, message: 'too old' } }) + '\n');
        } else {
          res.write(JSON.stringify({ type: 'DELETED', object: pod('a', '201') }) + '\n');
          // keep open
        }
        return;
      }
      lists++;
      json(res, 200, { metadata: { resourceVersion: lists === 1 ? '100' : '200' }, items: [pod('a', '1')] });
    });
    cleanup.push(api.close);
    const events: WatchEvent[] = [];
    const w = new ResourceWatch(new KubeRest(api.kc), { resource: POD }, (e) => events.push(e), { backoffMs: 10 }).start();
    cleanup.push(() => w.stop());
    await waitFor(() => events.find((e) => e.type === 'DELETED'));
    const types = events.map((e) => e.type + (e.status ? ':' + e.status : ''));
    expect(types).toEqual(['SNAPSHOT', 'STATUS:live', 'ADDED', 'MODIFIED', 'SNAPSHOT', 'STATUS:live', 'DELETED']);
    expect(lists).toBe(2);
    expect(events[2].object?.kind).toBe('Pod');
  });

  it('reports reconnecting with backoff when the server drops, then recovers', async () => {
    let calls = 0;
    const api = await startMockApi((r, res) => {
      calls++;
      if (calls === 1) return void res.destroy();
      if (r.url.searchParams.get('watch')) return void res.setHeader('Content-Type', 'application/json');
      json(res, 200, { metadata: { resourceVersion: '5' }, items: [] });
    });
    cleanup.push(api.close);
    const events: WatchEvent[] = [];
    const w = new ResourceWatch(new KubeRest(api.kc), { resource: POD }, (e) => events.push(e), { backoffMs: 20 }).start();
    cleanup.push(() => w.stop());
    await waitFor(() => events.find((e) => e.type === 'STATUS' && e.status === 'live'));
    expect(events[0]).toMatchObject({ type: 'STATUS', status: 'reconnecting' });
  });

  it('stops with an error status on 403 instead of retrying forever', async () => {
    const api = await startMockApi((_r, res) => status(res, 403, 'forbidden'));
    cleanup.push(api.close);
    const events: WatchEvent[] = [];
    const w = new ResourceWatch(new KubeRest(api.kc), { resource: POD }, (e) => events.push(e), { backoffMs: 10 }).start();
    cleanup.push(() => w.stop());
    await waitFor(() => events.find((e) => e.status === 'error'));
    await new Promise((r) => setTimeout(r, 100));
    expect(api.requests).toHaveLength(1);
  });
});
