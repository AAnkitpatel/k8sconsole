import { McpSettings } from './ExtensionsView';
import { useEffect, useState } from 'react';
import type { AppSettings, AssistantStatus } from '../../shared/types';
import { call, errorMessage } from '../lib/api';
import { useToast } from '../components/Dialogs';

export function SettingsView({ settings, onChange }: { settings: AppSettings; onChange: (s: AppSettings) => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof call<'app:info'>>> | null>(null);
  const [helm, setHelm] = useState<{ available: boolean; version?: string; path?: string } | null>(null);
  const [helmPath, setHelmPath] = useState(settings.helmPath);
  const [tail, setTail] = useState(String(settings.logTailLines));
  const [ai, setAi] = useState<AssistantStatus | null>(null);
  useEffect(() => {
    void call('assistant:status').then(setAi);
  }, [settings.assistantModel]);

  useEffect(() => {
    void call('app:info').then(setInfo);
    void call('helm:available').then(setHelm);
  }, [settings.helmPath]);

  const update = async (patch: Partial<AppSettings>) => {
    try {
      onChange(await call('settings:update', patch));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const tailNum = Number(tail);
  const tailValid = Number.isInteger(tailNum) && tailNum >= 10 && tailNum <= 100000;

  return (
    <div className="settings-view">
      <div className="view-header">
        <h1>Settings</h1>
      </div>
      <section className="panel">
        <h3>Appearance</h3>
        <label className="field inline">
          <span>Theme</span>
          <select value={settings.theme} onChange={(e) => void update({ theme: e.target.value as AppSettings['theme'] })} aria-label="Theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Follow system</option>
          </select>
        </label>
      </section>
      <section className="panel">
        <h3>Safety</h3>
        <label className="check">
          <input type="checkbox" checked={settings.confirmDestructiveActions} onChange={(e) => void update({ confirmDestructiveActions: e.target.checked })} />
          Ask for confirmation before changes, and require typing the resource name before deleting or draining
        </label>
      </section>
      <section className="panel">
        <h3>Logs</h3>
        <label className="field inline">
          <span>Default tail lines</span>
          <input value={tail} onChange={(e) => setTail(e.target.value)} onBlur={() => tailValid && void update({ logTailLines: tailNum })} aria-invalid={!tailValid} />
        </label>
        {!tailValid && <div className="field-error">Enter a whole number between 10 and 100000.</div>}
        <label className="check">
          <input type="checkbox" checked={settings.logTimestamps} onChange={(e) => void update({ logTimestamps: e.target.checked })} /> Show timestamps by default
        </label>
      </section>
      <section className="panel">
        <h3>YAML</h3>
        <label className="check">
          <input type="checkbox" checked={settings.hideManagedFields} onChange={(e) => void update({ hideManagedFields: e.target.checked })} /> Hide metadata.managedFields in the editor
        </label>
      </section>
      <section className="panel">
        <h3>Helm</h3>
        <label className="field inline">
          <span>helm binary</span>
          <input placeholder="Look up on PATH" value={helmPath} onChange={(e) => setHelmPath(e.target.value)} onBlur={() => void update({ helmPath: helmPath.trim() })} />
        </label>
        <p className="muted">{helm ? (helm.available ? `Found ${helm.version} at ${helm.path}` : 'helm was not found.') : 'Checking…'}</p>
      </section>
      <section className="panel">
        <h3>AI Assistant</h3>
        <p className="muted">
          {ai ? (ai.configured ? `Connected using ${ai.source === 'stored-key' ? 'the API key saved on this computer (encrypted)' : 'ANTHROPIC_API_KEY from the environment'}.` : 'Not set up. Open the Assistant panel to add a Claude API key.') : 'Checking…'}
        </p>
        <label className="field inline">
          <span>Model</span>
          <select value={settings.assistantModel} onChange={(e) => void update({ assistantModel: e.target.value as AppSettings['assistantModel'] })} aria-label="Assistant model">
            <option value="claude-opus-5-5">Claude Opus 5.5 (most capable)</option>
            <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (faster)</option>
            <option value="claude-haiku-5-5">Claude Haiku 5.5 (fastest, lowest cost)</option>
          </select>
        </label>
        <label className="field inline">
          <span>Effort</span>
          <select value={settings.assistantEffort} onChange={(e) => void update({ assistantEffort: e.target.value as AppSettings['assistantEffort'] })} aria-label="Assistant effort">
            <option value="low">Low: quick answers</option>
            <option value="medium">Medium (recommended)</option>
            <option value="high">High: deeper investigation</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.assistantReadLogs} onChange={(e) => void update({ assistantReadLogs: e.target.checked })} /> Allow the assistant to read pod logs (log lines are sent to the Claude API)
        </label>
        {ai?.source === 'stored-key' && (
          <div className="toolbar">
            <button className="btn btn-sm btn-danger" onClick={() => void call('assistant:setKey', null).then(setAi)}>
              Remove saved API key
            </button>
          </div>
        )}
      </section>
      <McpSettings />
      <section className="panel">
        <h3>About</h3>
        {info && (
          <dl className="props">
            <dt>Version</dt>
            <dd>K8sConsole {info.version}</dd>
            <dt>Runtime</dt>
            <dd>
              Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
            </dd>
            <dt>Platform</dt>
            <dd>{info.platform}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
