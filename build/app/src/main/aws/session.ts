import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { EC2Client } from '@aws-sdk/client-ec2';
import { STSClient } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { isReadOnlyCommand, type AwsConnectRequest } from '../../shared/ecs';

/** Anything with an SDK v3 `send`. Tests pass fakes with the same shape. */
export interface Sender {
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
}

export interface AwsClients {
  region: string;
  readOnly: boolean;
  ecs: Sender;
  cloudwatch: Sender;
  elb: Sender;
  ec2: Sender;
  sts: Sender;
  /** CloudWatch Logs for a region (containers can log to another region). */
  logs(region?: string): Sender;
}

export class ReadOnlyError extends Error {
  constructor(operation: string) {
    super(`Blocked: this AWS connection is read-only, so ${operation.replace(/Command$/, '')} was not sent. Reconnect with read-only switched off to make changes.`);
    this.name = 'ReadOnlyError';
  }
}

/** Caches credentials across all clients so an assumed role is fetched once, refreshing 5 minutes before expiry. */
export function memoizeCredentials(provider: AwsCredentialIdentityProvider): AwsCredentialIdentityProvider {
  let current: AwsCredentialIdentity | null = null;
  let pending: Promise<AwsCredentialIdentity> | null = null;
  return async () => {
    const exp = current?.expiration?.getTime();
    if (current && (exp === undefined || exp - Date.now() > 5 * 60_000)) return current;
    pending ??= provider().then(
      (c) => {
        current = c;
        pending = null;
        return c;
      },
      (err) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };
}

export function credentialProvider(req: AwsConnectRequest): AwsCredentialIdentityProvider {
  const base = req.mode === 'profile' ? fromIni({ profile: req.profile }) : fromNodeProviderChain();
  if (!req.assumeRoleArn) return memoizeCredentials(base);
  return memoizeCredentials(
    fromTemporaryCredentials({
      masterCredentials: base,
      params: { RoleArn: req.assumeRoleArn, RoleSessionName: `k8sconsole-${Date.now()}`, ExternalId: req.externalId || undefined, DurationSeconds: 3600 },
      clientConfig: { region: req.region },
    }),
  );
}

/** Middleware that refuses every state-changing call when the connection is read-only (defence in depth behind the UI and service checks). */
export function readOnlyGuard(readOnly: () => boolean) {
  return {
    applyToStack(stack: any) {
      stack.add(
        (next: any, context: any) => async (args: any) => {
          const name = String(context?.commandName ?? '');
          if (readOnly() && !isReadOnlyCommand(name)) throw new ReadOnlyError(name || 'the request');
          return next(args);
        },
        { step: 'initialize', name: 'k8scReadOnlyGuard', priority: 'high' },
      );
    },
  };
}

export function createAwsClients(req: AwsConnectRequest, version: string): AwsClients {
  const credentials = credentialProvider(req);
  const common = { region: req.region, credentials, maxAttempts: 4, customUserAgent: `k8sconsole/${version}` };
  const guard = readOnlyGuard(() => req.readOnly);
  const withGuard = <T extends { middlewareStack: { use(p: any): void } }>(c: T): T => {
    c.middlewareStack.use(guard);
    return c;
  };
  const logsClients = new Map<string, CloudWatchLogsClient>();
  return {
    region: req.region,
    readOnly: req.readOnly,
    ecs: withGuard(new ECSClient(common)),
    cloudwatch: withGuard(new CloudWatchClient(common)),
    elb: withGuard(new ElasticLoadBalancingV2Client(common)),
    ec2: withGuard(new EC2Client(common)),
    sts: withGuard(new STSClient(common)),
    logs(region = req.region) {
      let c = logsClients.get(region);
      if (!c) {
        c = withGuard(new CloudWatchLogsClient({ ...common, region }));
        logsClients.set(region, c);
      }
      return c;
    },
  };
}

/** Turns SDK and credential errors into actionable messages (never includes credential values). */
export function describeAwsError(err: unknown, req?: AwsConnectRequest): string {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? '';
  const msg = e?.message ?? String(err);
  if (err instanceof ReadOnlyError) return msg;
  if (/Token(Refresh)?Required|SSO|sso/.test(name + msg) && /expired|refresh|login|token/i.test(msg)) return `AWS SSO session expired or missing. Run: aws sso login${req?.profile ? ` --profile ${req.profile}` : ''}`;
  if (name === 'CredentialsProviderError' || /Could not load credentials|Unable to load credentials/i.test(msg)) return `No AWS credentials found${req?.mode === 'profile' ? ` for profile "${req.profile}"` : ' (environment, shared config or IAM role)'}. ${msg}`;
  if (/mfa/i.test(msg)) return 'This profile requires an MFA code, which K8sConsole cannot prompt for yet. Use a profile with cached session credentials or SSO.';
  if (name === 'ExpiredTokenException' || name === 'ExpiredToken') return 'The AWS session token has expired. Refresh your credentials and reconnect.';
  if (name === 'InvalidClientTokenId' || name === 'UnrecognizedClientException' || name === 'SignatureDoesNotMatch') return `AWS rejected the credentials (${name}). Check the access key or profile.`;
  if (name === 'AccessDenied' || name === 'AccessDeniedException' || e?.$metadata?.httpStatusCode === 403) return `Access denied: ${msg}`;
  if (name === 'ClusterNotFoundException') return 'Cluster not found in this region.';
  if (name === 'ServiceNotFoundException') return 'Service not found (it may have been deleted).';
  if (name === 'ThrottlingException') return 'AWS is throttling requests; try again in a moment.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(msg)) return `Cannot reach AWS (${msg}). Check your network or proxy.`;
  return msg;
}
