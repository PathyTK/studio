import { useEffect, useState } from 'react';
import { DEMO, SlideEntry, SlideMetadata, listSlides, openSlide } from './api';
import { allSlidesWithAnnotations } from './storage';
import { LONG_LINK, buildShareLink, consumeShareLink } from './share';
import Viewer from './Viewer';
import { Theme, applyTheme, initialTheme } from './theme';
import ThemeToggle from './ThemeToggle';
import UploadBox from './UploadBox';

// Comma-separated recipients; override at build time with VITE_CONTACT_EMAIL.
const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) || 'aws@pathy.ai,oussama@pathy.ai';

export default function App() {
  const [slides, setSlides] = useState<SlideEntry[]>([]);
  const [current, setCurrent] = useState<SlideMetadata | null>(null);
  const [count, setCount] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);

  const refresh = () => listSlides().then(setSlides).catch(e => setError(e.message));
  useEffect(() => {
    refresh();
    (async () => {
      let target = new URLSearchParams(location.search).get('open'); // deep link: ?open=public/Case 01.svs
      try {
        const shared = await consumeShareLink(); // annotations from a share link land in this session
        if (shared.found) { target = shared.open ?? target; setReloadKey(k => k + 1); flash('Shared session loaded'); }
      } catch { setError('This share link is damaged or incomplete.'); }
      if (target) open(target);
    })();
  }, []);

  const onUploaded = async (path: string) => {
    await refresh();
    open(path);
  };

  // Session storage vanishes with the tab: warn if there is unsaved work.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (allSlidesWithAnnotations().length) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const open = async (path: string) => {
    setError(''); setLoading(true);
    try { setCurrent(await openSlide(path)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 4000); };

  const share = async () => {
    try {
      const link = await buildShareLink(current?.path);
      try { await navigator.clipboard.writeText(link); }
      catch { window.prompt('Copy this link to share your session:', link); }
      flash(link.length > LONG_LINK ? `Link copied, but it is long (${link.length.toLocaleString()} characters): some apps may cut it off` : 'Link copied. Anyone who opens it sees your annotations');
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="app">
      <header>
        <img className="logo" src="/logo.png" alt="Pathy logo" />
        <span className="logo-text" role="img" aria-label="Pathy" />
        {DEMO && <span className="muted">DEMO MODE · static sample images, no backend</span>}
        <span className="spacer" />
        <button className="primary" onClick={share} title="Copy a link that opens this session, with your annotations, for anyone">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
          Share
        </button>
        <ThemeToggle theme={theme} onChange={setTheme} />
      </header>
      <div className="body">
        <aside>
          {(['public', 'mine'] as const).map(scope => {
            const list = slides.filter(x => (x.scope ?? 'public') === scope);
            if (scope === 'mine' && list.length === 0) return null;
            return (
              <div key={scope}>
                <h3>{scope === 'public' ? 'Public slides' : 'Your uploads'}</h3>
                {list.length === 0 && !error && <p className="muted">No slides found.</p>}
                <ul>
                  {list.map(s => (
                    <li key={s.path}>
                      <button className={current?.path === s.path ? 'active' : ''} onClick={() => open(s.path)}>
                        {s.name}{s.size > 0 && <small>{(s.size / 1e6).toFixed(1)} MB</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {current && (<>
            <h3>Current slide</h3>
            <p className="muted">{count} annotation{count === 1 ? '' : 's'} on this slide</p>
            <p className="muted">{current.width.toLocaleString()} × {current.height.toLocaleString()} px</p>
          </>)}
        </aside>
        <main>
          {error && <div className="error" onClick={() => setError('')}>{error} <small>(click to dismiss)</small></div>}
          {loading && <div className="overlay">Opening slide…</div>}
          {current
            ? <Viewer slide={current} onCount={setCount} reloadKey={reloadKey} />
            : <div className="empty">
                <UploadBox large onUploaded={onUploaded} onError={setError} />
                <p className="muted">…or pick a public slide from the list.</p>
              </div>}
        </main>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
      <footer>
        <span>© {new Date().getFullYear()} Pathy. All rights reserved.</span>
        <a href={`mailto:${CONTACT}`}>Contact</a>
      </footer>
    </div>
  );
}
