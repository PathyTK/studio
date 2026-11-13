// Share links: the whole session (annotations of every slide + the slide being viewed) is packed into the
// URL fragment: gzip -> base64url. No server involved, and the #fragment is never sent over the network.
//   https://host/#share=z.<payload>   (z = gzip, j = plain JSON when CompressionStream is unavailable)
import { SessionData, collectSession, mergeSession } from './storage';
import { DEMO } from './api';

interface Payload { v: 1; open?: string; a: SessionData }

const MAX_DECODED_BYTES = 5 * 1024 * 1024; // guard against zip bombs in hostile links
export const LONG_LINK = 8000;             // chat apps and some browsers start truncating around here

const toB64 = (b: Uint8Array) => {
  let s = ''; b.forEach(c => (s += String.fromCharCode(c)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (t: string) => {
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, cap?: number) {
  const w = stream.writable.getWriter();
  w.write(data as BufferSource).catch(() => {}); w.close().catch(() => {});
  const r = stream.readable.getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (cap && n > cap) throw new Error('Share link is too large');
    chunks.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  chunks.forEach(c => { out.set(c, o); o += c.length; });
  return out;
}

export async function buildShareLink(openPath?: string): Promise<string> {
  const payload: Payload = { v: 1, open: openPath, a: collectSession() };
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const token = typeof CompressionStream !== 'undefined'
    ? 'z.' + toB64(await pipe(raw, new CompressionStream('gzip')))
    : 'j.' + toB64(raw);
  const keep = DEMO ? '?demo=1' : '';
  return `${location.origin}${location.pathname}${keep}#share=${token}`;
}

/** If the URL carries a share link: load its annotations into this session and return the slide to open. */
export async function consumeShareLink(): Promise<{ found: boolean; open?: string }> {
  const m = /^#share=([zj])\.([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return { found: false };
  try {
    const bytes = fromB64(m[2]);
    const json = m[1] === 'z'
      ? new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip'), MAX_DECODED_BYTES))
      : new TextDecoder().decode(bytes);
    const p = JSON.parse(json) as Payload;
    if (p?.v !== 1 || typeof p.a !== 'object' || p.a === null) throw new Error('bad payload');
    mergeSession(p.a);
    return { found: true, open: typeof p.open === 'string' ? p.open : undefined };
  } finally {
    history.replaceState(null, '', location.pathname + location.search); // keep the address bar clean
  }
}
