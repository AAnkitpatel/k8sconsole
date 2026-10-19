import { useEffect, useMemo, useRef, useState } from 'react';
import type { EcsLogEvent, EcsLogSource } from '../../shared/ecs';
import { call, errorMessage, on } from '../lib/api';
import { useToast } from '../components/Dialogs';

const SINCE = [
  { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 },
  { label: '6h', sec: 21600 },
  { label: '24h', sec: 86400 },
  { label: '7d', sec: 604800 },
];
const MAX_LINES = 20000;

/** CloudWatch logs of a task container or a whole service, following new lines while open. */
export function EcsLogPanel({ cluster, taskArn, serviceName, containers, title }: { cluster: string; taskArn?: string; serviceName?: string; containers: string[]; title: string }) {
  const [container, setContainer] = useState(containers[0] ?? '');
  const [since, setSince] = useState(900);
  const [follow, setFollow] = useState(true);
  const [pattern, setPattern] = useState('');
  const [applied, setApplied] = useState('');
  const [lines, setLines] = useState<EcsLogEvent[]>([]);
  const [sources, setSources] = useState<EcsLogSource[]>([]);
  const [state, setState] = useState<'loading' | 'streaming' | 'ended' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [timestamps, setTimestamps] = useState(true);
  const [find, setFind] = useState('');
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const toast = useToast();

  useEffect(() => {
    if (!containers.includes(container)) setContainer(containers[0] ?? '');
  }, [containers, container]);

  useEffect(() => {
    let id: string | null = null;
    let cancelled = false;
    setLines([]);
    setError(null);
    setState('loading');
    const off = on('ecs:logs', (c) => {
      if (c.streamId !== id) return;
      if (c.events?.length) setLines((l) => [...l, ...c.events!].slice(-MAX_LINES));
      if (c.events) setState((s) => (s === 'loading' ? (follow ? 'streaming' : s) : s));
      if (c.error) setError(c.error);
      if (c.end) setState(c.error ? 'error' : 'ended');
    });
    call('ecs:logsStart', { clusterArn: cluster, taskArn, serviceName, container: container || undefined, sinceSeconds: since, follow, filterPattern: applied || undefined })
      .then((r) => {
        if (cancelled) return void call('ecs:logsStop', r.streamId);
        id = r.streamId;
        setSources(r.sources);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setState('error');
      });
    return () => {
      cancelled = true;
      off();
      if (id) void call('ecs:logsStop', id);
    };
  }, [cluster, taskArn, serviceName, container, since, follow, applied]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const text = useMemo(() => {
    const f = find.trim().toLowerCase();
    const shown = f ? lines.filter((l) => l.message.toLowerCase().includes(f)) : lines;
    return shown.map((l) => (timestamps ? `${new Date(l.t).toISOString().replace('T', ' ').slice(0, 23)}  ${l.message}` : l.message)).join('\n');
  }, [lines, timestamps, find]);

  const save = async () => {
    try {
      const r = await call('logs:save', `${title.replace(/[^\w.-]+/g, '_')}.log`, text);
      if (r.saved) toast('success', `Saved to ${r.path}`);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const src = sources.find((s) => s.container === container) ?? sources[0];

  return (
    <div className="logs ecs-logs" data-testid="ecs-logs">
      <div className="toolbar">
        {containers.length > 1 && (
          <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container">
            {containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <div className="segmented" role="radiogroup" aria-label="Look back">
          {SINCE.map((s) => (
            <button key={s.sec} role="radio" aria-checked={since === s.sec} className={since === s.sec ? 'active' : ''} onClick={() => setSince(s.sec)}>
              {s.label}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <label className="check">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(pattern.trim());
          }}
        >
          <input className="search" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder='CloudWatch filter, e.g. ERROR or "timed out"' aria-label="CloudWatch filter pattern" title="Filter pattern evaluated by CloudWatch Logs (press Enter)" />
        </form>
        <input className="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find in loaded lines…" aria-label="Find in logs" />
        <div className="spacer" />
        <span className={`stream-state state-${state === 'streaming' ? 'streaming' : state === 'error' ? 'error' : 'ended'}`}>
          {state === 'loading' ? 'Loading…' : state === 'streaming' ? 'Following' : state === 'error' ? 'Error' : 'Loaded'} · {lines.length} lines
        </span>
        <button className="btn btn-sm" onClick={() => void save()} disabled={!lines.length}>
          Save
        </button>
      </div>
      {src && (
        <div className="muted ecs-log-src">
          {src.group}
          {src.region ? ` (${src.region})` : ''} · {taskArn ? `stream ${src.streamPrefix ? `${src.streamPrefix}/${src.container}/…` : 'by container id'}` : 'all tasks of the service'}
        </div>
      )}
      {error && <div className="inline-warn">{error}</div>}
      <pre
        className="log-output"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        data-testid="ecs-log-output"
      >
        {text || (state === 'loading' ? '' : 'No log lines in this period.')}
      </pre>
    </div>
  );
}
