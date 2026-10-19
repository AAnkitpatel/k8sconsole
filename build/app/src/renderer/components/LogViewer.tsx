import { useEffect, useMemo, useRef, useState } from 'react';
import type { KubeObject } from '../../shared/types';
import { call, errorMessage, on } from '../lib/api';
import { useToast } from './Dialogs';

const MAX_BUFFER = 5 * 1024 * 1024;
const SINCE_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: 'All', seconds: 0 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },
];

/** Trims the buffer to the most recent `max` characters on a line boundary. */
export function trimLogBuffer(text: string, max = MAX_BUFFER): string {
  if (text.length <= max) return text;
  const cut = text.indexOf('\n', text.length - max);
  return cut === -1 ? text.slice(-max) : text.slice(cut + 1);
}

export function LogViewer({ pod, defaultTail, defaultTimestamps }: { pod: KubeObject; defaultTail: number; defaultTimestamps: boolean }) {
  const containers: string[] = useMemo(
    () => [...(pod.spec?.initContainers ?? []).map((c: any) => c.name), ...(pod.spec?.containers ?? []).map((c: any) => c.name), ...(pod.spec?.ephemeralContainers ?? []).map((c: any) => c.name)],
    [pod],
  );
  const [container, setContainer] = useState<string>(pod.spec?.containers?.[0]?.name ?? containers[0] ?? '');
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [timestamps, setTimestamps] = useState(defaultTimestamps);
  const [tail, setTail] = useState(defaultTail);
  const [since, setSince] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [state, setState] = useState<'streaming' | 'ended' | 'error' | 'loading'>('loading');
  const [error, setError] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);
  const toast = useToast();
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let streamId: string | null = null;
    let cancelled = false;
    const early: Array<{ streamId: string; data?: string; end?: boolean; error?: string }> = [];
    setText('');
    setError(undefined);
    setState('loading');
    const handle = (c: { data?: string; end?: boolean; error?: string }) => {
      if (c.data) {
        setText((t) => trimLogBuffer(t + c.data));
        setState((s) => (s === 'loading' ? 'streaming' : s));
      }
      if (c.end) {
        setState(c.error ? 'error' : 'ended');
        setError(c.error);
      }
    };
    const off = on('logs:chunk', (c) => {
      if (streamId === null) early.push(c);
      else if (c.streamId === streamId) handle(c);
    });
    call('logs:start', {
      namespace: pod.metadata.namespace!,
      pod: pod.metadata.name,
      container,
      follow: follow && !previous,
      tailLines: tail,
      sinceSeconds: since || undefined,
      timestamps,
      previous,
    })
      .then((r) => {
        if (cancelled) return void call('logs:stop', r.streamId);
        streamId = r.streamId;
        early.filter((c) => c.streamId === streamId).forEach(handle);
        setState((s) => (s === 'loading' ? 'streaming' : s));
      })
      .catch((err) => {
        setState('error');
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      off();
      if (streamId) void call('logs:stop', streamId);
    };
  }, [pod.metadata.namespace, pod.metadata.name, container, follow, previous, timestamps, tail, since, generation]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [text]);

  const lines = useMemo(() => {
    const all = text.split('\n');
    if (!search) return all;
    const s = search.toLowerCase();
    return all.filter((l) => l.toLowerCase().includes(s));
  }, [text, search]);

  const download = async () => {
    try {
      const r = await call('logs:save', `${pod.metadata.name}-${container}${previous ? '-previous' : ''}.log`, text);
      if (r.saved) toast('success', `Logs saved to ${r.path}`);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  return (
    <div className="logs">
      <div className="toolbar">
        <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container">
          {containers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={since} onChange={(e) => setSince(Number(e.target.value))} aria-label="Since">
          {SINCE_OPTIONS.map((o) => (
            <option key={o.label} value={o.seconds}>
              Since: {o.label}
            </option>
          ))}
        </select>
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Tail lines">
          {[100, 500, 1000, 5000, 20000].concat(defaultTail).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>
              Tail: {n}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={follow} disabled={previous} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <label className="check">
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> Previous
        </label>
        <label className="check">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps
        </label>
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <input className="search" placeholder="Filter lines…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter log lines" />
        <span className={`stream-state state-${state}`}>{state === 'streaming' ? (follow && !previous ? 'Live' : 'Loaded') : state === 'ended' ? 'Stream ended' : state === 'loading' ? 'Loading…' : 'Error'}</span>
        <button className="btn btn-sm" onClick={() => setGeneration((g) => g + 1)}>
          Reload
        </button>
        <button className="btn btn-sm" onClick={() => setText('')}>
          Clear
        </button>
        <button className="btn btn-sm" onClick={download} disabled={!text}>
          Download
        </button>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <pre
        className={`log-output ${wrap ? 'wrap' : ''}`}
        ref={scroller}
        data-testid="log-output"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.join('\n')}
        <div ref={bottom} />
      </pre>
    </div>
  );
}
