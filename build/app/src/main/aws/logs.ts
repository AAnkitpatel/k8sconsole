import { randomUUID } from 'node:crypto';
import { logSourceFor, logStreamName, type EcsLogChunk, type EcsLogEvent, type EcsLogRequest, type EcsLogSource } from '../../shared/ecs';
import type { EcsApi } from './ecs';
import { describeAwsError } from './session';

interface Cursor {
  src: EcsLogSource;
  /** The single stream of a task container; undefined for service-wide logs. */
  stream?: string;
  startTime: number;
  nextToken?: string;
  /** FilterLogEvents re-reads the boundary millisecond, so recent lines are de-duplicated. */
  seen: Set<string>;
  lastTs: number;
  reportedMissing?: boolean;
}

interface Tail {
  stopped: boolean;
  timer: NodeJS.Timeout | null;
}

const MAX_INITIAL_PAGES = 5;

/** Polls CloudWatch Logs for a task container or a whole service and pushes new lines as `ecs:logs` events. */
export class EcsLogTails {
  private readonly tails = new Map<string, Tail>();

  constructor(
    private readonly emit: (c: EcsLogChunk) => void,
    private readonly intervalMs = 3000,
  ) {}

  async start(ecs: EcsApi, req: EcsLogRequest): Promise<{ streamId: string; sources: EcsLogSource[] }> {
    const since = Math.min(Math.max(Number(req.sinceSeconds) || 900, 60), 14 * 86400);
    const startTime = Date.now() - since * 1000;
    let cursors: Cursor[] = [];
    if (req.taskArn) {
      const task = await ecs.getTask(req.clusterArn, req.taskArn);
      const sources = (await ecs.logSources(task)).filter((s) => !req.container || s.container === req.container);
      // awslogs streams are `<prefix>/<container>/<task id>`; without a prefix (EC2 only) they are named by container id.
      cursors = sources
        .map((src) => ({ src, stream: logStreamName(src, task.id) ?? task.containers.find((c) => c.name === src.container)?.runtimeId, startTime, seen: new Set<string>(), lastTs: startTime }))
        .filter((c) => !!c.stream);
    } else if (req.serviceName) {
      const svc = await ecs.getService(req.clusterArn, req.serviceName);
      const { def } = await ecs.taskDefinition(svc.taskDefinition);
      cursors = (def.containerDefinitions ?? [])
        .map((c: any) => logSourceFor(def, c.name))
        .filter((s: EcsLogSource | null): s is EcsLogSource => !!s && (!req.container || s.container === req.container))
        .map((src: EcsLogSource) => ({ src, startTime, seen: new Set<string>(), lastTs: startTime }));
    } else throw new Error('Choose a task or a service');

    const streamId = randomUUID();
    const sources = cursors.map((c) => c.src);
    if (!cursors.length) {
      queueMicrotask(() => this.emit({ streamId, end: true, error: 'No CloudWatch logs: the containers do not use the awslogs log driver.' }));
      return { streamId, sources };
    }
    const tail: Tail = { stopped: false, timer: null };
    this.tails.set(streamId, tail);
    const pattern = req.filterPattern ? String(req.filterPattern).slice(0, 1024) : undefined;

    const poll = async (initial: boolean) => {
      const batch: EcsLogEvent[] = [];
      for (const c of cursors) {
        let pages = 0;
        try {
          for (;;) {
            const page = await ecs.logPage(c.src, { stream: c.stream }, { startTime: c.nextToken ? c.startTime : Math.max(c.startTime, c.lastTs), nextToken: c.nextToken, filterPattern: pattern });
            for (const e of page.events) {
              const key = `${e.stream}|${e.t}|${e.message}`;
              if (c.seen.has(key)) continue;
              c.seen.add(key);
              batch.push(e);
              if (e.t > c.lastTs) c.lastTs = e.t;
            }
            if (c.seen.size > 5000) c.seen = new Set([...c.seen].slice(-2000));
            const exhausted = !page.nextToken || page.nextToken === c.nextToken || page.events.length === 0;
            // GetLogEvents keeps its forward token; FilterLogEvents restarts from the newest timestamp seen.
            if (c.stream && !pattern) c.nextToken = page.nextToken ?? c.nextToken;
            else c.nextToken = exhausted ? undefined : page.nextToken;
            pages++;
            if (exhausted || pages >= (initial ? MAX_INITIAL_PAGES : 2) || tail.stopped) break;
          }
        } catch (err) {
          const name = (err as { name?: string }).name;
          if (name === 'ResourceNotFoundException') {
            if (!c.reportedMissing) this.emit({ streamId, error: `No log stream yet for ${c.src.container} in ${c.src.group} (the task may not have started logging).` });
            c.reportedMissing = true;
          } else this.emit({ streamId, error: describeAwsError(err) });
        }
      }
      if (tail.stopped) return;
      batch.sort((a, b) => a.t - b.t);
      if (batch.length || initial) this.emit({ streamId, events: batch });
      if (req.follow) tail.timer = setTimeout(() => void poll(false), this.intervalMs);
      else {
        this.tails.delete(streamId);
        this.emit({ streamId, end: true });
      }
    };
    void poll(true);
    return { streamId, sources };
  }

  stop(id: string): void {
    const t = this.tails.get(id);
    if (!t) return;
    t.stopped = true;
    if (t.timer) clearTimeout(t.timer);
    this.tails.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.tails.keys()]) this.stop(id);
  }

  get count(): number {
    return this.tails.size;
  }
}
