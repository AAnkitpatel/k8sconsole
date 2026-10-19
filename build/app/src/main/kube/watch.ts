import { randomUUID } from 'node:crypto';
import { resourcePath } from '../../shared/resources';
import type { KubeObject, ListRequest, WatchEvent } from '../../shared/types';
import { listResources } from './resources';
import { KubeApiError, type KubeRest } from './rest';

export interface WatchOptions {
  /** Initial reconnect delay in ms (doubles up to maxBackoffMs). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Server-side watch timeout; the watch is resumed transparently afterwards. */
  timeoutSeconds?: number;
}

/**
 * Keeps a live view of a resource collection: list, then watch from the list's resourceVersion.
 * Handles bookmarks, 410 Gone (relist) and network failures (backoff, relist).
 */
export class ResourceWatch {
  readonly id = randomUUID();
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(
    private readonly rest: KubeRest,
    private readonly req: ListRequest,
    private readonly emit: (e: WatchEvent) => void,
    private readonly opts: WatchOptions = {},
  ) {}

  start(): this {
    void this.run();
    return this;
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }

  private async run(): Promise<void> {
    const base = this.opts.backoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30000;
    let backoff = base;
    let needList = true;
    let rv = '';
    while (!this.stopped) {
      try {
        if (needList) {
          const { items, resourceVersion } = await listResources(this.rest, this.req);
          if (this.stopped) return;
          rv = resourceVersion;
          this.emit({ subscriptionId: this.id, type: 'SNAPSHOT', items });
          this.emit({ subscriptionId: this.id, type: 'STATUS', status: 'live' });
          needList = false;
          backoff = base;
        }
        let gone = false;
        await this.rest.streamLines(
          resourcePath(this.req.resource, this.req.namespace || undefined),
          {
            watch: 1,
            resourceVersion: rv,
            allowWatchBookmarks: true,
            timeoutSeconds: this.opts.timeoutSeconds ?? 300,
            labelSelector: this.req.labelSelector,
            fieldSelector: this.req.fieldSelector,
          },
          (ev: { type: string; object: any }) => {
            if (ev.type === 'BOOKMARK') {
              rv = ev.object?.metadata?.resourceVersion ?? rv;
            } else if (ev.type === 'ERROR') {
              if (ev.object?.code === 410) gone = true;
              else throw new KubeApiError(ev.object?.message ?? 'watch error', ev.object?.code ?? 500);
            } else if (ev.type === 'ADDED' || ev.type === 'MODIFIED' || ev.type === 'DELETED') {
              const object: KubeObject = { apiVersion: this.req.resource.apiVersion, kind: this.req.resource.kind, ...ev.object };
              rv = object.metadata?.resourceVersion ?? rv;
              this.emit({ subscriptionId: this.id, type: ev.type, object });
            }
          },
          this.abort.signal,
        );
        if (gone) needList = true;
        backoff = base;
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof KubeApiError && err.code === 410) {
          needList = true;
          continue;
        }
        if (err instanceof KubeApiError && (err.code === 403 || err.code === 404)) {
          this.emit({ subscriptionId: this.id, type: 'STATUS', status: 'error', error: err.message });
          return;
        }
        this.emit({ subscriptionId: this.id, type: 'STATUS', status: 'reconnecting', error: err instanceof Error ? err.message : String(err) });
        await this.sleep(backoff);
        backoff = Math.min(max, backoff * 2);
        needList = true;
      }
    }
  }
}
