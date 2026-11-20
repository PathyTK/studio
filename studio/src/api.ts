// All calls go to same-origin /api: nginx (container) or the Vite proxy (dev) forwards to rslides.
const BASE = (import.meta.env.VITE_RENDERING_API as string | undefined) ?? '';

export interface SlideEntry { path: string; name: string; size: number; scope?: 'public' | 'mine' }
export interface LevelMetadata { mag: number; micro_meter_per_pixel: number; level_downsample: number }
export interface SlideMetadata {
  dzi?: string; // demo mode: static DZI descriptor URL, no backend involved
  path: string; width: number; height: number; tile_size: number;
  levels_metadata: LevelMetadata[]; slide_zoom_levels: number[];
}

export const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// Demo mode: build with VITE_DEMO=true, or open the app with ?demo=1. Never calls /api.
export const DEMO = import.meta.env.VITE_DEMO === 'true' || new URLSearchParams(location.search).has('demo');

const EX = 'https://openseadragon.github.io/example-images';
const DEMO_SLIDES: (SlideEntry & { dzi: string; width: number; height: number })[] = [
  { path: 'demo/highsmith', name: 'Demo: Highsmith (sample image)', size: 0, dzi: `${EX}/highsmith/highsmith.dzi`, width: 7026, height: 9221 },
  { path: 'demo/duomo', name: 'Demo: Duomo (sample image)', size: 0, dzi: `${EX}/duomo/duomo.dzi`, width: 13920, height: 10200 },
];

// Anonymous session id: random, lives in sessionStorage. It names your temporary guest folder in fs-slides.
export const sessionId = (): string => {
  try {
    let id = sessionStorage.getItem('pathy:sid');
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
      sessionStorage.setItem('pathy:sid', id);
    }
    return id;
  } catch { return 'anonymous-session-0000'; }
};

export const MAX_UPLOAD_MB = Number(import.meta.env.VITE_MAX_UPLOAD_MB ?? 2048);
export const formatLimit = (mb: number) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
export const ACCEPTED_EXT = ['svs', 'tif', 'tiff', 'ndpi', 'mrxs', 'scn', 'vms', 'vmu', 'bif'];

// ---- fs-slides: uploads, "Your slides" and viewing of uploaded files -------------------------------------------
// Public slides still come from rslides. Everything you upload lives in fs-slides, in your own folder: your email
// when signed in (proved by a short-lived token from the studio API), otherwise a temporary guest folder named by
// the random session id. Same-origin /api/fs/* is proxied to fs-slides (nginx or the Vite proxy); on Vercel set
// VITE_FS_SLIDES_API to its public URL.
const FS = (import.meta.env.VITE_FS_SLIDES_API as string | undefined) ?? '';
const fsUrl = (p: string) => `${FS}/api/fs${p}`;
/** Public and demo slides are served by rslides / static files; any other path is a file in fs-slides. */
export const isFsPath = (p: string) => !p.startsWith('public/') && !p.startsWith('demo/');

let fsUser: { id: number } | null = null;
let fsToken: { token: string; expiresAt: number } | null = null;
let fsTokenLoading: Promise<void> | null = null;
/** Tell the slide client who is signed in (null = guest). Drops any token of the previous user. */
export const setSlidesUser = (u: { id: number } | null) => { if (u?.id !== fsUser?.id) { fsToken = null; fsTokenLoading = null; } fsUser = u; };

async function loadToken(): Promise<void> {
  const r = await fetch('/api/auth/slides-token', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
  if (r?.ok) fsToken = await r.json();
  else fsToken = null; // not signed in, or private slides not configured on the server: fall back to the guest folder
}
const guestHeaders = () => ({ 'X-Session-Id': sessionId() });
const tokenFresh = (marginMs: number) => !!fsToken && fsToken.expiresAt - Date.now() > marginMs;

/** Auth headers for fs-slides: a bearer token for signed-in users, the guest session id otherwise. */
export async function fsHeaders(): Promise<Record<string, string>> {
  if (fsUser && !tokenFresh(60_000)) await (fsTokenLoading ??= loadToken().finally(() => { fsTokenLoading = null; }));
  return fsUser && fsToken ? { Authorization: `Bearer ${fsToken.token}` } : guestHeaders();
}
/** Same, for places that cannot wait (OpenSeadragon asks per tile). Refreshes in the background before expiry. */
export function fsHeadersSync(): Record<string, string> {
  if (fsUser && !tokenFresh(120_000)) void (fsTokenLoading ??= loadToken().finally(() => { fsTokenLoading = null; }));
  return fsUser && fsToken ? { Authorization: `Bearer ${fsToken.token}` } : guestHeaders();
}

const CHUNK_BYTES = 8 * 1024 * 1024;

/** Uploads one slide to fs-slides in 8 MB chunks. Progress is 0..1. Rejects with a readable message. */
export async function uploadSlide(file: File, onProgress: (p: number) => void): Promise<{ path: string; name: string }> {
  const total = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  let path = '';
  for (let i = 0; i < total; i++) {
    const blob = file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const headers = await fsHeaders(); // refreshed per chunk: a big upload can outlive the 15 min token
    const res = await new Promise<{ done?: boolean; path?: string }>((resolve, reject) => {
      const form = new FormData();
      form.append('fileName', file.name); form.append('chunkNumber', String(i)); form.append('totalChunks', String(total));
      form.append('chunk', blob, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', fsUrl('/upload'));
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(Math.min(1, (i * CHUNK_BYTES + e.loaded * (blob.size / e.total)) / file.size));
      xhr.onerror = () => reject(new Error('Upload failed: cannot reach the server'));
      xhr.onload = () => {
        let body: { done?: boolean; path?: string; error?: string; details?: string } = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* plain text error */ }
        if (xhr.status === 200) return resolve(body);
        const msg = xhr.status === 413 ? `File too large (limit ${formatLimit(MAX_UPLOAD_MB)})`
          : xhr.status === 401 ? 'Your session expired. Sign in again and retry.'
          : body.details ?? body.error ?? (xhr.responseText || `Upload failed (${xhr.status})`);
        reject(new Error(msg));
      };
      xhr.send(form);
    });
    if (res.done && res.path) path = res.path;
  }
  if (!path) throw new Error('Upload finished but the server did not confirm the file. Try again.');
  onProgress(1);
  return { path, name: file.name };
}

type FsNode = { label: string; path: string; isFolder: boolean; metadata?: { size?: number }; children?: FsNode[] };

/** Flattens one root of the fs-slides tree into slide files. The folder structure survives in each `path`. */
function collectSlides(nodes: FsNode[], scope: 'public' | 'mine'): SlideEntry[] {
  const out: SlideEntry[] = [];
  const walk = (ns: FsNode[]) => ns.forEach(n => {
    if (n.isFolder) walk(n.children ?? []);
    else if (ACCEPTED_EXT.includes(n.label.split('.').pop()?.toLowerCase() ?? '')) out.push({ path: n.path, name: n.label, size: n.metadata?.size ?? 0, scope });
  });
  walk(nodes);
  return out;
}

/** fs-slides answers with `[{label:'private',...}, {label:'public',...}]`: nested folders with `isFolder` and `children`.
 *  null when it cannot be reached (the caller then falls back to rslides' flat public list). */
async function fetchFsTree(): Promise<{ mine: SlideEntry[]; pub: SlideEntry[] } | null> {
  const r = await fetch(fsUrl(''), { headers: await fsHeaders() }).catch(() => null);
  if (!r || !r.ok) return null;
  const tree = await r.json() as FsNode[];
  const root = (label: string) => tree.find(n => n.label === label)?.children ?? [];
  return { mine: collectSlides(root('private'), 'mine'), pub: collectSlides(root('public'), 'public') };
}

export async function listSlides(): Promise<SlideEntry[]> {
  if (DEMO) return DEMO_SLIDES.map(({ path, name, size }) => ({ path, name, size, scope: 'public' as const }));
  const fsTree = await fetchFsTree();
  if (fsTree) return [...fsTree.mine, ...fsTree.pub];
  const pub = await fetch(`${BASE}/api/slides`).then(r => { if (!r.ok) throw new Error(`Cannot list slides (${r.status})`); return r.json() as Promise<SlideEntry[]>; });
  return pub.filter(s => s.scope !== 'mine');
}

export async function openSlide(path: string): Promise<SlideMetadata> {
  if (DEMO) {
    const d = DEMO_SLIDES.find(s => s.path === path);
    if (!d) throw new Error('Unknown demo slide');
    return { path, dzi: d.dzi, width: d.width, height: d.height, tile_size: 0, levels_metadata: [], slide_zoom_levels: [] };
  }
  const fs = isFsPath(path);
  const r = await fetch(fs ? fsUrl(`/open/${encodePath(path)}`) : `${BASE}/api/open/${encodePath(path)}`, fs ? { headers: await fsHeaders() } : undefined);
  if (!r.ok) throw new Error(r.status === 403 || r.status === 401 ? 'This slide belongs to another account or session.' : `Cannot open slide (${r.status})`);
  return r.json();
}

export const tileUrl = (path: string, level: number, x: number, y: number) =>
  isFsPath(path) ? fsUrl(`/tile/${level}/${x}/${y}/${encodePath(path)}`) : `${BASE}/api/tile/serve/${level}/${x}/${y}/${encodePath(path)}`;
