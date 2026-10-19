import http from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Route = (req: RecordedRequest, res: http.ServerResponse) => void | Promise<void>;

/** A tiny fake API server on 127.0.0.1 that records requests and delegates to a route function. */
export async function startMockApi(route: Route): Promise<{ url: string; requests: RecordedRequest[]; server: http.Server; kc: KubeConfig; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r: RecordedRequest = { method: req.method!, url: new URL(req.url!, 'http://x'), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(r);
    try {
      await route(r, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'mock', server: url, skipTLSVerify: true }],
    users: [{ name: 'u', token: 'test-token' }],
    contexts: [{ name: 'mock', cluster: 'mock', user: 'u' }],
    currentContext: 'mock',
  });
  return {
    url,
    requests,
    server,
    kc,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function status(res: http.ServerResponse, code: number, message: string, reason = 'Failure') {
  json(res, code, { kind: 'Status', apiVersion: 'v1', status: 'Failure', message, reason, code });
}
