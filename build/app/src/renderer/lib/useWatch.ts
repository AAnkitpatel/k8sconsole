import { useEffect, useRef, useState } from 'react';
import type { KubeObject, ListRequest, WatchEvent } from '../../shared/types';
import { call, errorMessage, on } from './api';

export interface WatchState {
  items: KubeObject[];
  loading: boolean;
  status: 'live' | 'reconnecting' | 'error' | 'loading';
  error?: string;
}

const keyOf = (o: KubeObject) => o.metadata.uid ?? `${o.metadata.namespace ?? ''}/${o.metadata.name}`;

/** Applies a watch event to a keyed map. Exported for tests. */
export function applyWatchEvent(map: Map<string, KubeObject>, e: WatchEvent): Map<string, KubeObject> {
  if (e.type === 'SNAPSHOT') return new Map((e.items ?? []).map((o) => [keyOf(o), o]));
  if (!e.object) return map;
  const next = new Map(map);
  if (e.type === 'DELETED') next.delete(keyOf(e.object));
  else next.set(keyOf(e.object), e.object);
  return next;
}

/** Subscribes to a live list of resources; events are coalesced per animation frame. */
export function useWatch(req: ListRequest | null): WatchState {
  const [state, setState] = useState<WatchState>({ items: [], loading: true, status: 'loading' });
  const key = req ? JSON.stringify(req) : '';
  const mapRef = useRef(new Map<string, KubeObject>());

  useEffect(() => {
    if (!req) return;
    let subId: string | null = null;
    let cancelled = false;
    let frame = 0;
    const pending: WatchEvent[] = [];
    mapRef.current = new Map();
    setState({ items: [], loading: true, status: 'loading' });

    const flush = () => {
      frame = 0;
      let map = mapRef.current;
      let status: WatchState['status'] | undefined;
      let error: string | undefined;
      let sawSnapshot = false;
      for (const e of pending.splice(0)) {
        if (e.type === 'STATUS') {
          status = e.status;
          error = e.error;
        } else {
          if (e.type === 'SNAPSHOT') sawSnapshot = true;
          map = applyWatchEvent(map, e);
        }
      }
      mapRef.current = map;
      setState((s) => ({
        items: [...map.values()],
        loading: s.loading && !sawSnapshot && status !== 'error',
        status: status ?? (sawSnapshot ? 'live' : s.status),
        error: status ? error : s.error,
      }));
    };

    // Events can arrive before the subscription id is known; hold them until then.
    const early: WatchEvent[] = [];
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const off = on('watch:event', (e) => {
      if (subId === null) {
        early.push(e);
        return;
      }
      if (e.subscriptionId !== subId) return;
      pending.push(e);
      schedule();
    });

    call('resource:watch', req)
      .then((r) => {
        if (cancelled) {
          void call('resource:unwatch', r.subscriptionId);
          return;
        }
        subId = r.subscriptionId;
        pending.push(...early.filter((e) => e.subscriptionId === subId));
        early.length = 0;
        if (pending.length) schedule();
      })
      .catch((err) => setState({ items: [], loading: false, status: 'error', error: errorMessage(err) }));

    return () => {
      cancelled = true;
      off();
      if (frame) cancelAnimationFrame(frame);
      if (subId) void call('resource:unwatch', subId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
