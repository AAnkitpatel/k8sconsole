import { useState } from 'react';
import { EXAMPLE_EXTENSION } from '../../shared/extensions';
import { call, errorMessage } from '../lib/api';
import { Modal, useDialogs, useToast } from '../components/Dialogs';
import { YamlEditor } from '../components/YamlEditor';
import { LoadState, useLoad } from '../ecs/common';

const SEV_ICON: Record<string, string> = { critical: '⛔', high: '▲', medium: '◆', low: '●' };

export function ExtensionsView({ namespace, connected, dark }: { namespace: string; connected: boolean; dark: boolean }) {
  const list = useLoad(() => call('extensions:list'), []);
  const findings = useLoad(() => (connected ? call('extensions:findings', namespace || undefined) : Promise.resolve(null)), [namespace, connected, list.updatedAt]);
  const [pasting, setPasting] = useState(false);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useDialogs();
  const toast = useToast();

  const after = async (p: Promise<unknown>, ok: string) => {
    try {
      await p;
      toast('success', ok);
      await list.reload();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };
  const installFile = async () => {
    try {
      const r = await call('extensions:installFile');
      if (r.installed) {
        toast('success', `Installed ${r.installed}`);
        await list.reload();
      }
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };
  const installJson = async () => {
    setError(null);
    try {
      const r = await call('extensions:installJson', json);
      toast('success', `Installed ${r.installed}`);
      setPasting(false);
      await list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const installed = list.data?.installed ?? [];
  return (
    <div className="security-view platform-view ecs-pad" data-testid="extensions-view">
      <div className="view-header">
        <h1>Extensions</h1>
        <span className="count">{installed.length}</span>
        <span className="muted">declarative add-ons: terminal commands, links and policy rules. No third-party code runs in the app.</span>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => (setJson(JSON.stringify(EXAMPLE_EXTENSION, null, 2)), setError(null), setPasting(true))} data-testid="ext-add-json">
          Add from JSON
        </button>
        <button className="btn btn-sm" onClick={() => void installFile()}>
          Install file…
        </button>
        <button className="btn btn-sm" onClick={() => void call('extensions:openFolder')}>
          Open folder
        </button>
      </div>
      <LoadState loading={list.loading && !list.data} error={list.error} what="extensions" />
      {list.data?.errors.map((e) => (
        <div key={e.path} className="inline-error">
          <b>{e.path}</b>: {e.errors.join('; ')}
        </div>
      ))}
      {list.data && installed.length === 0 && (
        <div className="empty">
          <p>No extensions installed.</p>
          <p className="muted">
            An extension is a folder with an <code>extension.json</code> in <code>{list.data.folder}</code>. Click <b>Add from JSON</b> to start from an example.
          </p>
        </div>
      )}
      <div className="cards">
        {installed.map(({ manifest: m, enabled }) => (
          <div key={m.id} className={`card ext-card ${enabled ? '' : 'ext-off'}`} data-testid="ext-card">
            <div className="card-title">
              {m.name} <span className="muted">v{m.version}</span>
            </div>
            <div className="card-sub">{m.description}</div>
            <div className="card-sub">
              {m.commands.length} commands · {m.links.length} links · {m.rules.length} rules{m.author ? ` · by ${m.author}` : ''}
            </div>
            <div className="toolbar">
              <label className="check">
                <input type="checkbox" checked={enabled} onChange={(e) => void after(call('extensions:setEnabled', m.id, e.target.checked), `${m.name} ${e.target.checked ? 'enabled' : 'disabled'}`)} data-testid="ext-enabled" /> Enabled
              </label>
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  if (await confirm({ title: 'Remove extension', message: `Remove ${m.name}? Its folder is deleted.`, danger: true, confirmLabel: 'Remove' })) void after(call('extensions:remove', m.id), `Removed ${m.name}`);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      {connected && installed.some((e) => e.enabled && e.manifest.rules.length) && (
        <>
          <h3 className="sub-h">Policy results{namespace ? ` in ${namespace}` : ''}</h3>
          <LoadState loading={findings.loading && !findings.data} error={findings.error} what="policy results" />
          {findings.data?.notes.map((n) => (
            <div key={n} className="muted ecs-hint">
              {n}
            </div>
          ))}
          <div className="findings">
            {findings.data?.findings.map((f, i) => (
              <div key={i} className={`finding sev-${f.severity}`} data-testid="ext-finding">
                <div className="finding-head">
                  <span className={`sev-chip sev-${f.severity}`}>
                    {SEV_ICON[f.severity]} {f.severity}
                  </span>
                  <span className="finding-title">{f.title}</span>
                  <span className="muted finding-target">
                    {f.kind} {f.namespace ? `${f.namespace}/` : ''}
                    {f.name}
                  </span>
                </div>
                <div className="finding-body">
                  <p>{f.detail}</p>
                  {f.remediation && (
                    <p>
                      <b>Remediation:</b> {f.remediation}
                    </p>
                  )}
                  <p className="muted">Rule {f.rule} from extension {f.extension}</p>
                </div>
              </div>
            ))}
            {findings.data && findings.data.findings.length === 0 && <div className="empty">Every object passes the enabled rules.</div>}
          </div>
        </>
      )}
      {pasting && (
        <Modal
          wide
          title="Add extension from JSON"
          onClose={() => setPasting(false)}
          footer={
            <>
              <button className="btn" onClick={() => setPasting(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void installJson()} data-testid="ext-install">
                Install
              </button>
            </>
          }
        >
          <p className="muted">
            Commands use placeholders such as <code>{'{{name}}'}</code>, <code>{'{{namespace}}'}</code>, <code>{'{{kind}}'}</code>, <code>{'{{context}}'}</code>, <code>{'{{cluster}}'}</code>, <code>{'{{service}}'}</code> and <code>{'{{region}}'}</code>. Rules check a dotted path with <code>exists</code>, <code>absent</code>, <code>equals</code>, <code>not-equals</code>, <code>matches</code> or <code>not-matches</code>.
          </p>
          <div className="create-editor">
            <YamlEditor value={json} onChange={setJson} dark={dark} language="json" />
          </div>
          {error && <div className="inline-error pre">{error}</div>}
        </Modal>
      )}
    </div>
  );
}

export function McpSettings() {
  const st = useLoad(() => call('mcp:status'), []);
  const [port, setPort] = useState('');
  // Shown at once while the server starts or stops.
  const [pending, setPending] = useState<boolean | null>(null);
  const toast = useToast();
  const s = st.data;
  const apply = async (enabled: boolean) => {
    setPending(enabled);
    try {
      const p = port.trim() ? Number(port) : undefined;
      if (p !== undefined && (!Number.isInteger(p) || p < 1024 || p > 65535)) throw new Error('Port must be 1024–65535');
      const r = await call('mcp:setEnabled', enabled, p);
      if (r.error) toast('error', r.error);
      await st.reload();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setPending(null);
    }
  };
  const command = s ? `claude mcp add --transport http k8sconsole ${s.url} --header "Authorization: Bearer ${s.token}"` : '';
  const json = s ? JSON.stringify({ mcpServers: { k8sconsole: { type: 'http', url: s.url, headers: { Authorization: `Bearer ${s.token}` } } } }, null, 2) : '';
  return (
    <section className="panel" data-testid="mcp-settings">
      <h3>MCP server</h3>
      <p className="muted">
        Lets AI tools on this computer (Claude Code, Claude Desktop, Cursor, VS Code) use K8sConsole's read-only tools against the cluster and AWS account connected here: resources, events, logs, metrics, security, GitOps, cost and image vulnerabilities. Nothing can be changed through it. It listens on 127.0.0.1 only and needs the token below.
      </p>
      <LoadState loading={st.loading && !s} error={st.error} what="MCP status" />
      {s && (
        <>
          <div className="toolbar">
            <label className="check">
              <input type="checkbox" checked={pending ?? s.enabled} disabled={pending !== null} onChange={(e) => void apply(e.target.checked)} data-testid="mcp-enabled" /> Enable MCP server
            </label>
            <label className="field inline-field">
              <span>Port</span>
              <input value={port} placeholder={s.url.match(/:(\d+)\//)?.[1]} onChange={(e) => setPort(e.target.value)} style={{ width: 90 }} aria-label="MCP port" />
            </label>
            {s.enabled && pending === null && (
              <span className={`badge ${s.running ? 'badge-ok' : 'badge-error'}`} data-testid="mcp-state">
                {s.running ? 'Running' : 'Not running'}
              </span>
            )}
          </div>
          {s.error && <div className="inline-error">{s.error}</div>}
          {s.enabled && (
            <>
              <label className="field">
                <span>Add to Claude Code</span>
                <div className="toolbar">
                  <code className="pre" style={{ flex: 1 }} data-testid="mcp-command">
                    {command}
                  </code>
                  <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(command).then(() => toast('success', 'Copied'))}>
                    Copy
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Other clients (JSON config)</span>
                <pre className="pre">{json}</pre>
              </label>
              <div className="toolbar">
                <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(json).then(() => toast('success', 'Copied'))}>
                  Copy JSON
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void call('mcp:regenerateToken').then(
                      () => (void st.reload(), toast('success', 'New token: update your AI tools')),
                      (e) => toast('error', errorMessage(e)),
                    )
                  }
                >
                  New token
                </button>
              </div>
              {s.calls.length > 0 && (
                <>
                  <h3 className="sub-h">Recent tool calls</h3>
                  <ul className="plain-list">
                    {s.calls.map((c, i) => (
                      <li key={i}>
                        <span className="muted">{new Date(c.at).toLocaleTimeString()}</span> {c.tool} {c.ok ? '' : <span className="badge badge-error">failed</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
