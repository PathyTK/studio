// All API routes as one framework-free handler: (Request) => Response.
// Vercel calls it from api/[...path].ts; node-server.ts wraps it for Docker/local use. Tests call it directly.
import type { Config } from './config.js';
import { Db, ensureSchema, pgDb } from './db.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { EmailSender, makeEmailSender, verificationEmail } from './email.js';
import { GoogleVerifier, makeGoogleVerifier } from './google.js';
import { AiClient, AiMessage, ImageBlock, SYSTEM_PROMPT, makeAiClient } from './ai.js';
import { allow } from './ratelimit.js';
import { MIN_SECRET_LENGTH, isSafeFolderName, signSlidesToken } from './slides-token.js';

export interface Deps { db: Db | null; sendEmail: EmailSender; verifyGoogle: GoogleVerifier | null; ai: AiClient | null }
export type Handler = (req: Request) => Promise<Response>;

const COOKIE = 'pathy_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const VERIFY_MS = 24 * 3600 * 1000;
const MAX_BODY = 14 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const IMG_RE = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/;
const MAX_ANNOTATIONS_BYTES = 2 * 1024 * 1024;   // per slide
const MAX_ANNOTATIONS_PER_SLIDE = 5000;
const MAX_SLIDES_PER_USER = 300;

interface User { id: number; email: string; name: string | null; email_verified: boolean }
class HttpError extends Error { constructor(public status: number, public payload: Record<string, unknown>) { super(String(payload.error)); } }

const json = (status: number, body: unknown, headers?: Headers) => {
  const h = headers ?? new Headers();
  h.set('content-type', 'application/json; charset=utf-8'); h.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
};
const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name });
// The last hop is the one our own proxy (Vercel / nginx) observed; earlier entries can be forged by the client.
const clientIp = (req: Request) => req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || req.headers.get('x-real-ip') || 'unknown';

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function readBody(req: Request): Promise<any> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) throw new HttpError(415, { error: 'unsupported_media_type' });
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, { error: 'too_large' });
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, { error: 'too_large' });
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, { error: 'invalid_json' }); }
}

function toStream(gen: AsyncGenerator<string>) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(c) { const n = await gen.next(); if (n.done) c.close(); else c.enqueue(enc.encode(n.value)); },
    async cancel() { await gen.return?.(undefined); },
  });
}

export function createHandler(cfg: Config, overrides: Partial<Deps> = {}): Handler {
  const deps = {
    sendEmail: overrides.sendEmail ?? makeEmailSender(cfg),
    verifyGoogle: overrides.verifyGoogle === undefined ? (cfg.googleClientId ? makeGoogleVerifier(cfg.googleClientId) : null) : overrides.verifyGoogle,
    ai: overrides.ai === undefined ? makeAiClient(cfg) : overrides.ai,
  };
  let db: Db | null = overrides.db ?? null;
  const getDb = async (): Promise<Db> => {
    if (!db) {
      if (!cfg.databaseUrl) throw new HttpError(503, { error: 'database_not_configured', message: 'The database is not configured (set DATABASE_URL).' });
      db = pgDb(cfg.databaseUrl);
    }
    await ensureSchema(db);
    return db;
  };

  const startSession = async (d: Db, h: Headers, userId: number) => {
    const token = randomToken();
    await d.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, Date.now() + SESSION_MS]);
    h.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${cfg.cookieSecure ? '; Secure' : ''}`);
  };
  const currentUser = async (d: Db, req: Request): Promise<User | null> => {
    const token = cookieValue(req, COOKIE);
    if (!token) return null;
    const rows = await d.query<User>(
      `SELECT u.id, u.email, u.name, u.email_verified FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`, [sha256(token), Date.now()]);
    return rows[0] ?? null;
  };
  const sendVerification = async (d: Db, user: { id: number; email: string; name: string | null }) => {
    const token = randomToken();
    await d.query('INSERT INTO verify_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), user.id, Date.now() + VERIFY_MS]);
    const m = verificationEmail(`${cfg.appUrl}/api/auth/verify?token=${token}`, user.name);
    await deps.sendEmail(user.email, m.subject, m.html, m.text);
  };
  // Serverless has no background timers: tidy expired rows now and then, on auth traffic.
  const sweep = async (d: Db) => {
    if (Math.random() > 0.02) return;
    const now = Date.now();
    await d.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
    await d.query('DELETE FROM verify_tokens WHERE expires_at < $1', [now]);
    await d.query('DELETE FROM rate_limits WHERE window_start < $1', [now - 24 * 3600 * 1000]);
  };

  const requireUser = async (d: Db, req: Request): Promise<User> => {
    const u = await currentUser(d, req);
    if (!u) throw new HttpError(401, { error: 'auth_required', message: 'Sign in to continue.' });
    if (!u.email_verified) throw new HttpError(403, { error: 'email_not_verified', message: 'Confirm your email first.' });
    return u;
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const key = `${req.method} ${path}`;

    // State-changing requests must come from our own site (JSON-only bodies + SameSite=Lax cookie cover the rest).
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.get('origin');
      if (origin && !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, { error: 'forbidden_origin' });
    }

    if (key === 'GET /api/health') return json(200, { ok: true });

    if (key === 'GET /api/auth/config') {
      return json(200, {
        googleClientId: deps.verifyGoogle ? cfg.googleClientId ?? null : null,
        aiEnabled: deps.ai !== null, aiMock: deps.ai?.mock ?? false,
        aiProvider: deps.ai?.provider ?? null, aiModel: deps.ai?.model ?? null,
        aiDailyLimit: cfg.aiDailyLimit,
      });
    }

    const d = await getDb();

    if (key === 'GET /api/auth/me') {
      const u = await currentUser(d, req);
      return json(200, { user: u && u.email_verified ? publicUser(u) : null });
    }

    if (key === 'POST /api/auth/signup') {
      if (!(await allow(d, `signup:${clientIp(req)}`, 15 * 60 * 1000, 20))) return json(429, { error: 'too_many_requests' });
      const b = await readBody(req);
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : null;
      if (!EMAIL_RE.test(email) || !isSafeFolderName(email)) return json(400, { error: 'invalid_email' });
      if (password.length < 10 || password.length > 128) return json(400, { error: 'weak_password', message: 'Use 10 to 128 characters.' });
      await sweep(d);
      const existing = (await d.query<User & { password_hash: string | null }>('SELECT id, email, name, email_verified FROM users WHERE email = $1', [email]))[0];
      // Same answer whether or not the address is registered, so signup can't be used to discover accounts.
      try {
        const mailOk = () => allow(d, `mail:${email}`, 3600 * 1000, 5);
        if (!existing) {
          const hash = await hashPassword(password);
          let id: number | null = null;
          try { id = (await d.query<{ id: number }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, hash]))[0].id; }
          catch (e: any) { if (e?.code !== '23505') throw e; /* lost a race with another signup of the same address */ }
          if (id !== null && await mailOk()) await sendVerification(d, { id, email, name });
        } else if (!existing.email_verified && await mailOk()) {
          await sendVerification(d, existing);
        }
      } catch (e) {
        console.error('signup failed', e);
        return json(502, { error: 'email_failed', message: 'We could not send the confirmation email. Try again later.' });
      }
      return json(200, { ok: true, message: 'Check your inbox to confirm your email.' });
    }

    if (key === 'POST /api/auth/resend') {
      if (!(await allow(d, `resend:${clientIp(req)}`, 15 * 60 * 1000, 20))) return json(429, { error: 'too_many_requests' });
      const b = await readBody(req);
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const u = (await d.query<User>('SELECT id, email, name, email_verified FROM users WHERE email = $1', [email]))[0];
      if (u && !u.email_verified && await allow(d, `mail:${email}`, 3600 * 1000, 5)) {
        try { await sendVerification(d, u); } catch (e) { console.error('resend failed', e); }
      }
      return json(200, { ok: true, message: 'If that address needs confirming, a new email is on its way.' });
    }

    if (key === 'GET /api/auth/verify') {
      const token = url.searchParams.get('token');
      const row = token ? (await d.query<{ user_id: number; expires_at: number; used_at: number | null }>(
        'SELECT user_id, expires_at, used_at FROM verify_tokens WHERE token_hash = $1', [sha256(token)]))[0] : undefined;
      if (!token || !row || row.used_at || row.expires_at < Date.now()) {
        return new Response(null, { status: 302, headers: { Location: `${cfg.appUrl}/?verify_error=1` } });
      }
      await d.query('UPDATE verify_tokens SET used_at = $1 WHERE token_hash = $2', [Date.now(), sha256(token)]);
      await d.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [row.user_id]);
      const h = new Headers({ Location: `${cfg.appUrl}/?verified=1` });
      await startSession(d, h, row.user_id);
      return new Response(null, { status: 302, headers: h });
    }

    if (key === 'POST /api/auth/login') {
      if (!(await allow(d, `login:${clientIp(req)}`, 15 * 60 * 1000, 20))) return json(429, { error: 'too_many_requests' });
      const b = await readBody(req);
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      const u = (await d.query<User & { password_hash: string | null }>('SELECT id, email, name, email_verified, password_hash FROM users WHERE email = $1', [email]))[0];
      const ok = await verifyPassword(password, u?.password_hash ?? null);
      if (!u || !ok) return json(401, { error: 'invalid_credentials', message: 'Wrong email or password.' });
      if (!u.email_verified) return json(403, { error: 'email_not_verified', message: 'Confirm your email first. Check your inbox.' });
      const h = new Headers();
      await startSession(d, h, u.id);
      return json(200, { user: publicUser(u) }, h);
    }

    if (key === 'POST /api/auth/google') {
      if (!deps.verifyGoogle) return json(503, { error: 'google_not_configured' });
      if (!(await allow(d, `google:${clientIp(req)}`, 15 * 60 * 1000, 20))) return json(429, { error: 'too_many_requests' });
      const credential = (await readBody(req)).credential;
      if (typeof credential !== 'string' || credential.length > 4096) return json(400, { error: 'invalid_credential' });
      let id;
      try { id = await deps.verifyGoogle(credential); } catch { return json(401, { error: 'invalid_google_token' }); }
      if (!id.emailVerified) return json(403, { error: 'google_email_unverified' });
      let u = (await d.query<User>('SELECT id, email, name, email_verified FROM users WHERE google_sub = $1 OR email = $2', [id.sub, id.email]))[0];
      if (!u) {
        const r = await d.query<{ id: number }>('INSERT INTO users (email, name, email_verified, google_sub) VALUES ($1, $2, TRUE, $3) RETURNING id', [id.email, id.name ?? null, id.sub]);
        u = { id: r[0].id, email: id.email, name: id.name ?? null, email_verified: true };
      } else {
        // Google vouches for the address: link the account and treat the email as confirmed.
        await d.query('UPDATE users SET google_sub = COALESCE(google_sub, $1), email_verified = TRUE, name = COALESCE(name, $2) WHERE id = $3', [id.sub, id.name ?? null, u.id]);
      }
      const h = new Headers();
      await startSession(d, h, u.id);
      return json(200, { user: publicUser(u) }, h);
    }

    if (key === 'POST /api/auth/logout') {
      const token = cookieValue(req, COOKIE);
      if (token) await d.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
      const h = new Headers();
      h.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.cookieSecure ? '; Secure' : ''}`);
      return json(200, { ok: true }, h);
    }

    // ---- private slides: a short-lived token the browser sends to fs-slides (replaces Auth0 there)
    if (key === 'POST /api/auth/slides-token') {
      const u = await requireUser(d, req);
      if (!cfg.slidesTokenSecret || cfg.slidesTokenSecret.length < MIN_SECRET_LENGTH) {
        return json(503, { error: 'slides_token_not_configured', message: 'Private slides are not configured on this server.' });
      }
      if (!isSafeFolderName(u.email)) return json(403, { error: 'unsafe_email', message: 'This account cannot use private slides.' });
      if (!(await allow(d, `slides-token:${u.id}`, 60 * 1000, 30))) return json(429, { error: 'too_many_requests' });
      const t = signSlidesToken(cfg.slidesTokenSecret, { issuer: cfg.slidesTokenIssuer, audience: cfg.slidesTokenAudience, userId: u.id, email: u.email });
      return json(200, t);
    }

    // ---- saved annotations (signed-in users only; anonymous users keep them in the browser session)
    if (key === 'GET /api/annotations') {
      const u = await requireUser(d, req);
      const rows = await d.query<{ slide_path: string; data: unknown[]; updated_at: number }>(
        'SELECT slide_path, data, updated_at FROM slide_annotations WHERE user_id = $1', [u.id]);
      const slides: Record<string, { annotations: unknown[]; updatedAt: number }> = {};
      for (const r of rows) slides[r.slide_path] = { annotations: r.data, updatedAt: r.updated_at };
      return json(200, { slides });
    }

    if (key === 'PUT /api/annotations') {
      const u = await requireUser(d, req);
      const b = await readBody(req);
      const slide = typeof b.slide === 'string' && b.slide.length > 0 && b.slide.length <= 300 ? b.slide : null;
      if (!slide) return json(400, { error: 'invalid_slide' });
      if (!Array.isArray(b.annotations) || b.annotations.length > MAX_ANNOTATIONS_PER_SLIDE
          || !b.annotations.every((a: any) => a && typeof a === 'object' && typeof a.id === 'string')) {
        return json(400, { error: 'invalid_annotations' });
      }
      const data = JSON.stringify(b.annotations);
      if (data.length > MAX_ANNOTATIONS_BYTES) return json(413, { error: 'too_large', message: 'Too many annotations on this slide to save.' });
      const exists = (await d.query('SELECT 1 FROM slide_annotations WHERE user_id = $1 AND slide_path = $2', [u.id, slide])).length > 0;
      if (!exists && b.annotations.length > 0) {
        const n = (await d.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM slide_annotations WHERE user_id = $1', [u.id]))[0].n;
        if (n >= MAX_SLIDES_PER_USER) return json(400, { error: 'too_many_slides', message: 'Saved-slides limit reached.' });
      }
      const updatedAt = typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) && b.updatedAt <= Date.now() + 60_000 ? Math.floor(b.updatedAt) : Date.now();
      if (b.annotations.length === 0) {
        await d.query('DELETE FROM slide_annotations WHERE user_id = $1 AND slide_path = $2', [u.id, slide]); // nothing left to keep
      } else {
        await d.query(
          `INSERT INTO slide_annotations (user_id, slide_path, data, count, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (user_id, slide_path) DO UPDATE SET data = EXCLUDED.data, count = EXCLUDED.count, updated_at = EXCLUDED.updated_at`,
          [u.id, slide, data, b.annotations.length, updatedAt]);
      }
      return json(200, { ok: true, count: b.annotations.length, updatedAt });
    }

    // ---- AI (signed-in, email-confirmed users only)
    if (key === 'POST /api/ai/chat') {
      const user = await currentUser(d, req);
      if (!user) return json(401, { error: 'auth_required', message: 'Sign in to use the AI features.' });
      if (!user.email_verified) return json(403, { error: 'email_not_verified', message: 'Confirm your email to use the AI features.' });
      if (!deps.ai) return json(503, { error: 'ai_not_configured', message: 'The AI service is not configured.' });
      if (!(await allow(d, `ai:${user.id}`, 60 * 1000, 10))) return json(429, { error: 'slow_down', message: 'Too many messages in a short time.' });

      const b = await readBody(req);
      if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > 20) return json(400, { error: 'invalid_messages' });
      const msgs: AiMessage[] = [];
      for (const m of b.messages as any[]) {
        const content = txt(m?.content, 4000).trim();
        if ((m?.role !== 'user' && m?.role !== 'assistant') || !content) return json(400, { error: 'invalid_messages' });
        msgs.push({ role: m.role, content });
      }
      if (msgs[msgs.length - 1].role !== 'user') return json(400, { error: 'invalid_messages' });

      // Context (slide info + screenshots) rides on the latest user message.
      const toImage = (v: unknown): ImageBlock | null => {
        if (typeof v !== 'string' || v.length > 6_000_000) return null;
        const m = IMG_RE.exec(v);
        return m ? { type: 'image', source: { type: 'base64', media_type: m[1] === 'png' ? 'image/png' : 'image/jpeg', data: m[2] } } : null;
      };
      const c = b.context ?? {};
      const notes: string[] = [];
      if (txt(c.slideName, 200)) notes.push(`Slide: ${txt(c.slideName, 200)}`);
      if (txt(c.magnification, 40)) notes.push(`Current magnification: ${txt(c.magnification, 40)}`);
      const images: ImageBlock[] = [];
      const view = toImage(c.viewImage);
      if (view) { images.push(view); notes.push('Image 1 is the current view of the slide.'); }
      const a = c.annotation;
      if (a && typeof a === 'object') {
        notes.push(`The user has selected an annotation (${txt(a.kind, 20) || 'shape'}${txt(a.size, 60) ? `, about ${txt(a.size, 60)}` : ''}).`);
        if (txt(a.note, 1000)) notes.push(`Their note on it: "${txt(a.note, 1000)}"`);
        const crop = toImage(a.image);
        if (crop) { images.push(crop); notes.push(`Image ${images.length} is a close-up of the annotated region.`); }
      }
      const last = msgs[msgs.length - 1];
      last.content = [...images, { type: 'text' as const, text: `${notes.length ? `[Context]\n${notes.join('\n')}\n[/Context]\n\n` : ''}${last.content as string}` }];

      // Daily quota (counted per user message sent to the model).
      const day = new Date().toISOString().slice(0, 10);
      const used = (await d.query<{ count: number }>('SELECT count FROM ai_usage WHERE user_id = $1 AND day = $2', [user.id, day]))[0]?.count ?? 0;
      if (used >= cfg.aiDailyLimit) return json(429, { error: 'daily_limit', message: `Daily limit of ${cfg.aiDailyLimit} AI messages reached. Try again tomorrow.` });

      const gen = (async function* () { yield* deps.ai!.stream({ system: SYSTEM_PROMPT, messages: msgs }); })();
      let first: IteratorResult<string>;
      try { first = await gen.next(); }
      catch (e) { console.error('ai failed', e); return json(502, { error: 'ai_failed', message: 'The AI service failed. Try again.' }); }

      await d.query('INSERT INTO ai_usage (user_id, day, count) VALUES ($1, $2, 1) ON CONFLICT (user_id, day) DO UPDATE SET count = ai_usage.count + 1', [user.id, day]);
      async function* body() {
        if (!first.done) yield first.value;
        try { for (;;) { const n = await gen.next(); if (n.done) break; yield n.value; } }
        catch (e) { console.error('ai stream interrupted', e); yield '\n\n[The response was interrupted. Please try again.]'; }
      }
      return new Response(toStream(body()), {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no',
          'x-ai-remaining': String(Math.max(0, cfg.aiDailyLimit - used - 1)),
        },
      });
    }

    return json(404, { error: 'not_found' });
  }

  return async req => {
    try { return await route(req); }
    catch (e) {
      if (e instanceof HttpError) return json(e.status, e.payload);
      console.error('unhandled error', e);
      return json(500, { error: 'internal_error' });
    }
  };
}
