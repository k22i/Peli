// Redaction of recorded responses: debrid keys, config path segments and opaque URL tokens
// (encrypted configs, signed links) never reach a fixture.
import type { Stream } from './types.ts';

const hex40 = /^[0-9a-f]{40}$/i;
const opaque = /^[A-Za-z0-9_\-=%.]{32,}$/;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function redactUrl(raw: string, secrets: string[]): string {
  let s = raw;
  for (const secret of secrets) if (secret) s = s.split(secret).join('<key>');
  try {
    const u = new URL(s);
    // Keep info hashes and a trailing filename. Once a path holds one opaque token (encrypted
    // config, signed link), everything after it is dropped except that filename: some addons
    // split one token across several segments.
    const kept: string[] = [];
    let tainted = false;
    const segs = u.pathname.split('/').filter(Boolean);
    segs.forEach((seg, i) => {
      const d = safeDecode(seg);
      const isFile = i === segs.length - 1 && /\.[a-z0-9]{2,4}$/i.test(d) && /[ ._-]/.test(d.slice(0, -4));
      if (isFile || hex40.test(d) || d === '<key>') kept.push(d);
      else if (opaque.test(seg)) {
        if (!tainted) kept.push('<opaque>');
        tainted = true;
      } else if (!tainted) kept.push(d);
    });
    return `${u.origin}/${kept.join('/')}${u.search ? '?<redacted>' : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

export function redactStreams(streams: Stream[], secrets: string[]): Stream[] {
  return streams.map((st) => {
    const out: Stream = { ...st };
    if (out.url) out.url = redactUrl(out.url, secrets);
    if (out.externalUrl) out.externalUrl = redactUrl(out.externalUrl, secrets);
    return out;
  });
}

export function assertClean(json: string, secrets: string[]) {
  for (const secret of secrets) {
    if (secret && json.includes(secret)) throw new Error('redaction failed: a secret is still in the fixture');
  }
}
