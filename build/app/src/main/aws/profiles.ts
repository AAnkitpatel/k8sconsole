import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AwsProfileInfo, AwsProfileKind } from '../../shared/ecs';

/** Minimal INI reader: section name → key → value. Comments and blank lines are skipped. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      const name = sec[1].trim();
      current = out.get(name) ?? new Map();
      out.set(name, current);
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && current) current.set(kv[1].trim().toLowerCase(), kv[2].trim());
  }
  return out;
}

export interface AwsFiles {
  configPath: string;
  credentialsPath: string;
}

export function awsFiles(home: string, env: NodeJS.ProcessEnv = process.env): AwsFiles {
  return {
    configPath: env.AWS_CONFIG_FILE || join(home, '.aws', 'config'),
    credentialsPath: env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials'),
  };
}

function read(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Lists named profiles from the shared AWS config and credentials files.
 * Only names, regions, the kind of credentials and role ARNs are returned; key material is never read out.
 */
export function listProfiles(files: AwsFiles): AwsProfileInfo[] {
  const config = parseIni(read(files.configPath));
  const creds = parseIni(read(files.credentialsPath));
  const merged = new Map<string, Map<string, string>>();
  for (const [section, values] of config) {
    const name = section === 'default' ? 'default' : section.startsWith('profile ') ? section.slice(8).trim() : null;
    if (!name) continue; // sso-session and services sections are not profiles
    merged.set(name, new Map(values));
  }
  for (const [name, values] of creds) {
    const m = merged.get(name) ?? new Map<string, string>();
    for (const [k, v] of values) if (!m.has(k)) m.set(k, v);
    merged.set(name, m);
  }
  const kindOf = (v: Map<string, string>): AwsProfileKind => {
    if (v.has('role_arn') && (v.has('source_profile') || v.has('credential_source'))) return 'assume-role';
    if (v.has('role_arn') && v.has('web_identity_token_file')) return 'web-identity';
    if (v.has('sso_session') || v.has('sso_start_url')) return 'sso';
    if (v.has('credential_process')) return 'process';
    if (v.has('aws_access_key_id')) return 'static';
    return 'unknown';
  };
  return [...merged.entries()]
    .map(([name, v]) => ({ name, region: v.get('region') || undefined, kind: kindOf(v), roleArn: v.get('role_arn') || undefined }))
    .filter((p) => /^[\w.@+-]{1,128}$/.test(p.name))
    .sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
}
