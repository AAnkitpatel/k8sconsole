import { useState } from 'react';
import { stringify } from 'yaml';
import type { ResourceRef } from '../../shared/types';
import { validateManifest } from '../../shared/validation';
import { call, errorMessage } from '../lib/api';
import { Modal, useToast } from '../components/Dialogs';
import { YamlEditor } from '../components/YamlEditor';

function template(ref: ResourceRef, namespace: string): string {
  const meta: Record<string, unknown> = { name: 'example' };
  if (ref.namespaced) meta.namespace = namespace || 'default';
  const obj: Record<string, unknown> = { apiVersion: ref.apiVersion, kind: ref.kind, metadata: meta };
  if (ref.kind === 'ConfigMap') obj.data = { key: 'value' };
  if (ref.kind === 'Deployment') {
    obj.spec = {
      replicas: 1,
      selector: { matchLabels: { app: 'example' } },
      template: { metadata: { labels: { app: 'example' } }, spec: { containers: [{ name: 'app', image: 'nginx:1.27', ports: [{ containerPort: 80 }] }] } },
    };
  }
  return stringify(obj);
}

export function CreateResourceDialog({ refInfo, namespace, dark, onClose }: { refInfo: ResourceRef; namespace: string; dark: boolean; onClose: () => void }) {
  const [text, setText] = useState(() => template(refInfo, namespace));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const toast = useToast();
  const v = validateManifest(text);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const results = await call('resource:apply', text, { dryRun, mode: 'create' });
      const failed = results.filter((r) => !r.ok);
      if (failed.length) setMessage({ kind: 'error', text: failed.map((f) => f.error).join('\n') });
      else if (dryRun) setMessage({ kind: 'ok', text: `Dry run succeeded for ${results.length} object(s).` });
      else {
        toast('success', `Created ${results.map((r) => `${r.object?.kind}/${r.object?.metadata.name}`).join(', ')}`);
        onClose();
      }
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Create ${refInfo.kind}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!v.ok || busy} onClick={() => void run(true)}>
            Validate (dry run)
          </button>
          <button className="btn btn-primary" disabled={!v.ok || busy} onClick={() => void run(false)}>
            Create
          </button>
        </>
      }
    >
      <p className="muted">Paste or write one or more YAML documents. Objects are validated locally, then by the API server.</p>
      {message && <div className={message.kind === 'error' ? 'inline-error pre' : 'inline-ok'}>{message.text}</div>}
      <div className="create-editor">
        <YamlEditor value={text} onChange={setText} dark={dark} />
      </div>
    </Modal>
  );
}
