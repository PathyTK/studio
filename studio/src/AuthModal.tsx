import { FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, AuthConfig, User, googleLogin, login, resend, signup } from './auth';

interface Props { reason?: string; config: AuthConfig | null; onClose: () => void; onAuthed: (u: User) => void }
type Mode = 'signin' | 'signup' | 'sent';

let gsiLoading: Promise<void> | null = null;
const loadGsi = () => (gsiLoading ??= new Promise<void>((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => res(); s.onerror = () => { gsiLoading = null; rej(new Error('Google script failed to load')); };
  document.head.appendChild(s);
}));

export default function AuthModal({ reason, config, onClose, onAuthed }: Props) {
  const [mode, setMode] = useState<Mode>('signup');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [info, setInfo] = useState('');
  const gbtn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Google's own button (Google Identity Services). Needs GOOGLE_CLIENT_ID on the server.
  useEffect(() => {
    if (!config?.googleClientId || mode === 'sent') return;
    let cancelled = false;
    loadGsi().then(() => {
      const g = (window as any).google?.accounts?.id;
      if (cancelled || !g || !gbtn.current) return;
      g.initialize({
        client_id: config.googleClientId,
        callback: async (resp: { credential: string }) => {
          setError(''); setBusy(true);
          try { onAuthed(await googleLogin(resp.credential)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        },
      });
      g.renderButton(gbtn.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with', shape: 'pill' });
    }).catch(() => setError('Could not load Google sign-in.'));
    return () => { cancelled = true; };
  }, [config?.googleClientId, mode]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'signup') { await signup(email, password, name); setMode('sent'); }
      else onAuthed(await login(email, password));
    } catch (err) {
      const ae = err as ApiError;
      if (ae.code === 'email_not_verified') { setMode('sent'); } else setError(ae.message);
    } finally { setBusy(false); }
  };

  const again = async () => {
    setError(''); setBusy(true);
    try { setInfo((await resend(email)).message); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Sign in or create an account">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        {mode === 'sent' ? (<>
          <h2>Check your inbox</h2>
          <p>We sent a confirmation link to <strong>{email}</strong>. Open it to activate your account; you will be signed in automatically.</p>
          <p className="muted">It can take a minute. Look in spam too. The link expires in 24 hours.</p>
          {info && <p className="ok">{info}</p>}{error && <p className="err">{error}</p>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={again}>Resend email</button>
            <button onClick={() => { setMode('signin'); setInfo(''); }}>Back to sign in</button>
          </div>
        </>) : (<>
          <h2>{mode === 'signup' ? 'Create your free account' : 'Welcome back'}</h2>
          <p className="muted">{reason ?? 'An account is required for the AI features.'}</p>
          {config?.googleClientId && (<>
            <div ref={gbtn} className="google-btn" />
            <div className="or"><span>or with email</span></div>
          </>)}
          <form onSubmit={submit}>
            {mode === 'signup' && <label>Name <small>(optional)</small><input value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={80} /></label>}
            <label>Email<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
            <label>Password{mode === 'signup' && <small> (at least 10 characters)</small>}
              <input type="password" required minLength={mode === 'signup' ? 10 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)}
                     autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            </label>
            {error && <p className="err">{error}</p>}
            <button className="primary wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
          </form>
          <p className="switch">
            {mode === 'signup' ? <>Already have an account? <a href="#" onClick={e => { e.preventDefault(); setMode('signin'); setError(''); }}>Sign in</a></>
              : <>New here? <a href="#" onClick={e => { e.preventDefault(); setMode('signup'); setError(''); }}>Create an account</a></>}
          </p>
        </>)}
      </div>
    </div>
  );
}
