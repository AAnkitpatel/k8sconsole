import { useEffect, useState } from 'react';
import type { AwsConnectRequest, AwsProfileInfo } from '../../shared/ecs';
import type { AppSettings } from '../../shared/types';
import { call, errorMessage } from '../lib/api';
import { useEcs } from './state';

const KIND_LABEL: Record<AwsProfileInfo['kind'], string> = {
  static: 'access keys',
  sso: 'IAM Identity Center (SSO)',
  'assume-role': 'assumes a role',
  process: 'credential process',
  'web-identity': 'web identity',
  unknown: 'config only',
};

export function EcsConnectView({ settings }: { settings: AppSettings }) {
  const { connect, status } = useEcs();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof loadProfiles>> | null>(null);
  const [form, setForm] = useState<AwsConnectRequest>(() => settings.awsLastConnection ?? { mode: 'profile', profile: '', region: 'us-east-1', readOnly: true });
  const [useRole, setUseRole] = useState(!!settings.awsLastConnection?.assumeRoleArn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProfiles().then((i) => {
      setInfo(i);
      setForm((f) => {
        if (f.mode === 'profile' && (!f.profile || !i.profiles.some((p) => p.name === f.profile))) {
          const p = i.profiles[0];
          if (!p) return { ...f, mode: 'default' };
          return { ...f, profile: p.name, region: p.region ?? f.region };
        }
        return f;
      });
    });
  }, []);

  const pickProfile = (name: string) => {
    const p = info?.profiles.find((x) => x.name === name);
    setForm((f) => ({ ...f, profile: name, region: p?.region ?? f.region }));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await connect({ ...form, assumeRoleArn: useRole ? form.assumeRoleArn : undefined, externalId: useRole ? form.externalId : undefined });
      if (s.state === 'error') setError(s.error ?? 'Connection failed');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const profile = info?.profiles.find((p) => p.name === form.profile);

  return (
    <div className="clusters-view ecs-connect" data-testid="ecs-connect">
      <div className="view-header">
        <h1>Connect to Amazon ECS</h1>
      </div>
      <p className="intro">
        K8sConsole uses your existing AWS credentials: a named profile from <code>~/.aws</code> (access keys, SSO or an assumed role), or the default credential chain, which includes
        environment variables and the IAM role of the EC2 instance or container it runs on. Credentials stay on this machine and are never shown in the app.
      </p>
      <div className="panel ecs-connect-form">
        <div className="segmented" role="radiogroup" aria-label="Credentials">
          <button role="radio" aria-checked={form.mode === 'profile'} className={form.mode === 'profile' ? 'active' : ''} onClick={() => setForm((f) => ({ ...f, mode: 'profile' }))} disabled={!info?.profiles.length}>
            AWS profile
          </button>
          <button role="radio" aria-checked={form.mode === 'default'} className={form.mode === 'default' ? 'active' : ''} onClick={() => setForm((f) => ({ ...f, mode: 'default' }))}>
            Default credentials / IAM role
          </button>
        </div>
        {form.mode === 'profile' ? (
          <label className="field">
            <span>Profile</span>
            <select value={form.profile ?? ''} onChange={(e) => pickProfile(e.target.value)} data-testid="aws-profile">
              {info?.profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({KIND_LABEL[p.kind]}
                  {p.region ? `, ${p.region}` : ''})
                </option>
              ))}
            </select>
            {profile?.kind === 'sso' && <span className="muted">If the SSO session has expired, run <code>aws sso login --profile {profile.name}</code> in the terminal first.</span>}
            {profile?.roleArn && <span className="muted">This profile assumes {profile.roleArn}.</span>}
          </label>
        ) : (
          <p className="muted">
            Uses the standard AWS credential chain: environment variables, the default profile, SSO cache, web identity, then the ECS task role or EC2 instance profile.
            {info && !info.envCredentials && ' No AWS credential variables are set in the environment of this app.'}
          </p>
        )}
        <label className="field">
          <span>Region</span>
          <select value={form.region} onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} data-testid="aws-region">
            {(info?.regions ?? [form.region]).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={useRole} onChange={(e) => setUseRole(e.target.checked)} /> Assume an IAM role
        </label>
        {useRole && (
          <div className="deploy-grid">
            <label className="field span-2">
              <span>Role ARN</span>
              <input value={form.assumeRoleArn ?? ''} onChange={(e) => setForm((f) => ({ ...f, assumeRoleArn: e.target.value }))} placeholder="arn:aws:iam::123456789012:role/ReadOnly" spellCheck={false} />
            </label>
            <label className="field span-2">
              <span>External ID (optional)</span>
              <input value={form.externalId ?? ''} onChange={(e) => setForm((f) => ({ ...f, externalId: e.target.value }))} spellCheck={false} />
            </label>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={form.readOnly} onChange={(e) => setForm((f) => ({ ...f, readOnly: e.target.checked }))} data-testid="aws-readonly" /> Read-only
          <span className="muted">
            {' '}
            — only describe/list/get calls are sent; scaling, deployments, stopping tasks and other changes are blocked in the app, whatever your IAM permissions allow.
          </span>
        </label>
        {error && <div className="inline-error" data-testid="aws-connect-error">{error}</div>}
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || (form.mode === 'profile' && !form.profile) || (useRole && !form.assumeRoleArn)} data-testid="aws-connect">
            {busy || status.state === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
          {info && !info.cli.aws && <span className="muted">The aws CLI is not installed: the AWS shell and ECS Exec need it. Everything else works without it.</span>}
        </div>
      </div>
    </div>
  );
}

function loadProfiles() {
  return call('aws:profiles');
}
