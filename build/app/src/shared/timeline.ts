import type { KubeObject } from './types';

export interface TimelineOccurrence {
  uid: string;
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  first: number;
  last: number;
  count: number;
}

export interface TimelineLane {
  key: string;
  kind: string;
  namespace?: string;
  name: string;
  warnings: number;
  total: number;
  lastSeen: number;
  items: TimelineOccurrence[];
}

export interface DensityBucket {
  start: number;
  normal: number;
  warning: number;
}

const ts = (...values: Array<string | undefined>): number | undefined => {
  for (const v of values) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return undefined;
};

/** Normalizes core/v1 and events.k8s.io/v1 shaped events into occurrences with first/last timestamps. */
export function toOccurrence(e: KubeObject): (TimelineOccurrence & { object: { kind: string; namespace?: string; name: string } }) | null {
  const last = ts(e.series?.lastObservedTime, e.lastTimestamp, e.eventTime, e.metadata.creationTimestamp);
  if (last === undefined) return null;
  const first = ts(e.firstTimestamp, e.eventTime, e.metadata.creationTimestamp) ?? last;
  const io = e.involvedObject ?? e.regarding ?? {};
  return {
    uid: e.metadata.uid ?? `${e.metadata.namespace}/${e.metadata.name}`,
    type: e.type === 'Warning' ? 'Warning' : 'Normal',
    reason: e.reason ?? '',
    message: e.message ?? e.note ?? '',
    first: Math.min(first, last),
    last,
    count: e.count ?? e.series?.count ?? 1,
    object: { kind: io.kind ?? 'Unknown', namespace: io.namespace ?? e.metadata.namespace, name: io.name ?? '' },
  };
}

export interface TimelineFilter {
  since: number;
  until: number;
  types?: Array<'Normal' | 'Warning'>;
  text?: string;
  kinds?: string[];
}

/** Groups events into one lane per involved object, newest activity first. */
export function buildLanes(events: KubeObject[], f: TimelineFilter, maxLanes = 80): { lanes: TimelineLane[]; hidden: number } {
  const text = f.text?.trim().toLowerCase();
  const lanes = new Map<string, TimelineLane>();
  for (const e of events) {
    const o = toOccurrence(e);
    if (!o || o.last < f.since || o.first > f.until) continue;
    if (f.types && !f.types.includes(o.type)) continue;
    if (f.kinds && f.kinds.length && !f.kinds.includes(o.object.kind)) continue;
    if (text && !`${o.reason} ${o.message} ${o.object.name}`.toLowerCase().includes(text)) continue;
    const key = `${o.object.kind}/${o.object.namespace ?? ''}/${o.object.name}`;
    const lane = lanes.get(key) ?? { key, kind: o.object.kind, namespace: o.object.namespace, name: o.object.name, warnings: 0, total: 0, lastSeen: 0, items: [] };
    const { object: _object, ...occ } = o;
    void _object;
    lane.items.push(occ);
    lane.total += occ.count;
    if (occ.type === 'Warning') lane.warnings += occ.count;
    lane.lastSeen = Math.max(lane.lastSeen, occ.last);
    lanes.set(key, lane);
  }
  const sorted = [...lanes.values()].sort((a, b) => (b.warnings > 0 ? 1 : 0) - (a.warnings > 0 ? 1 : 0) || b.lastSeen - a.lastSeen);
  for (const l of sorted) l.items.sort((a, b) => a.first - b.first);
  return { lanes: sorted.slice(0, maxLanes), hidden: Math.max(0, sorted.length - maxLanes) };
}

/** Event density per time bucket; an occurrence counts in the bucket of its last observation. */
export function density(lanes: TimelineLane[], since: number, until: number, buckets = 60): DensityBucket[] {
  const width = Math.max(1, (until - since) / buckets);
  const out: DensityBucket[] = Array.from({ length: buckets }, (_, i) => ({ start: since + i * width, normal: 0, warning: 0 }));
  for (const l of lanes)
    for (const o of l.items) {
      const i = Math.min(buckets - 1, Math.max(0, Math.floor((o.last - since) / width)));
      if (o.type === 'Warning') out[i].warning += o.count;
      else out[i].normal += o.count;
    }
  return out;
}
