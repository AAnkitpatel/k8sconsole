import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { KubeObject } from '../../shared/types';
import { call, errorMessage, on } from '../lib/api';

export function PodTerminal({ pod, dark }: { pod: KubeObject; dark: boolean }) {
  const containers: string[] = useMemo(() => (pod.spec?.containers ?? []).map((c: any) => c.name), [pod]);
  const [container, setContainer] = useState(containers[0] ?? '');
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [generation, setGeneration] = useState(0);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: dark ? { background: '#0b0f14', foreground: '#d6dde6' } : { background: '#ffffff', foreground: '#1d2733', cursor: '#1d2733' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    let sessionId: string | null = null;
    let disposed = false;
    const early: Array<{ sessionId: string; data?: string; exit?: boolean; error?: string }> = [];
    setState('connecting');
    term.writeln(`\x1b[90mConnecting to ${pod.metadata.namespace}/${pod.metadata.name} (${container})…\x1b[0m`);

    const handle = (d: { data?: string; exit?: boolean; error?: string }) => {
      if (d.data) term.write(d.data);
      if (d.exit) {
        setState('closed');
        term.writeln(`\r\n\x1b[90m[session closed${d.error ? `: ${d.error}` : ''}]\x1b[0m`);
      }
    };
    const off = on('exec:data', (d) => {
      if (sessionId === null) early.push(d);
      else if (d.sessionId === sessionId) handle(d);
    });
    const input = term.onData((data) => sessionId && void call('exec:input', sessionId, data));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // element hidden
      }
      if (sessionId) void call('exec:resize', sessionId, term.cols, term.rows);
    });
    ro.observe(host.current!);

    call('exec:start', { namespace: pod.metadata.namespace!, pod: pod.metadata.name, container, cols: term.cols, rows: term.rows })
      .then((r) => {
        if (disposed) return void call('exec:stop', r.sessionId);
        sessionId = r.sessionId;
        setState('open');
        early.filter((d) => d.sessionId === sessionId).forEach(handle);
        term.focus();
      })
      .catch((err) => {
        setState('closed');
        term.writeln(`\r\n\x1b[31m${errorMessage(err)}\x1b[0m`);
      });

    return () => {
      disposed = true;
      off();
      input.dispose();
      ro.disconnect();
      if (sessionId) void call('exec:stop', sessionId);
      term.dispose();
    };
  }, [pod.metadata.namespace, pod.metadata.name, container, generation, dark]);

  return (
    <div className="terminal-pane">
      <div className="toolbar">
        <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container">
          {containers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <span className={`stream-state state-${state === 'open' ? 'streaming' : state === 'closed' ? 'ended' : 'loading'}`}>{state === 'open' ? 'Connected' : state === 'closed' ? 'Closed' : 'Connecting…'}</span>
        <button className="btn btn-sm" onClick={() => setGeneration((g) => g + 1)}>
          Reconnect
        </button>
      </div>
      <div className="xterm-host" ref={host} data-testid="terminal" />
    </div>
  );
}
