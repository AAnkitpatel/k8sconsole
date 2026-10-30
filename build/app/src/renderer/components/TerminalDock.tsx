import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ShellKind, TerminalSessionInfo } from '../../shared/types';
import { call, errorMessage, on } from '../lib/api';
import { rankSuggestions } from '../lib/suggest';

interface Tab {
  key: number;
  title: string;
  shell: ShellKind;
  bind: boolean;
  namespace: string;
  /** Bind the aws CLI to the connected AWS profile/region (and ECS cluster for suggestions). */
  aws?: { cluster?: string };
  /** An ECS Exec session into a container instead of a local shell. */
  exec?: EcsExecTarget;
  /** Typed into the shell once it starts (not run): extension commands. */
  initialInput?: string;
}

export interface EcsExecTarget {
  cluster: string;
  task: string;
  container: string;
  title: string;
}

function TermPane({ tab, active, dark, onTitle, onExit }: { tab: Tab; active: boolean; dark: boolean; onTitle: (t: string) => void; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const lastOutput = useRef(0);
  const [info, setInfo] = useState<TerminalSessionInfo | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [line, setLine] = useState('');
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: false,
      theme: dark ? { background: '#0b0f14', foreground: '#d6dde6' } : { background: '#ffffff', foreground: '#1d2733', cursor: '#1d2733', selectionBackground: '#cde2fb' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // hidden on mount
    }
    let disposed = false;
    const early: Array<{ sessionId: string; data?: string; exit?: boolean; error?: string }> = [];
    const handle = (d: { data?: string; exit?: boolean; error?: string }) => {
      if (d.data) {
        term.write(d.data);
        lastOutput.current = Date.now();
      }
      if (d.exit) {
        setClosed(true);
        term.writeln(`\r\n\x1b[90m[process exited${d.error ? `: ${d.error}` : ''}]\x1b[0m`);
        onExit();
      }
    };
    const off = on('terminal:data', (d) => {
      if (sessionRef.current === null) early.push(d);
      else if (d.sessionId === sessionRef.current) handle(d);
    });
    // Track the typed line locally (best effort) to drive the suggestion bar.
    const input = term.onData((data) => {
      if (!sessionRef.current) return;
      void call('terminal:input', sessionRef.current, data);
      setLine((l) => {
        if (data === '\r' || data === '\x03' || data === '\x15') return '';
        if (data === '\x7f') return l.slice(0, -1);
        if (/^[\x20-\x7e]+$/.test(data)) return l + data;
        return l;
      });
    });
    const title = term.onTitleChange((t) => onTitle(t));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (sessionRef.current) void call('terminal:resize', sessionRef.current, term.cols, term.rows);
    });
    ro.observe(host.current!);

    const started = tab.exec
      ? call('ecs:execStart', tab.exec.cluster, tab.exec.task, tab.exec.container, term.cols, term.rows)
      : call('terminal:start', { cols: term.cols, rows: term.rows, shell: tab.shell, bindToCluster: tab.bind, namespace: tab.namespace || undefined, bindToAws: !!tab.aws, ecsCluster: tab.aws?.cluster });
    if (tab.exec) term.writeln(`\x1b[90mStarting ECS Exec into ${tab.exec.title} (aws ecs execute-command)…\x1b[0m`);
    started
      .then((i) => {
        if (disposed) return void call('terminal:stop', i.sessionId);
        sessionRef.current = i.sessionId;
        setInfo(i);
        early.filter((d) => d.sessionId === i.sessionId).forEach(handle);
        term.focus();
        // Type the command (without pressing Enter) once the shell has printed its prompt and gone quiet.
        if (tab.initialInput) {
          const started = Date.now();
          const tick = setInterval(() => {
            if (disposed || !sessionRef.current) return clearInterval(tick);
            const quiet = lastOutput.current > 0 && Date.now() - lastOutput.current > 400;
            if (quiet || Date.now() - started > 8000) {
              clearInterval(tick);
              void call('terminal:input', sessionRef.current, '\x15' + tab.initialInput);
            }
          }, 150);
        }
      })
      .catch((err) => term.writeln(`\x1b[31m${errorMessage(err)}\x1b[0m`));
    if (tab.bind) void call('terminal:suggestions', tab.namespace || undefined).then(setSuggestions).catch(() => undefined);

    return () => {
      disposed = true;
      off();
      input.dispose();
      title.dispose();
      ro.disconnect();
      if (sessionRef.current) void call('terminal:stop', sessionRef.current);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      termRef.current?.focus();
    });
  }, [active]);

  const chips = useMemo(() => rankSuggestions(suggestions, line), [suggestions, line]);

  const insert = (cmd: string) => {
    if (!sessionRef.current) return;
    // Replace the current line (Ctrl+U) and type the command without running it.
    void call('terminal:input', sessionRef.current, '\x15' + cmd);
    setLine(cmd);
    termRef.current?.focus();
  };

  return (
    <div className="term-pane" style={{ display: active ? 'flex' : 'none' }}>
      {tab.bind && chips.length > 0 && !closed && (
        <div className="term-suggest" role="toolbar" aria-label="kubectl suggestions">
          <span className="muted">kubectl:</span>
          {chips.map((c) => (
            <button key={c} className="chip chip-btn" onClick={() => insert(c)} title="Insert into the terminal (does not run it)">
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="term-host" ref={host} data-testid="dock-terminal" />
      {info && (
        <div className="term-status">
          {tab.exec ? 'ECS Exec' : info.shell.split('/').pop()}
          {tab.exec ? ` · ${tab.exec.title}` : info.context ? ` · ${info.context}${info.namespace ? `/${info.namespace}` : ''}` : tab.aws ? ' · aws CLI bound to the AWS connection' : ' · not bound to a cluster'}
          {info.autosuggest !== 'none' && ` · autosuggest: ${info.autosuggest === 'user' ? 'your zsh-autosuggestions' : 'bundled'}`}
          {!info.kubectlFound && tab.bind && ' · kubectl not found on PATH'}
        </div>
      )}
    </div>
  );
}

export function TerminalDock({
  open,
  onClose,
  connected,
  namespace,
  dark,
  contextName,
  aws,
  execRequest,
  typeRequest,
}: {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  namespace: string;
  dark: boolean;
  contextName?: string;
  /** Set while an AWS connection is active (and the ECS workspace is shown). */
  aws?: { label: string; cluster?: string; clusterName?: string };
  /** Each new value opens an ECS Exec tab. */
  execRequest?: { id: number; target: EcsExecTarget } | null;
  /** Each new value opens a terminal with a command typed in (not run). */
  typeRequest?: { id: number; text: string; title?: string; aws: boolean } | null;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [shell, setShell] = useState<ShellKind>('auto');
  const [height, setHeight] = useState(320);
  const nextKey = useRef(1);

  const add = useCallback(
    (bind: boolean) => {
      const key = nextKey.current++;
      const t: Tab = { key, title: bind && contextName ? `${contextName}${namespace ? '/' + namespace : ''}` : 'local', shell, bind: bind && connected, namespace };
      setTabs((x) => [...x, t]);
      setActive(key);
    },
    [shell, connected, namespace, contextName],
  );

  const addAws = useCallback(() => {
    if (!aws) return;
    const key = nextKey.current++;
    setTabs((x) => [...x, { key, title: `aws ${aws.label}${aws.clusterName ? ` · ${aws.clusterName}` : ''}`, shell, bind: false, namespace: '', aws: { cluster: aws.cluster } }]);
    setActive(key);
  }, [aws, shell]);

  useEffect(() => {
    if (open && tabs.length === 0 && !execRequest && !typeRequest) {
      if (aws) addAws();
      else add(connected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lastExec = useRef(0);
  useEffect(() => {
    if (!execRequest || execRequest.id === lastExec.current) return;
    lastExec.current = execRequest.id;
    const key = nextKey.current++;
    setTabs((x) => [...x, { key, title: `exec ${execRequest.target.title}`, shell: 'auto', bind: false, namespace: '', exec: execRequest.target }]);
    setActive(key);
  }, [execRequest]);

  const lastType = useRef(0);
  useEffect(() => {
    if (!typeRequest || typeRequest.id === lastType.current) return;
    lastType.current = typeRequest.id;
    const key = nextKey.current++;
    const t: Tab = typeRequest.aws && aws
      ? { key, title: typeRequest.title ?? 'aws', shell, bind: false, namespace: '', aws: { cluster: aws.cluster }, initialInput: typeRequest.text }
      : { key, title: typeRequest.title ?? 'command', shell, bind: connected, namespace, initialInput: typeRequest.text };
    setTabs((x) => [...x, t]);
    setActive(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeRequest]);

  const close = (key: number) => {
    setTabs((x) => {
      const rest = x.filter((t) => t.key !== key);
      if (active === key) setActive(rest[rest.length - 1]?.key ?? null);
      if (rest.length === 0) onClose();
      return rest;
    });
  };

  const startDrag = (e: React.MouseEvent) => {
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => setHeight(Math.min(window.innerHeight - 120, Math.max(160, startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="term-dock" style={{ height, display: open ? 'flex' : 'none' }} aria-label="Terminal">
      <div className="term-resize" onMouseDown={startDrag} />
      <div className="term-tabs">
        {tabs.map((t) => (
          <div key={t.key} className={`term-tab ${active === t.key ? 'active' : ''}`} onClick={() => setActive(t.key)}>
            <span>{t.title}</span>
            <button className="icon-btn" aria-label="Close terminal" onClick={(e) => (e.stopPropagation(), close(t.key))}>
              ×
            </button>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => add(true)} disabled={!connected} title="New terminal bound to the current cluster and namespace" data-testid="new-cluster-terminal">
          + Cluster shell
        </button>
        {aws && (
          <button className="btn btn-sm" onClick={addAws} title="New terminal with the aws CLI bound to the connected AWS profile and region" data-testid="new-aws-terminal">
            + AWS shell
          </button>
        )}
        <button className="btn btn-sm" onClick={() => add(false)} title="New local terminal">
          + Local
        </button>
        <select value={shell} onChange={(e) => setShell(e.target.value as ShellKind)} aria-label="Shell">
          <option value="auto">Shell: auto</option>
          <option value="zsh">zsh</option>
          <option value="bash">bash</option>
        </select>
        <div className="spacer" />
        <span className="muted kbd-hint">Ctrl+` toggles</span>
        <button className="icon-btn" aria-label="Hide terminal" onClick={onClose}>
          ⌄
        </button>
      </div>
      <div className="term-panes">
        {tabs.map((t) => (
          <TermPane
            key={t.key}
            tab={t}
            active={active === t.key && open}
            dark={dark}
            onTitle={(title) => setTabs((x) => x.map((y) => (y.key === t.key && title ? { ...y, title } : y)))}
            onExit={() => undefined}
          />
        ))}
      </div>
    </div>
  );
}
