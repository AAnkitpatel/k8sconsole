import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { buildSuggestions, overlayKubeconfig, resolveShell, shellEnv } from '../../build/app/src/main/terminal-setup';
import { TerminalManager } from '../../build/app/src/main/terminal';
import { rankSuggestions } from '../../build/app/src/renderer/lib/suggest';
import type { TerminalData } from '../../build/app/src/shared/types';

const PLUGIN = resolve(__dirname, '../../build/app/resources/shell/zsh-autosuggestions.zsh');
const hasZsh = existsSync('/usr/bin/zsh') || existsSync('/bin/zsh');
const hasKubectl = (process.env.PATH ?? '').split(':').some((d) => existsSync(join(d, 'kubectl')));

describe('terminal setup', () => {
  it('resolves shells by preference and availability', () => {
    const all = (p: string) => ['/usr/bin/zsh', '/usr/bin/bash', '/bin/sh'].includes(p);
    expect(resolveShell('auto', '/usr/bin/bash', all, 'linux')).toEqual({ path: '/usr/bin/bash', flavor: 'bash' });
    expect(resolveShell('auto', undefined, all, 'linux')).toEqual({ path: '/usr/bin/zsh', flavor: 'zsh' });
    expect(resolveShell('zsh', '/usr/bin/bash', all, 'linux').flavor).toBe('zsh');
    expect(resolveShell('zsh', undefined, (p) => p === '/usr/bin/bash', 'linux').flavor).toBe('bash');
    expect(resolveShell('auto', undefined, () => false, 'linux')).toEqual({ path: '/bin/sh', flavor: 'sh' });
  });

  it('overlay kubeconfig pins context and namespace without credentials', () => {
    const doc = parse(overlayKubeconfig({ name: 'prod', cluster: 'c1', user: 'admin' }, 'payments'));
    expect(doc['current-context']).toBe('prod');
    expect(doc.contexts).toEqual([{ name: 'prod', context: { cluster: 'c1', user: 'admin', namespace: 'payments' } }]);
    expect(doc.users).toBeUndefined();
    expect(doc.clusters).toBeUndefined();
  });

  it('strips Electron/internal variables from the shell environment', () => {
    const env = shellEnv({ PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', K8SC_USER_DATA_DIR: '/x', CHROME_DESKTOP: 'y' }, { KUBECONFIG: '/k' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', TERM: 'xterm-256color', KUBECONFIG: '/k' });
    expect(Object.keys(env).some((k) => /^(ELECTRON_|K8SC_|NODE_OPTIONS|CHROME_)/.test(k))).toBe(false);
  });

  it('builds context-aware kubectl suggestions and drops unsafe names', () => {
    const s = buildSuggestions({ namespace: 'shop', namespaces: ['shop', 'ops'], pods: ['web-1', 'bad;rm -rf'], deployments: ['web'], statefulsets: [], services: ['web'] });
    expect(s[0]).toBe('kubectl get pods -n shop');
    expect(s).toContain('kubectl logs -f web-1 -n shop');
    expect(s).toContain('kubectl rollout restart deploy/web -n shop');
    expect(s).toContain('kubectl port-forward svc/web -n shop 8080:');
    expect(s.some((l) => l.includes(';'))).toBe(false);
    expect(new Set(s).size).toBe(s.length);
  });

  it('ranks chip suggestions by prefix, then substring', () => {
    const all = ['kubectl get pods', 'kubectl logs -f web', 'kubectl get svc', 'kubectl describe pod web'];
    expect(rankSuggestions(all, 'kubectl get')).toEqual(['kubectl get pods', 'kubectl get svc']);
    expect(rankSuggestions(all, 'web')).toEqual(['kubectl logs -f web', 'kubectl describe pod web']);
    expect(rankSuggestions(all, '', 2)).toHaveLength(2);
  });
});

describe.runIf(hasZsh)('TerminalManager with a real zsh PTY', () => {
  let dir: string;
  let mgr: TerminalManager;
  const out = new Map<string, string>();
  const exited = new Set<string>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'k8sc-term-test-'));
    mgr = new TerminalManager(
      (d: TerminalData) => {
        if (d.data) out.set(d.sessionId, (out.get(d.sessionId) ?? '') + d.data);
        if (d.exit) exited.add(d.sessionId);
      },
      { home: dir, autosuggestPlugin: PLUGIN },
    );
  });
  afterEach(() => {
    mgr.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const waitFor = async (id: string, re: RegExp, ms = 15000) => {
    const t = Date.now();
    while (!re.test(out.get(id) ?? '')) {
      if (Date.now() - t > ms) throw new Error(`timeout waiting for ${re}; got:\n${out.get(id)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return out.get(id)!;
  };

  it('pins kubectl to the bound context/namespace, loads suggestions, and never edits the user kubeconfig', async () => {
    const userKc = join(dir, 'user-kubeconfig.yaml');
    const original = [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: c1',
      '  cluster: {server: "https://127.0.0.1:1"}',
      'users:',
      '- name: u1',
      '  user: {token: secret-token}',
      'contexts:',
      '- name: other',
      '  context: {cluster: c1, user: u1}',
      '- name: prod',
      '  context: {cluster: c1, user: u1, namespace: default}',
      'current-context: other',
      '',
    ].join('\n');
    writeFileSync(userKc, original, { mode: 0o600 });
    const info = mgr.start(
      { cols: 200, rows: 40, shell: 'zsh', bindToCluster: true },
      { kubeconfigPath: userKc, context: { name: 'prod', cluster: 'c1', user: 'u1' }, namespace: 'payments', suggestions: ['kubectl logs -f web-1 -n payments', 'kubectl get pods -n payments'] },
    );
    expect(info.shell).toMatch(/zsh$/);
    expect(info.autosuggest).not.toBe('none');
    const id = info.sessionId;
    await waitFor(id, /context .*prod/);
    mgr.input(id, 'print -r -- "STRAT=${ZSH_AUTOSUGGEST_STRATEGY[*]}"\r');
    await waitFor(id, /STRAT=history k8sc completion/);
    mgr.input(id, '_zsh_autosuggest_strategy_k8sc "kubectl logs"; print -r -- "SUG=$suggestion"\r');
    await waitFor(id, /SUG=kubectl logs -f web-1 -n payments/);
    if (hasKubectl) {
      mgr.input(id, "kubectl config view --minify -o jsonpath='CTX={.contexts[0].name}/{.contexts[0].context.namespace}{\"\\n\"}'\r");
      await waitFor(id, /CTX=prod\/payments/);
      mgr.input(id, 'kubectl config set-context --current --namespace=changed >/dev/null && echo SETDONE\r');
      await waitFor(id, /SETDONE/);
      mgr.input(id, 'alias k\r');
      await waitFor(id, /k=kubectl/);
    }
    mgr.input(id, 'exit\r');
    const t = Date.now();
    while (!exited.has(id) && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 50));
    expect(exited.has(id)).toBe(true);
    // The user's kubeconfig is byte-for-byte unchanged and the session directory is gone.
    expect(readFileSync(userKc, 'utf8')).toBe(original);
    expect(mgr.count).toBe(0);
  }, 40000);

  it('starts an unbound local shell without cluster variables', async () => {
    const info = mgr.start({ cols: 80, rows: 24, shell: 'zsh', bindToCluster: false }, null);
    expect(info.context).toBeUndefined();
    mgr.input(info.sessionId, 'print -r -- "CTX=[${K8SC_CONTEXT}] TERM=$TERM RUN=[${ELECTRON_RUN_AS_NODE}]"\r');
    await waitFor(info.sessionId, /CTX=\[\] TERM=xterm-256color RUN=\[\]/);
  }, 20000);

  it('resizes and stops sessions', async () => {
    const info = mgr.start({ cols: 80, rows: 24, shell: 'zsh', bindToCluster: false }, null);
    mgr.resize(info.sessionId, 132, 43);
    mgr.input(info.sessionId, 'print -r -- "SIZE=$COLUMNS:$LINES"\r');
    await waitFor(info.sessionId, /SIZE=132:43/);
    mgr.stop(info.sessionId);
    expect(mgr.count).toBe(0);
  }, 20000);
});

describe('workingDir', () => {
  it('falls back when the configured home does not exist', async () => {
    const { workingDir } = await import('../../build/app/src/main/terminal');
    expect(workingDir('/definitely/not/here')).not.toBe('/definitely/not/here');
    expect(workingDir(tmpdir())).toBe(tmpdir());
  });
});

describe('cross-platform executables and shells', () => {
  it('finds Windows executables through PATHEXT and quoted Path entries', async () => {
    const { findExecutable, envPathOf } = await import('../../build/app/src/main/executables');
    const files = new Set(['C:\\Tools\\kubectl.exe', 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe', 'C:\\bin\\helm.cmd']);
    const has = (p: string) => files.has(p);
    const path = 'C:\\Tools;"C:\\Program Files\\Amazon\\AWSCLIV2";C:\\bin;relative\\dir';
    expect(findExecutable('kubectl', undefined, path, 'win32', has, '.COM;.EXE;.BAT;.CMD')).toBe('C:\\Tools\\kubectl.exe');
    expect(findExecutable('aws', undefined, path, 'win32', has, '.COM;.EXE;.BAT;.CMD')).toBe('C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe');
    expect(findExecutable('helm', undefined, path, 'win32', has, '.COM;.EXE;.BAT;.CMD')).toBe('C:\\bin\\helm.cmd');
    expect(findExecutable('kubectl.exe', undefined, path, 'win32', has)).toBe('C:\\Tools\\kubectl.exe');
    expect(findExecutable('session-manager-plugin', undefined, path, 'win32', has)).toBeNull();
    expect(findExecutable('helm', 'C:\\bin\\helm.cmd', '', 'win32', has)).toBe('C:\\bin\\helm.cmd');
    expect(findExecutable('helm', 'helm.cmd', '', 'win32', has)).toBeNull(); // explicit paths must be absolute
    expect(envPathOf({ Path: 'C:\\a;C:\\b' }, 'win32')).toBe('C:\\a;C:\\b');
    expect(envPathOf({ Path: 'x', PATH: '/usr/bin' }, 'linux')).toBe('/usr/bin');
  });

  it('finds POSIX executables on PATH', async () => {
    const { findExecutable } = await import('../../build/app/src/main/executables');
    const has = (p: string) => p === '/opt/homebrew/bin/kubectl';
    expect(findExecutable('kubectl', undefined, '/usr/bin:/opt/homebrew/bin', 'darwin', has)).toBe('/opt/homebrew/bin/kubectl');
    expect(findExecutable('kubectl', undefined, '/usr/bin', 'linux', has)).toBeNull();
  });

  it('picks PowerShell 7, then Windows PowerShell, then cmd on Windows', () => {
    const env = { Path: 'C:\\Program Files\\PowerShell\\7;C:\\Program Files\\Git\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.EXE' };
    const all = (p: string) => ['C:\\Program Files\\PowerShell\\7\\pwsh.EXE'.replace('.EXE', '.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'].includes(p);
    expect(resolveShell('auto', undefined, all, 'win32', env)).toEqual({ path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', flavor: 'powershell' });
    expect(resolveShell('bash', undefined, all, 'win32', env)).toEqual({ path: 'C:\\Program Files\\Git\\bin\\bash.exe', flavor: 'bash' });
    const noPwsh = (p: string) => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(resolveShell('auto', undefined, noPwsh, 'win32', env)).toEqual({ path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', flavor: 'powershell' });
    expect(resolveShell('zsh', undefined, () => false, 'win32', env)).toEqual({ path: 'C:\\Windows\\system32\\cmd.exe', flavor: 'cmd' });
  });
});
