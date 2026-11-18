import { useEffect, useRef, useState } from 'react';
import OpenSeadragon from 'openseadragon';
// @ts-expect-error no types shipped
import Annotorious from '@recogito/annotorious-openseadragon';
import '@recogito/annotorious-openseadragon/dist/annotorious.min.css';
import { SlideMetadata, fsHeadersSync, isFsPath, tileUrl } from './api';
import { Annotation, loadAnnotations, saveAnnotations } from './storage';
import AiPanel from './AiPanel';
import type { AuthConfig, ChatContext, User } from './auth';
import { annotationNote, captureAnnotation, captureView } from './ai-context';

export type Tool = 'rect' | 'polygon' | 'move' | 'ruler';
type Pt = { x: number; y: number };            // image pixels
type Ruler = { a: Pt; b: Pt };

/** Length in µm → "480 µm" / "1.25 mm" */
const fmtLen = (um: number) => um >= 1000 ? `${(um / 1000).toFixed(um >= 10000 ? 1 : 2)} mm` : `${um >= 100 ? um.toFixed(0) : um.toFixed(1)} µm`;
/** Largest 1-2-5 × 10ⁿ value that is <= v */
const niceLen = (v: number) => { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p; };
interface Props {
  slide: SlideMetadata;
  onCount: (n: number) => void;
  reloadKey: number; // bump to re-read annotations from storage (after a share link loads)
  user: User | null;
  ai: AuthConfig | null;          // null when the backend is unavailable (demo mode)
  onRequireAuth: (reason: string) => void;
  onSignedOut: () => void;
}

const icon = (d: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);
const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: 'move', label: 'Pan', key: 'V', icon: icon(<><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.4 16a2 2 0 0 1 3.2-2.4L8 15" /></>) },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: icon(<rect x="3" y="5" width="18" height="14" rx="1" />) },
  { id: 'polygon', label: 'Polygon', key: 'P', icon: icon(<path d="m12 2 9.5 7-3.6 11.2H6.1L2.5 9z" />) },
  { id: 'ruler', label: 'Ruler', key: 'M', icon: icon(<><path d="M21.3 15.3 8.7 2.7a1 1 0 0 0-1.4 0L2.7 7.3a1 1 0 0 0 0 1.4l12.6 12.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" /><path d="m7.5 10.5 2 2M10.5 7.5l2 2M13.5 4.5l2 2M4.5 13.5l2 2" /></>) },
];

class PathyTileSource extends (OpenSeadragon as any).TileSource {
  constructor(private meta: SlideMetadata) {
    super({ width: meta.width, height: meta.height, tileSize: meta.tile_size });
  }
  getTileUrl(level: number, x: number, y: number) {
    return tileUrl(this.meta.path, level, x, y);
  }
  // fs-slides tiles need credentials (bearer token or guest session id); an <img> cannot send headers, so OSD fetches them via XHR
  getTileAjaxHeaders() {
    return isFsPath(this.meta.path) ? fsHeadersSync() : {};
  }
}

export default function Viewer({ slide, onCount, reloadKey, user, ai, onRequireAuth, onSignedOut }: Props) {
  const [aiOpen, setAiOpen] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const zoomLabel = useRef('');
  const [tool, setTool] = useState<Tool>('move');
  const [count, setCount] = useState(0);
  const el = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const anno = useRef<any>(null);
  const osd = useRef<OpenSeadragon.Viewer | null>(null);
  const [zoomInfo, setZoomInfo] = useState('');
  const [scaleBar, setScaleBar] = useState<{ px: number; label: string } | null>(null);
  const [rulers, setRulers] = useState<Ruler[]>([]);
  const [draft, setDraft] = useState<Ruler | null>(null);
  const [, setTick] = useState(0); // re-render the ruler overlay while panning/zooming
  const toolRef = useRef<Tool>('move');
  const mpp = slide.levels_metadata[0]?.micro_meter_per_pixel;

  useEffect(() => {
    const viewer = OpenSeadragon({
      element: el.current!,
      prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/images/',
      tileSources: (slide.dzi ?? new PathyTileSource(slide)) as any,
      loadTilesWithAjax: !slide.dzi && isFsPath(slide.path),
      crossOriginPolicy: 'Anonymous', // tiles may come from another origin (rslides on Cloud Run); without CORS the AI screenshot canvas would be unreadable
      showNavigationControl: false, // replaced by our own controls below (same style as the drawing toolbar)
      showNavigator: true,
      autoHideControls: false, // keep the overview map visible (default fades it out when the mouse is idle)
      navigatorPosition: 'BOTTOM_RIGHT',
      gestureSettingsMouse: { clickToZoom: false },
      maxZoomPixelRatio: 4,
      immediateRender: false,
    });
    osd.current = viewer;
    const a = Annotorious(viewer, { disableEditor: false });
    anno.current = a;

    const persist = () => {
      const all = a.getAnnotations() as Annotation[];
      saveAnnotations(slide.path, all);
      onCount(all.length);
      setCount(all.length);
    };
    // Annotorious drops shapes whose comment is empty when you press Ok. Save immediately instead,
    // so a drawn shape is never lost; the editor stays open to add a comment or tag.
    a.on('createSelection', async (selection: any) => {
      selection.body = [{ type: 'TextualBody', purpose: 'commenting', value: '' }];
      a.updateSelected(selection, true);
    });
    a.on('createAnnotation', persist);
    a.on('updateAnnotation', persist);
    a.on('deleteAnnotation', (x: any) => { setSelected(null); persist(); void x; });
    a.on('selectAnnotation', (x: any) => setSelected(x));
    a.on('cancelSelected', () => setSelected(null));

    // Effective magnification = base objective mag * current zoom relative to level 0
    const base = slide.levels_metadata[0]?.mag || 40; // demo images have no magnification: assume 40×
    const update = () => {
      const imgZoom = viewer.viewport.viewportToImageZoom(viewer.viewport.getZoom(true));
      const mag = base * imgZoom;
      zoomLabel.current = `${mag.toFixed(mag < 10 ? 1 : 0)}×`;
      setZoomInfo(zoomLabel.current);
      // Scale bar: a round real-world length drawn at roughly 60-150 screen px
      const unit = mpp ? mpp / imgZoom : 1 / imgZoom;   // µm (or image px) per screen px
      const len = niceLen(unit * 120);
      setScaleBar({ px: len / unit, label: mpp ? fmtLen(len) : `${len.toLocaleString()} px` });
    };
    viewer.addHandler('zoom', update);
    viewer.addHandler('open', update);
    viewer.addHandler('animation', () => setTick(t => t + 1));

    // Ruler tool: drag to measure. Wheel zoom stays live; only the drag-to-pan is suppressed.
    const toImg = (pos: any): Pt => { const q = viewer.viewport.viewerElementToImageCoordinates(pos); return { x: q.x, y: q.y }; };
    let from: Pt | null = null;
    viewer.addHandler('canvas-press', (e: any) => { if (toolRef.current === 'ruler') from = toImg(e.position); });
    viewer.addHandler('canvas-drag', (e: any) => {
      if (toolRef.current !== 'ruler' || !from) return;
      e.preventDefaultAction = true;
      setDraft({ a: from, b: toImg(e.position) });
    });
    viewer.addHandler('canvas-release', (e: any) => {
      if (toolRef.current !== 'ruler' || !from) return;
      const to = toImg(e.position), f = from; from = null; setDraft(null);
      if (Math.hypot(to.x - f.x, to.y - f.y) * viewer.viewport.viewportToImageZoom(viewer.viewport.getZoom(true)) > 4) setRulers(r => [...r, { a: f, b: to }]);
    });

    return () => { a.destroy(); viewer.destroy(); };
  }, [slide]);

  useEffect(() => { setRulers([]); setDraft(null); }, [slide]);

  // (re)load stored annotations on slide change / import
  useEffect(() => {
    const a = anno.current;
    if (!a) return;
    const stored = loadAnnotations(slide.path);
    a.setAnnotations(stored);
    onCount(stored.length);
    setCount(stored.length);
  }, [slide, reloadKey]);

  useEffect(() => {
    const a = anno.current;
    if (!a) return;
    // Leave any open editor/selection first: disabling drawing while a shape is selected makes Annotorious throw.
    try { a.cancelSelected(); } catch { /* nothing selected */ }
    toolRef.current = tool;
    if (tool === 'move' || tool === 'ruler') a.setDrawingEnabled(false);
    else { a.setDrawingTool(tool); a.setDrawingEnabled(true); }
  }, [tool, slide]);

  const zoomBy = (f: number) => { const v = osd.current; if (!v) return; v.viewport.zoomBy(f); v.viewport.applyConstraints(); };
  const home = () => osd.current?.viewport.goHome();
  const rotateBy = (deg: number) => { const v = osd.current; if (!v) return; v.viewport.setRotation(Math.round((v.viewport.getRotation() + deg) / 90) * 90); };
  const fullscreen = () => {
    const r = root.current; if (!r) return;
    if (document.fullscreenElement) document.exitFullscreen(); else r.requestFullscreen?.();
  };

  // What the AI gets with each message: slide name, magnification, a screenshot of the view and the selected annotation.
  const getAiContext = (): ChatContext => {
    const v = osd.current;
    const ctx: ChatContext = { slideName: slide.path.split('/').pop(), magnification: zoomLabel.current || undefined };
    if (!v) return ctx;
    ctx.viewImage = captureView(v);
    if (selected) { const c = captureAnnotation(v, selected, slide); if (c) ctx.annotation = c; }
    return ctx;
  };
  const toggleAi = () => {
    if (!user) return onRequireAuth('Create a free account to chat with the AI about your slides.');
    setAiOpen(o => !o);
  };

  // Shortcuts: V pan, R rectangle, P polygon (ignored while typing in the annotation editor)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 'v') setTool('move'); else if (k === 'r') setTool('rect'); else if (k === 'p') setTool('polygon'); else if (k === 'm') setTool('ruler');
      else if (k === 'escape') setRulers([]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <div className="viewer" ref={root}>
      <div ref={el} className="osd" />
      <div className="view-controls" role="toolbar" aria-label="View controls">
        <button title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.6)}>{icon(<><path d="M5 12h14" /><path d="M12 5v14" /></>)}</button>
        <button title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>{icon(<path d="M5 12h14" />)}</button>
        <button title="Rotate left" aria-label="Rotate left" onClick={() => rotateBy(-90)}>{icon(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>)}</button>
        <button title="Rotate right" aria-label="Rotate right" onClick={() => rotateBy(90)}>{icon(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>)}</button>
        <button title="Fit slide" aria-label="Fit slide to view" onClick={home}>{icon(<><path d="M3 9.5 12 3l9 6.5" /><path d="M5 10v10h14V10" /></>)}</button>
        <button title="Fullscreen" aria-label="Fullscreen" onClick={fullscreen}>{icon(<><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>)}</button>
      </div>
      <div className="draw-toolbar" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(t => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} aria-pressed={tool === t.id}
                  title={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
        <span className="draw-count" title="Annotations on this slide">{count}</span>
      </div>
      {tool !== 'move' && (
        <div className="draw-hint">
          {tool === 'rect' ? 'Click and drag to draw a rectangle'
            : tool === 'ruler' ? 'Drag to measure · click a label to remove it · Esc clears all'
            : 'Drag the first edge, click to add points, double-click to finish'}
        </div>
      )}
      <svg className="ruler-layer" aria-hidden={rulers.length === 0 && !draft}>
        {[...rulers, ...(draft ? [draft] : [])].map((r, i) => {
          const v = osd.current; if (!v) return null;
          const A = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(r.a.x, r.a.y));
          const B = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(r.b.x, r.b.y));
          const dx = Math.abs(r.b.x - r.a.x), dy = Math.abs(r.b.y - r.a.y), d = Math.hypot(dx, dy);
          const f = (px: number) => mpp ? fmtLen(px * mpp) : `${Math.round(px).toLocaleString()} px`;
          const ang = Math.atan2(B.y - A.y, B.x - A.x), nx = -Math.sin(ang) * 6, ny = Math.cos(ang) * 6;
          const label = `${f(d)}  (W ${f(dx)} × H ${f(dy)})`;
          const isDraft = draft && i === rulers.length;
          return (
            <g key={i} className="ruler">
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} />
              <line x1={A.x - nx} y1={A.y - ny} x2={A.x + nx} y2={A.y + ny} />
              <line x1={B.x - nx} y1={B.y - ny} x2={B.x + nx} y2={B.y + ny} />
              <g className="ruler-label" transform={`translate(${(A.x + B.x) / 2},${(A.y + B.y) / 2 - 14})`}
                 onClick={isDraft ? undefined : () => setRulers(rs => rs.filter((_, j) => j !== i))}>
                <title>{isDraft ? '' : 'Click to remove'}</title>
                <rect x={-label.length * 3.4 - 8} y={-11} width={label.length * 6.8 + 16} height={22} rx={11} />
                <text textAnchor="middle" dy="4">{label}</text>
              </g>
            </g>
          );
        })}
      </svg>
      <div className="zoom-badge">
        {scaleBar && <div className="scale-bar"><div style={{ width: scaleBar.px }} /><span>{scaleBar.label}</span></div>}
        {zoomInfo}
      </div>
      {ai?.aiEnabled && (
        <button className={`ai-launch primary ${aiOpen ? 'on' : ''}`} onClick={toggleAi} title={user ? 'Chat with the AI about this slide' : 'Sign in to use the AI'}>
          {icon(<><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 3v4M17 5h4M5 17v4M3 19h4" /></>)}
          Ask AI
        </button>
      )}
      {aiOpen && user && ai && (
        <AiPanel slideName={slide.path.split('/').pop() ?? slide.path} hasSelection={!!selected} badge={ai.aiMock ? 'mock' : ai.aiProvider === 'openai-compatible' ? ai.aiModel : null} dailyLimit={ai.aiDailyLimit}
                 getContext={getAiContext} onClose={() => setAiOpen(false)} onSignedOut={() => { setAiOpen(false); onSignedOut(); }} />
      )}
    </div>
  );
}
