import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types';
import { isEcsArn, isValidEcsName, isValidProfileName, isValidRegion, isValidRoleArn } from '../shared/ecs';

/** Coerces untrusted input into a valid settings object, dropping unknown keys and bad values. */
export function sanitizeSettings(input: unknown, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: AppSettings = { ...base, lastNamespaces: { ...base.lastNamespaces }, ecsLastCluster: { ...base.ecsLastCluster } };
  if (src.theme === 'dark' || src.theme === 'light' || src.theme === 'system') out.theme = src.theme;
  const strArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 4096) : undefined);
  const files = strArray(src.kubeconfigFiles);
  if (files) out.kubeconfigFiles = [...new Set(files)];
  const folders = strArray(src.kubeconfigFolders);
  if (folders) out.kubeconfigFolders = [...new Set(folders)];
  if (src.lastContextId === null || typeof src.lastContextId === 'string') out.lastContextId = src.lastContextId as string | null;
  if (src.lastNamespaces && typeof src.lastNamespaces === 'object' && !Array.isArray(src.lastNamespaces)) {
    out.lastNamespaces = {};
    for (const [k, v] of Object.entries(src.lastNamespaces as Record<string, unknown>)) if (typeof v === 'string') out.lastNamespaces[k] = v;
  }
  if (typeof src.logTailLines === 'number' && Number.isInteger(src.logTailLines) && src.logTailLines >= 10 && src.logTailLines <= 100000) out.logTailLines = src.logTailLines;
  if (typeof src.logTimestamps === 'boolean') out.logTimestamps = src.logTimestamps;
  if (typeof src.confirmDestructiveActions === 'boolean') out.confirmDestructiveActions = src.confirmDestructiveActions;
  if (typeof src.hideManagedFields === 'boolean') out.hideManagedFields = src.hideManagedFields;
  if (typeof src.helmPath === 'string' && src.helmPath.length < 4096) out.helmPath = src.helmPath;
  if (src.assistantModel === 'claude-opus-5-5' || src.assistantModel === 'claude-sonnet-5-5' || src.assistantModel === 'claude-haiku-5-5') out.assistantModel = src.assistantModel;
  if (src.assistantEffort === 'low' || src.assistantEffort === 'medium' || src.assistantEffort === 'high') out.assistantEffort = src.assistantEffort;
  if (typeof src.assistantReadLogs === 'boolean') out.assistantReadLogs = src.assistantReadLogs;
  if (src.workspace === 'kubernetes' || src.workspace === 'ecs') out.workspace = src.workspace;
  if (src.awsLastConnection === null) out.awsLastConnection = null;
  else if (src.awsLastConnection && typeof src.awsLastConnection === 'object') {
    const c = src.awsLastConnection as Record<string, unknown>;
    const mode = c.mode === 'default' ? 'default' : 'profile';
    if (isValidRegion(c.region) && (mode === 'default' || isValidProfileName(c.profile))) {
      out.awsLastConnection = {
        mode,
        profile: mode === 'profile' ? (c.profile as string) : undefined,
        region: c.region,
        assumeRoleArn: isValidRoleArn(c.assumeRoleArn) ? c.assumeRoleArn : undefined,
        externalId: isValidRoleArn(c.assumeRoleArn) && typeof c.externalId === 'string' && c.externalId.length < 1225 ? c.externalId : undefined,
        readOnly: c.readOnly !== false,
      };
    }
  }
  if (src.ecsLastCluster && typeof src.ecsLastCluster === 'object' && !Array.isArray(src.ecsLastCluster)) {
    out.ecsLastCluster = {};
    for (const [k, v] of Object.entries(src.ecsLastCluster as Record<string, unknown>)) if (k.length < 300 && (isEcsArn(v, 'cluster') || isValidEcsName(v))) out.ecsLastCluster[k] = v as string;
  }
  return out;
}

export class SettingsStore {
  private current: AppSettings;

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  private load(): AppSettings {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return sanitizeSettings({});
    }
  }

  get(): AppSettings {
    return structuredClone(this.current);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.current = sanitizeSettings({ ...this.current, ...(patch && typeof patch === 'object' ? patch : {}) }, this.current);
    this.save();
    return this.get();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
