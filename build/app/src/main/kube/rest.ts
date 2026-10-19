import type { KubeConfig } from '@kubernetes/client-node';
import http from 'node:http';
import https from 'node:https';

export class KubeApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'KubeApiError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return the raw body text instead of parsing JSON. */
  raw?: boolean;
}

function errorFromBody(status: number, text: string): KubeApiError {
  try {
    const s = JSON.parse(text);
    if (s && typeof s.message === 'string') return new KubeApiError(s.message, s.code ?? status, s.reason);
  } catch {
    // fall through
  }
  const msg = text.trim().slice(0, 500) || http.STATUS_CODES[status] || 'Request failed';
  return new KubeApiError(`HTTP ${status}: ${msg}`, status);
}

/** Minimal Kubernetes REST client on top of KubeConfig's TLS/auth/proxy handling. */
export class KubeRest {
  private readonly base: URL;

  constructor(private readonly kc: KubeConfig) {
    const cluster = kc.getCurrentCluster();
    if (!cluster?.server) throw new Error('The selected context has no cluster server URL');
    this.base = new URL(cluster.server);
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') throw new Error(`Unsupported server protocol ${this.base.protocol}`);
  }

  get server(): string {
    return this.base.toString();
  }

  get kubeConfig(): KubeConfig {
    return this.kc;
  }

  buildUrl(path: string, query?: RequestOptions['query']): URL {
    if (!path.startsWith('/')) throw new Error('API path must be absolute');
    const url = new URL(this.base.toString());
    url.pathname = url.pathname.replace(/\/+$/, '') + path;
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    return url;
  }

  private async open(method: string, url: URL, opts: RequestOptions): Promise<{ req: http.ClientRequest; res: Promise<http.IncomingMessage> }> {
    const reqOpts: https.RequestOptions = {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'k8sconsole' },
    };
    await this.kc.applyToHTTPSOptions(reqOpts);
    let payload: Buffer | undefined;
    if (opts.body !== undefined) {
      payload = Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      (reqOpts.headers as Record<string, string>)['Content-Type'] = opts.contentType ?? 'application/json';
      (reqOpts.headers as Record<string, string>)['Content-Length'] = String(payload.length);
    }
    const mod = url.protocol === 'https:' ? https : http;
    let req!: http.ClientRequest;
    const res = new Promise<http.IncomingMessage>((resolve, reject) => {
      req = mod.request(url, reqOpts, resolve);
      req.on('error', reject);
      if (opts.timeoutMs) {
        req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs} ms`)));
      }
      if (opts.signal) {
        if (opts.signal.aborted) req.destroy(new Error('aborted'));
        opts.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      }
    });
    req.end(payload);
    return { req, res };
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const { res } = await this.open(method, url, { timeoutMs: 30000, ...opts });
    const response = await res;
    const chunks: Buffer[] = [];
    for await (const c of response) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const status = response.statusCode ?? 0;
    if (status >= 400) throw errorFromBody(status, text);
    if (opts.raw) return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T = any>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }

  /**
   * Streams newline-delimited JSON (watch API). Resolves when the server closes the stream.
   * Rejects on HTTP errors or network failures.
   */
  async streamLines(path: string, query: RequestOptions['query'], onLine: (obj: any) => void, signal: AbortSignal): Promise<void> {
    const url = this.buildUrl(path, query);
    const { res } = await this.open('GET', url, { signal });
    const response = await res;
    const status = response.statusCode ?? 0;
    if (status >= 400) {
      const chunks: Buffer[] = [];
      for await (const c of response) chunks.push(c as Buffer);
      throw errorFromBody(status, Buffer.concat(chunks).toString('utf8'));
    }
    let buffer = '';
    for await (const chunk of response) {
      buffer += (chunk as Buffer).toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(JSON.parse(line));
      }
    }
    if (buffer.trim()) onLine(JSON.parse(buffer.trim()));
  }
}
