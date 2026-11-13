import { useEffect, useRef, useState } from 'react';
import OpenSeadragon from 'openseadragon';
// @ts-expect-error no types shipped
import Annotorious from '@recogito/annotorious-openseadragon';
import '@recogito/annotorious-openseadragon/dist/annotorious.min.css';
import { SlideMetadata, tileUrl } from './api';
import { Annotation, loadAnnotations, saveAnnotations } from './storage';
import AiPanel from './AiPanel';
import type { AuthConfig, ChatContext, User } from './auth';
import { annotationNote, captureAnnotation, captureView } from './ai-context';

export type Tool = 'rect' | 'polygon' | 'move';
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
];

class PathyTileSource extends (OpenSeadragon as any).TileSource {
  constructor(private meta: SlideMetadata) {
    super({ width: meta.width, height: meta.height, tileSize: meta.tile_size });
  }
  getTileUrl(level: number, x: number, y: number) {
    return tileUrl(this.meta.path, level, x, y);
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

  useEffect(() => {
    const viewer = OpenSeadragon({
      element: el.current!,
      prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/images/',
      tileSources: (slide.dzi ?? new PathyTileSource(slide)) as any,
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
      const mpp = slide.levels_metadata[0]?.micro_meter_per_pixel;
      const bar = mpp ? ` · ${(100 / imgZoom * mpp).toFixed(0)} µm ≈ 100 px` : '';
      zoomLabel.current = `${mag.toFixed(mag < 10 ? 1 : 0)}×`;
      setZoomInfo(`${zoomLabel.current}${bar}`);
    };
    viewer.addHandler('zoom', update);
    viewer.addHandler('open', update);

    return () => { a.destroy(); viewer.destroy(); };
  }, [slide]);

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
    if (tool === 'move') a.setDrawingEnabled(false);
    else { a.setDrawingTool(tool); a.setDrawingEnabled(true); }
  }, [tool, slide]);

  const zoomBy = (f: number) => { const v = osd.current; if (!v) return; v.viewport.zoomBy(f); v.viewport.applyConstraints(); };
  const home = () => osd.current?.viewport.goHome();
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
      if (k === 'v') setTool('move'); else if (k === 'r') setTool('rect'); else if (k === 'p') setTool('polygon');
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
          {tool === 'rect' ? 'Click and drag to draw a rectangle' : 'Drag the first edge, click to add points, double-click to finish'}
        </div>
      )}
      <div className="zoom-badge">{zoomInfo}</div>
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
