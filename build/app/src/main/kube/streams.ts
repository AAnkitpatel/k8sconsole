import { Exec, Log, type KubeConfig } from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { isValidName } from '../../shared/resources';
import type { ExecRequest, LogChunk, LogRequest, TerminalData } from '../../shared/types';

function assertPodTarget(namespace: string, pod: string, container: string): void {
  if (!isValidName(namespace) || !isValidName(pod) || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(container)) {
    throw new Error('Invalid pod or container name');
  }
}

/** Buffers small writes and flushes them at most every `intervalMs`. */
class Batcher {
  private buf = '';
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly flushFn: (data: string) => void,
    private readonly intervalMs = 40,
  ) {}
  push(s: string) {
    this.buf += s;
    if (this.buf.length > 256 * 1024) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.buf) {
      const b = this.buf;
      this.buf = '';
      this.flushFn(b);
    }
  }
}

export class LogStreams {
  private readonly active = new Map<string, AbortController | null>();

  constructor(private readonly emit: (c: LogChunk) => void) {}

  /**
   * @param explain optional lookup of the API server's error message; client-node's Log drops the response body on failure.
   */
  async start(kc: KubeConfig, req: LogRequest, explain?: () => Promise<string | undefined>): Promise<{ streamId: string }> {
    assertPodTarget(req.namespace, req.pod, req.container);
    const streamId = randomUUID();
    this.active.set(streamId, null);
    const batch = new Batcher((data) => this.emit({ streamId, data }));
    const sink = new Writable({
      write(chunk, _enc, cb) {
        batch.push(chunk.toString('utf8'));
        cb();
      },
    });
    let ended = false;
    const finish = (error?: string) => {
      if (ended) return;
      ended = true;
      batch.flush();
      this.emit({ streamId, end: true, error });
      this.active.delete(streamId);
    };
    sink.on('finish', () => finish());
    const tail = req.tailLines && req.tailLines > 0 ? Math.min(req.tailLines, 100000) : undefined;
    const since = req.sinceSeconds && req.sinceSeconds > 0 ? req.sinceSeconds : undefined;
    try {
      const ctrl = await new Log(kc).log(req.namespace, req.pod, req.container, sink, {
        follow: !!req.follow,
        tailLines: tail,
        sinceSeconds: since,
        timestamps: !!req.timestamps,
        previous: !!req.previous,
      });
      if (!this.active.has(streamId)) ctrl.abort();
      else this.active.set(streamId, ctrl);
    } catch (err) {
      finish((explain && (await explain().catch(() => undefined))) || describeStreamError(err));
    }
    return { streamId };
  }

  stop(streamId: string): void {
    const ctrl = this.active.get(streamId);
    this.active.delete(streamId);
    ctrl?.abort();
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.stop(id);
  }
}

function describeStreamError(err: unknown): string {
  const anyErr = err as any;
  if (anyErr?.body) {
    try {
      const parsed = typeof anyErr.body === 'string' ? JSON.parse(anyErr.body) : anyErr.body;
      if (parsed?.message) return parsed.message;
    } catch {
      // ignore
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** A writable that also behaves like a TTY so client-node forwards resize events. */
class TtyWritable extends Writable {
  columns: number;
  rows: number;
  constructor(cols: number, rows: number, onData: (s: string) => void) {
    super({
      write(chunk, _enc, cb) {
        onData(chunk.toString('utf8'));
        cb();
      },
    });
    this.columns = cols;
    this.rows = rows;
  }
  resize(cols: number, rows: number) {
    this.columns = cols;
    this.rows = rows;
    this.emit('resize');
  }
}

interface ExecSession {
  stdin: PassThrough;
  stdout: TtyWritable;
  socket: { close(): void } | null;
}

/** Tries bash, then sh, then busybox sh. */
export const DEFAULT_SHELL = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; elif [ -x /busybox/sh ]; then exec /busybox/sh; else exec sh; fi'];

export class ExecSessions {
  private readonly sessions = new Map<string, ExecSession>();

  constructor(private readonly emit: (d: TerminalData) => void) {}

  async start(kc: KubeConfig, req: ExecRequest): Promise<{ sessionId: string }> {
    assertPodTarget(req.namespace, req.pod, req.container);
    const sessionId = randomUUID();
    const cols = clampSize(req.cols, 80);
    const rows = clampSize(req.rows, 24);
    const batch = new Batcher((data) => this.emit({ sessionId, data }), 15);
    const stdout = new TtyWritable(cols, rows, (s) => batch.push(s));
    const stdin = new PassThrough();
    const session: ExecSession = { stdin, stdout, socket: null };
    this.sessions.set(sessionId, session);
    const command = req.command && req.command.length ? req.command.map(String) : DEFAULT_SHELL;
    const done = (error?: string) => {
      if (!this.sessions.has(sessionId)) return;
      batch.flush();
      this.sessions.delete(sessionId);
      this.emit({ sessionId, exit: true, error });
    };
    try {
      const ws = await new Exec(kc).exec(req.namespace, req.pod, req.container, command, stdout, stdout, stdin, true, (status) => {
        done(status.status === 'Success' ? undefined : status.message || status.reason);
      });
      session.socket = ws;
      ws.on('close', () => done());
      ws.on('error', (e: Error) => done(e.message));
    } catch (err) {
      done(describeStreamError(err));
    }
    return { sessionId };
  }

  input(sessionId: string, data: string): void {
    if (typeof data !== 'string' || data.length > 1024 * 1024) return;
    this.sessions.get(sessionId)?.stdin.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stdout.resize(clampSize(cols, 80), clampSize(rows, 24));
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.stdin.end();
    s.socket?.close();
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}

function clampSize(v: number, def: number): number {
  return Number.isInteger(v) && v > 0 && v < 1000 ? v : def;
}
