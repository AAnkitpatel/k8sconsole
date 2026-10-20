import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export type Platform = NodeJS.Platform;

/** Is this an existing file the current user may run? On Windows any existing file counts (no execute bit). */
export function isRunnable(path: string, platform: Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The PATH value of an environment; Windows spells the key `Path`, and keys are case-insensitive there. */
export function envPathOf(env: Record<string, string | undefined>, platform: Platform = process.platform): string {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key && env[key]) || '';
}

/**
 * Locates an executable on PATH, or validates an explicit absolute path.
 * On Windows each PATH entry is tried with the PATHEXT extensions (.EXE, .CMD, …) unless the name already has one.
 */
export function findExecutable(
  name: string,
  explicit?: string,
  envPath = envPathOf(process.env),
  platform: Platform = process.platform,
  exists: (p: string) => boolean = (p) => isRunnable(p, platform),
  pathExt = process.env.PATHEXT,
): string | null {
  const path = platform === 'win32' ? win32 : posix;
  if (explicit) return path.isAbsolute(explicit) && exists(explicit) ? explicit : null;
  const dirs = envPath.split(path.delimiter).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exts = platform === 'win32' && !/\.[A-Za-z0-9]{1,4}$/.test(name) ? (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const d of dirs) {
    if (!path.isAbsolute(d)) continue;
    for (const ext of exts) {
      const c = path.join(d, name + ext);
      if (exists(c)) return c;
    }
  }
  return null;
}
