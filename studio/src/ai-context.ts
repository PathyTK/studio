// Builds what the AI sees: a screenshot of the current view and, for a selected annotation, a close-up of it.
import OpenSeadragon from 'openseadragon';
import type { SlideMetadata } from './api';

const MAX_SIDE = 1280;

function snapshot(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): string {
  const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

export const viewCanvas = (v: OpenSeadragon.Viewer) => (v as any).drawer?.canvas as HTMLCanvasElement | undefined;

export function captureView(v: OpenSeadragon.Viewer): string | undefined {
  const c = viewCanvas(v);
  return c && c.width > 0 ? snapshot(c, 0, 0, c.width, c.height) : undefined;
}

/** Bounding box (image pixels) of a W3C annotation made by the rectangle or polygon tool. */
export function annotationBox(a: any): { x: number; y: number; w: number; h: number; kind: string } | null {
  const sel = Array.isArray(a?.target?.selector) ? a.target.selector[0] : a?.target?.selector;
  if (!sel?.value) return null;
  if (sel.type === 'FragmentSelector') {
    const m = /xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(sel.value);
    return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4], kind: 'rectangle' } : null;
  }
  if (sel.type === 'SvgSelector') {
    const m = /points=["']([^"']+)["']/.exec(sel.value);
    if (!m) return null;
    const pts = m[1].trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), kind: 'polygon' };
  }
  return null;
}

export function annotationNote(a: any): string {
  const bodies = Array.isArray(a?.body) ? a.body : a?.body ? [a.body] : [];
  return bodies.filter((b: any) => b?.value).map((b: any) => b.value).join('; ');
}

/** Close-up of the annotated region, cropped from what is on screen (zoom in first for more detail). */
export function captureAnnotation(v: OpenSeadragon.Viewer, a: any, slide: SlideMetadata) {
  const box = annotationBox(a);
  if (!box) return null;
  const mpp = slide.levels_metadata?.[0]?.micro_meter_per_pixel;
  const size = mpp ? `${(box.w * mpp).toFixed(0)} × ${(box.h * mpp).toFixed(0)} µm` : `${box.w.toFixed(0)} × ${box.h.toFixed(0)} px`;
  const out = { kind: box.kind, size, note: annotationNote(a), image: undefined as string | undefined };
  const canvas = viewCanvas(v);
  if (!canvas) return out;
  const el = v.element as HTMLElement;
  const k = canvas.width / el.clientWidth;
  const p1 = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(box.x, box.y));
  const p2 = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(box.x + box.w, box.y + box.h));
  const padX = (p2.x - p1.x) * 0.2, padY = (p2.y - p1.y) * 0.2;
  const sx = Math.max(0, (p1.x - padX) * k), sy = Math.max(0, (p1.y - padY) * k);
  const ex = Math.min(canvas.width, (p2.x + padX) * k), ey = Math.min(canvas.height, (p2.y + padY) * k);
  if (ex - sx >= 8 && ey - sy >= 8) out.image = snapshot(canvas, sx, sy, ex - sx, ey - sy);
  return out;
}
