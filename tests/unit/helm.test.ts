import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findExecutable, HelmClient } from '../../build/app/src/main/helm';

let dir: string;
let fake: string;
let argsLog: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'k8sc-helm-'));
  argsLog = join(dir, 'args.log');
  fake = join(dir, 'helm');
  // Fake helm: records argv (one per line) and prints canned output.
  writeFileSync(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argsLog}"
case "$1" in
  version) echo "v3.99.0+gtest" ;;
  list) echo '[{"name":"web","namespace":"apps","revision":"3","updated":"now","status":"deployed","chart":"web-1.2.3","app_version":"1.0"}]' ;;
  history) echo '[{"revision":1,"updated":"a","status":"superseded","chart":"web-1.0.0","app_version":"1.0","description":"Install complete"}]' ;;
  get) echo "replicaCount: 2" ;;
  fail) echo "Error: release not found" >&2; exit 1 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(fake, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const args = () => readFileSync(argsLog, 'utf8').trim().split('\n');

// The fake helm is a POSIX shell script; Windows cannot execute it (Windows lookup rules are tested in terminal.test.ts).
describe.skipIf(process.platform === 'win32')('HelmClient', () => {
  const target = { kubeconfigPath: '/tmp/kc; rm -rf /', context: 'ctx $(whoami)' };

  it('lists releases across namespaces, passing kubeconfig and context as separate argv entries (no shell)', async () => {
    const h = new HelmClient(fake, target);
    const r = await h.list();
    expect(r[0]).toMatchObject({ name: 'web', namespace: 'apps', status: 'deployed' });
    expect(args()).toEqual(['list', '--output', 'json', '--max', '0', '--all-namespaces', '--kubeconfig', '/tmp/kc; rm -rf /', '--kube-context', 'ctx $(whoami)']);
  });

  it('scopes to a namespace and fetches history, values and manifest', async () => {
    const h = new HelmClient(fake, target);
    await h.list('apps');
    expect(args().slice(0, 6)).toEqual(['list', '--output', 'json', '--max', '0', '--namespace']);
    expect((await h.history('apps', 'web'))[0].revision).toBe(1);
    expect(await h.values('apps', 'web', true)).toContain('replicaCount');
    expect(args()).toContain('--all');
    await h.manifest('apps', 'web');
    expect(args().slice(0, 3)).toEqual(['get', 'manifest', 'web']);
  });

  it('rolls back and uninstalls with validated arguments', async () => {
    const h = new HelmClient(fake, target);
    await h.rollback('apps', 'web', 2);
    expect(args().slice(0, 3)).toEqual(['rollback', 'web', '2']);
    await h.uninstall('apps', 'web');
    expect(args().slice(0, 2)).toEqual(['uninstall', 'web']);
    await expect(h.rollback('apps', 'web', 0)).rejects.toThrow(/revision/);
    await expect(h.uninstall('apps', '--all')).rejects.toThrow(/Invalid/);
    await expect(h.history('../x', 'web')).rejects.toThrow(/Invalid/);
  });

  it('surfaces helm stderr on failure', async () => {
    await expect(new HelmClient(fake, target).run(['fail'])).rejects.toThrow('release not found');
  });

  it('reads the version', async () => {
    expect(await new HelmClient(fake, target).version()).toBe('v3.99.0+gtest');
  });
});

describe.skipIf(process.platform === 'win32')('findExecutable', () => {
  it('finds executables on PATH and validates explicit paths', () => {
    expect(findExecutable('helm', undefined, `/nonexistent${delimiter}${dir}`)).toBe(fake);
    expect(findExecutable('helm', fake)).toBe(fake);
    expect(findExecutable('helm', 'relative/helm')).toBeNull();
    expect(findExecutable('helm', undefined, '/nonexistent')).toBeNull();
  });
});
