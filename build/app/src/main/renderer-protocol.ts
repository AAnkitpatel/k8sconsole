import { extname, join, normalize, sep } from 'node:path';

export const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};

/** Maps an `app://renderer/...` URL to a file inside `rendererDir`; returns null for anything else, including traversal attempts. */
export function resolveRendererFile(url: string, rendererDir: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'app:' || u.host !== 'renderer') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^[/\\]+/, '');
  const file = join(rendererDir, rel || 'index.html');
  return file.startsWith(rendererDir + sep) ? file : null;
}

export function contentTypeFor(file: string): string {
  return MIME[extname(file)] ?? 'application/octet-stream';
}
