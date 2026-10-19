import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import type { TerminalData, TerminalSessionInfo, TerminalStartRequest } from '../shared/types';
import { BASHRC, isExecutable, overlayKubeconfig, resolveShell, shellEnv, zshFiles } from './terminal-setup';

export interface ClusterBinding {
  kubeconfigPath: string;
  context: { name: string; cluster: string; user: string };
  namespace?: string;
  suggestions: string[];
}

/** Extras for a session: AWS environment and suggestions, or a command to run instead of a shell (ECS Exec). */
export interface TerminalExtras {
  env?: Record<string, string>;
  suggestions?: string[];
  command?: { file: string; args: string[] };
}

interface Session {
  pty: IPty;
  dir: string;
}

function findOnPath(name: string, pathVar = process.env.PATH ?? ''): boolean {
  return pathVar.split(':').some((d) => d && isExecutable(join(d, name)));
}

/** First existing directory among the user's home candidates (a shell cannot start in a missing cwd). */
export function workingDir(home: string): string {
  for (const d of [home, process.env.HOME, homedir(), tmpdir(), '/']) {
    try {
      if (d && existsSync(d) && statSync(d).isDirectory()) return d;
    } catch {
      // try the next candidate
    }
  }
  return '/';
}

function clamp(v: number, def: number): number {
  return Number.isInteger(v) && v > 0 && v < 1000 ? v : def;
}

/** Local shells in a real PTY (node-pty), optionally bound to the connected cluster context. */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly emit: (d: TerminalData) => void,
    private readonly opts: { home: string; autosuggestPlugin: string; spawn?: typeof import('node-pty').spawn },
  ) {}

  private loadPty(): typeof import('node-pty').spawn {
    if (this.opts.spawn) return this.opts.spawn;
    // Loaded lazily: the native module is only needed once a terminal is opened.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node-pty') as typeof import('node-pty')).spawn;
  }

  start(req: TerminalStartRequest, binding: ClusterBinding | null, extras: TerminalExtras = {}): TerminalSessionInfo {
    const resolved = resolveShell(req.shell === 'zsh' || req.shell === 'bash' ? req.shell : 'auto', process.env.SHELL);
    const shell = extras.command ? { path: extras.command.file, flavor: 'command' as const } : resolved;
    const sessionId = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), 'k8sc-term-'));
    const extra: Record<string, string> = { K8SC_SESSION: sessionId };
    if (binding) {
      const overlay = join(dir, 'kubeconfig-overlay.yaml');
      writeFileSync(overlay, overlayKubeconfig(binding.context, binding.namespace), { mode: 0o600 });
      extra.KUBECONFIG = `${overlay}:${binding.kubeconfigPath}`;
      extra.K8SC_CONTEXT = binding.context.name;
      extra.K8SC_NAMESPACE = binding.namespace ?? '';
    }
    const suggestions = [...(binding?.suggestions ?? []), ...(extras.suggestions ?? [])];
    if (suggestions.length) writeFileSync(join(dir, 'suggestions'), suggestions.join('\n') + '\n', { mode: 0o600 });
    Object.assign(extra, extras.env ?? {});
    let args: string[] = extras.command?.args ?? [];
    if (shell.flavor === 'zsh') {
      for (const [f, content] of Object.entries(zshFiles())) writeFileSync(join(dir, f), content, { mode: 0o600 });
      extra.K8SC_ORIG_ZDOTDIR = process.env.ZDOTDIR || this.opts.home;
      extra.ZDOTDIR = dir;
      extra.K8SC_AUTOSUGGEST_PLUGIN = this.opts.autosuggestPlugin;
      args = ['-i'];
    } else if (shell.flavor === 'bash') {
      writeFileSync(join(dir, 'bashrc'), BASHRC, { mode: 0o600 });
      args = ['--rcfile', join(dir, 'bashrc'), '-i'];
    }
    // K8SC_* variables set above are re-added after the generic filter strips inherited ones.
    const env = { ...shellEnv(process.env, {}), ...extra };
    const pty = this.loadPty()(shell.path, args, { name: 'xterm-256color', cols: clamp(req.cols, 80), rows: clamp(req.rows, 24), cwd: workingDir(this.opts.home), env });
    this.sessions.set(sessionId, { pty, dir });

    let buf = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (buf) {
        const data = buf;
        buf = '';
        this.emit({ sessionId, data });
      }
    };
    pty.onData((d) => {
      buf += d;
      if (buf.length > 64 * 1024) flush();
      else if (!timer) timer = setTimeout(flush, 12);
    });
    pty.onExit(({ exitCode }) => {
      if (timer) clearTimeout(timer);
      flush();
      this.cleanup(sessionId);
      this.emit({ sessionId, exit: true, error: exitCode ? `exit code ${exitCode}` : undefined });
    });

    const userAutosuggest = /zsh-autosuggestions/.test(`${process.env.ZSH ?? ''}${process.env.ZSH_CUSTOM ?? ''}`);
    return {
      sessionId,
      shell: shell.path,
      context: binding?.context.name,
      namespace: binding?.namespace,
      kubectlFound: findOnPath('kubectl', env.PATH),
      autosuggest: shell.flavor !== 'zsh' ? 'none' : userAutosuggest ? 'user' : 'bundled',
    };
  }

  input(id: string, data: string): void {
    if (typeof data === 'string' && data.length <= 1024 * 1024) this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty.resize(clamp(cols, 80), clamp(rows, 24));
    } catch {
      // the process may already have exited
    }
  }

  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.pty.kill();
    } catch {
      // already gone
    }
    this.cleanup(id);
  }

  private cleanup(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    rmSync(s.dir, { recursive: true, force: true });
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  get count(): number {
    return this.sessions.size;
  }
}
