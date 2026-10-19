import { describe, expect, it } from 'vitest';
import { contentTypeFor, resolveRendererFile } from '../../build/app/src/main/renderer-protocol';

const DIR = '/opt/app/resources/app.asar/out/renderer';

describe('app:// renderer protocol', () => {
  it('serves files from the renderer directory', () => {
    expect(resolveRendererFile('app://renderer/index.html', DIR)).toBe(`${DIR}/index.html`);
    expect(resolveRendererFile('app://renderer/', DIR)).toBe(`${DIR}/index.html`);
    expect(resolveRendererFile('app://renderer/assets/index-abc.js?x=1#y', DIR)).toBe(`${DIR}/assets/index-abc.js`);
  });
  it('never resolves outside the renderer directory, however the path is encoded', () => {
    for (const url of [
      'app://renderer/../main/main.js',
      'app://renderer/%2e%2e/%2e%2e/package.json',
      'app://renderer/..%2f..%2fmain%2fmain.js',
      'app://renderer/..%5c..%5cmain.js',
      'app://renderer/assets/../../../../etc/passwd',
    ]) {
      const r = resolveRendererFile(url, DIR);
      expect(r === null || r.startsWith(DIR + '/'), `${url} -> ${r}`).toBe(true);
    }
  });
  it('rejects other hosts/schemes and malformed input', () => {
    expect(resolveRendererFile('app://renderer/assets/%00.js', DIR)).toBeNull();
    expect(resolveRendererFile('app://renderer/%E0%A4%A', DIR)).toBeNull();
    expect(resolveRendererFile('app://other/index.html', DIR)).toBeNull();
    expect(resolveRendererFile('file:///etc/passwd', DIR)).toBeNull();
    expect(resolveRendererFile('not a url', DIR)).toBeNull();
  });
  it('sets content types', () => {
    expect(contentTypeFor('a.js')).toBe('text/javascript');
    expect(contentTypeFor('a.html')).toBe('text/html');
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream');
  });
});
