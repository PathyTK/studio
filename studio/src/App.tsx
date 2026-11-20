import { useEffect, useState } from 'react';
import { DEMO, SlideEntry, SlideMetadata, isFsPath, listSlides, openSlide, setSlidesUser } from './api';
import { allSlidesWithAnnotations, onAnnotationsSaved } from './storage';
import { SyncState, onSyncState, signOutCleanup, startSync, stopSync } from './sync';
import { LONG_LINK, buildShareLink, consumeShareLink } from './share';
import Viewer from './Viewer';
import { Theme, applyTheme, initialTheme } from './theme';
import ThemeToggle from './ThemeToggle';
import UploadBox from './UploadBox';
import AuthModal from './AuthModal';
import AccountPage from './AccountPage';
import SlideTree from './SlideTree';
import { AuthConfig, User, fetchConfig, fetchMe, logout } from './auth';

// Comma-separated recipients; override at build time with VITE_CONTACT_EMAIL.
const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) || 'aws@pathy.ai,oussama@pathy.ai';

/** Readable slide label: drops the file extension and tidies separators; the full name stays in the tooltip. */
const shortName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;

export default function App() {
  const [slides, setSlides] = useState<SlideEntry[]>([]);
  const [current, setCurrent] = useState<SlideMetadata | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('pathy.collapsed') ?? '{}'); } catch { return {}; }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('pathy.sidebar') !== 'closed'; } catch { return true; }
  });
  const toggleSidebar = () => setSidebarOpen(o => {
    try { localStorage.setItem('pathy.sidebar', o ? 'closed' : 'open'); } catch { /* storage blocked */ }
    return !o;
  });
  // Let the viewer re-measure its container after the bar slides in or out.
  useEffect(() => { window.dispatchEvent(new Event('resize')); }, [sidebarOpen]);
  const toggleSection = (scope: string) => setCollapsed(c => {
    const n = { ...c, [scope]: !c[scope] };
    try { localStorage.setItem('pathy.collapsed', JSON.stringify(n)); } catch { /* storage blocked */ }
    return n;
  });
  const [count, setCount] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<'studio' | 'account'>('studio');
  const [authCfg, setAuthCfg] = useState<AuthConfig | null>(null);
  const [authModal, setAuthModal] = useState<{ reason?: string } | null>(null);
  const [sync, setSync] = useState<SyncState>('idle');
  useEffect(() => onSyncState(setSync), []);
  useEffect(() => applyTheme(theme), [theme]);

  // Accounts live on the pathy-api service. Demo mode has no backend, so no sign-in there.
  useEffect(() => {
    if (DEMO) return;
    fetchConfig().then(setAuthCfg).catch(() => setAuthCfg(null));
    fetchMe().then(setUser).catch(() => setUser(null));
    const q = new URLSearchParams(location.search);
    if (q.has('verified') || q.has('verify_error')) {
      if (q.has('verified')) { flash('Email confirmed. You are signed in.'); fetchMe().then(setUser).catch(() => {}); }
      else setError('That confirmation link is invalid or has expired. Sign in to get a new one.');
      q.delete('verified'); q.delete('verify_error');
      history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : ''));
    }
  }, []);

  // Signed in: save annotations to the account and restore what it already has (also uploads anything drawn before signing up).
  useEffect(() => {
    if (!user) { stopSync(); return; }
    startSync()
      .then(r => { setReloadKey(k => k + 1); if (r.pulled) flash(`Restored your annotations on ${r.pulled} slide${r.pulled === 1 ? '' : 's'}`); })
      .catch(() => setError('Could not sync your annotations. They are still saved in this browser.'));
  }, [user?.id]);

  // Anonymous users: say once, on their first annotation, that nothing is saved beyond this browser.
  useEffect(() => onAnnotationsSaved(() => {
    if (user) return;
    try { if (sessionStorage.getItem('pathy:local-hint') === '1') return; sessionStorage.setItem('pathy:local-hint', '1'); } catch { /* ignore */ }
    flash(DEMO ? 'Annotations stay in this browser tab only.' : 'Annotations are saved only in this browser. Create your Pathy account to keep them.');
  }), [user]);

  const refresh = () => listSlides().then(setSlides).catch(e => setError(e.message));
  // Whoever is signed in decides which fs-slides folder is read and written; re-list when that changes.
  useEffect(() => {
    setSlidesUser(user);
    setCurrent(c => (c && isFsPath(c.path) ? null : c)); // an open private/guest slide belongs to the previous identity
    refresh();
  }, [user?.id]);
  useEffect(() => {
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

  // Anonymous annotations vanish with the tab: warn before leaving. Signed-in users have them saved in their account.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (!user && allSlidesWithAnnotations().length) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [user]);

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
        {!DEMO && authCfg && (
          <button className={`account-btn ${user ? 'in' : ''}`}
                  title={user ? `Your account (${user.email})` : 'Sign up or sign in'}
                  aria-label={user ? 'Open your account' : 'Sign up or sign in'}
                  onClick={() => user ? setPage('account') : setAuthModal({})}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
          </button>
        )}
        {DEMO && <span className="muted">DEMO MODE · static sample images, no backend</span>}
        <span className="spacer" />
        <button className="primary" onClick={share} title="Copy a link that opens this session, with your annotations, for anyone">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
          Share
        </button>
        <ThemeToggle theme={theme} onChange={setTheme} />
      </header>
      {page === 'account' && user && (
        <AccountPage user={user} slides={slides} onBack={() => setPage('studio')}
                     onSignOut={async () => { await logout().catch(() => {}); signOutCleanup(); setUser(null); setPage('studio'); setReloadKey(k => k + 1); flash('Signed out'); }} />
      )}
      <div className="body" hidden={page === 'account' && !!user}>
        <button className={`sidebar-handle ${sidebarOpen ? 'open' : ''}`} onClick={toggleSidebar} aria-expanded={sidebarOpen}
                title={sidebarOpen ? 'Hide the slide list' : 'Show the slide list'}
                aria-label={sidebarOpen ? 'Hide the slide list' : 'Show the slide list'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <aside className="sidebar" hidden={!sidebarOpen}>
          {current && (<div className="sidebar-current">
            <h3>Current slide</h3>
            <p className="current-name" title={current.path.split('/').pop()}>{shortName(current.path.split('/').pop() ?? '')}</p>
            <p className="muted">{current.width.toLocaleString()} × {current.height.toLocaleString()} px · {count} annotation{count === 1 ? '' : 's'}</p>
            {user ? (
              <div className="save-note ok">
                <strong>Saved to your account</strong>
                <span>{sync === 'saving' ? 'Saving…' : sync === 'error' ? 'Could not save just now. Your latest changes are kept in this browser and retried on the next edit.' : 'Your annotations follow you to any device.'}</span>
              </div>
            ) : (
              <div className="save-note warn">
                <strong>Saved only in this browser</strong>
                <span>{DEMO ? 'Demo mode: annotations stay in this browser tab and disappear when you close it.'
                  : 'Your annotations stay in this browser tab and disappear when you close it. Sign up to keep them in your account.'}</span>
                {!DEMO && authCfg && <button className="primary" onClick={() => setAuthModal({ reason: 'Create your Pathy account to keep your annotations and use the AI.' })}>Sign up free</button>}
              </div>
            )}
          </div>)}
          <div className="sidebar-scroll">
          {(['mine', 'public'] as const).map(scope => {
            if (scope === 'mine' && DEMO) return null; // no backend, no personal slides
            const list = slides.filter(x => (x.scope ?? 'public') === scope);
            return (
              <div key={scope}>
                <div className="section-head">
                  <button className="section-toggle" aria-expanded={!collapsed[scope]} onClick={() => toggleSection(scope)}>
                    <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
                    <h3>{scope === 'public' ? 'Public slides' : 'Your slides'}</h3>
                    <span className="count">{list.length}</span>
                  </button>
                </div>
                {!collapsed[scope] && (<>
                {scope === 'mine' && !user && (
                  <p className="muted empty-note">
                    Create an account to persist your slides across devices.
                    {authCfg && <> <a href="#" onClick={e => { e.preventDefault(); setAuthModal({ reason: 'Create your Pathy account to keep your slides across devices.' }); }}>Sign up free</a></>}
                  </p>
                )}
                {scope === 'mine' && user && list.length === 0 && (
                  <div className="empty-slides">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                    <span>No slides yet</span>
                  </div>
                )}
                {list.length === 0 && scope === 'public' && !error && <p className="muted">No slides found.</p>}
                {scope === 'public'
                  ? <SlideTree slides={list} prefix="public/" currentPath={current?.path} label={shortName} onOpen={open} />
                  : <ul>
                      {list.map(s => (
                        <li key={s.path}>
                          <button className={current?.path === s.path ? 'active' : ''} onClick={() => open(s.path)}>
                            <span className="slide-name" title={s.name}>{shortName(s.name)}</span>{s.size > 0 && <small>{(s.size / 1e6).toFixed(1)} MB</small>}
                          </button>
                        </li>
                      ))}
                    </ul>}
                </>)}
              </div>
            );
          })}
          </div>
          {!DEMO && (
            <div className={`sidebar-upload ${current ? 'compact' : ''}`}>
              <UploadBox compact={!!current} onUploaded={onUploaded} onError={setError} />
            </div>
          )}
        </aside>
        <main>
          {error && <div className="error" onClick={() => setError('')}>{error} <small>(click to dismiss)</small></div>}
          {loading && <div className="overlay">Opening slide…</div>}
          {current
            ? <Viewer slide={current} onCount={setCount} reloadKey={reloadKey} user={user} ai={DEMO ? null : authCfg}
                    onRequireAuth={reason => setAuthModal({ reason })} onSignedOut={() => setUser(null)} />
            : <div className="empty">
                <UploadBox large onUploaded={onUploaded} onError={setError} />
                <p className="muted">…or pick a public slide from the list.</p>
              </div>}
        </main>
      </div>
      {authModal && (
        <AuthModal reason={authModal.reason} config={authCfg} onClose={() => setAuthModal(null)}
                   onAuthed={u => { setUser(u); setAuthModal(null); flash(`Signed in as ${u.email}`); }} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
      <footer>
        <span>© {new Date().getFullYear()} Pathy. All rights reserved.</span>
        <a href={`mailto:${CONTACT}`}>Contact</a>
      </footer>
    </div>
  );
}
