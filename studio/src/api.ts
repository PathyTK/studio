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

// Anonymous session id: random, lives in sessionStorage. It only scopes which uploads you see.
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

/** Uploads one slide (raw body, streamed). Progress is 0..1. Rejects with a readable message. */
export function uploadSlide(file: File, onProgress: (p: number) => void): Promise<{ path: string; name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE}/api/upload/${encodeURIComponent(sessionId())}/${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new Error('Upload failed: cannot reach the server'));
    xhr.onload = () => {
      if (xhr.status === 201) return resolve(JSON.parse(xhr.responseText));
      const msg = xhr.status === 413 ? `File too large (limit ${formatLimit(MAX_UPLOAD_MB)})` : xhr.responseText.replace(/^Bad request: /, '');
      reject(new Error(msg || `Upload failed (${xhr.status})`));
    };
    xhr.send(file);
  });
}

export async function listSlides(): Promise<SlideEntry[]> {
  if (DEMO) return DEMO_SLIDES.map(({ path, name, size }) => ({ path, name, size, scope: 'public' as const }));
  const r = await fetch(`${BASE}/api/slides?session=${encodeURIComponent(sessionId())}`);
  if (!r.ok) throw new Error(`Cannot list slides (${r.status})`);
  return r.json();
}

export async function openSlide(path: string): Promise<SlideMetadata> {
  if (DEMO) {
    const d = DEMO_SLIDES.find(s => s.path === path);
    if (!d) throw new Error('Unknown demo slide');
    return { path, dzi: d.dzi, width: d.width, height: d.height, tile_size: 0, levels_metadata: [], slide_zoom_levels: [] };
  }
  const r = await fetch(`${BASE}/api/open/${encodePath(path)}`);
  if (!r.ok) throw new Error(`Cannot open slide (${r.status})`);
  return r.json();
}

export const tileUrl = (path: string, level: number, x: number, y: number) =>
  `${BASE}/api/tile/serve/${level}/${x}/${y}/${encodePath(path)}`;
