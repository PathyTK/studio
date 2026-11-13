import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { isSafeFolderName } from '../src/slides-token.js';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/config.js';
import { createHandler } from '../src/handler.js';
import type { Db } from '../src/db.js';
import { makeOpenAiCompatClient, toOpenAiMessages } from '../src/ai.js';
import type { AiClient } from '../src/ai.js';

const PASSWORD = 'correct horse battery';
const cfg = (extra: Record<string, string> = {}) => loadConfig({ APP_URL: 'http://localhost:3000', AI_DAILY_LIMIT: '3', ...extra });

/** A real Postgres engine (PGlite, WASM) in memory: same SQL as production, no server needed. */
function memoryDb(): Db {
  const pg = new PGlite();
  return {
    async query(sql, params) { return (await pg.query(sql, params as any[])).rows as any[]; },
    async exec(sql) { await pg.exec(sql); },
  };
}

function setup(extra: Record<string, string> = {}, ai?: AiClient | null) {
  const mails: { to: string; text: string }[] = [];
  const seen: any[] = [];
  const fakeAi: AiClient = {
    mock: false, provider: 'anthropic', model: 'fake',
    async *stream(req) { seen.push(req); yield 'Looks like '; yield 'kidney.'; },
  };
  const handler = createHandler(cfg(extra), {
    db: memoryDb(),
    sendEmail: async (to, _s, _h, text) => { mails.push({ to, text }); },
    verifyGoogle: async c => {
      if (c === 'good') return { sub: 'g-1', email: 'gina@example.com', emailVerified: true, name: 'Gina' };
      if (c === 'unverified') return { sub: 'g-2', email: 'u@example.com', emailVerified: false };
      throw new Error('bad token');
    },
    ai: ai === undefined ? fakeAi : ai,
  });
  // Tiny adapter so tests read like HTTP calls against the handler.
  const app = {
    async inject(o: { method?: string; url: string; payload?: unknown; headers?: Record<string, string> }) {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
      const init: RequestInit = { method: o.method ?? 'GET', headers, redirect: 'manual' };
      if (o.payload !== undefined) { init.body = JSON.stringify(o.payload); headers['content-type'] = 'application/json'; }
      const res = await handler(new Request('http://localhost:3000' + o.url, init));
      const body = await res.text();
      return { statusCode: res.status, body, json: () => JSON.parse(body),
        headers: { 'set-cookie': res.headers.getSetCookie(), location: res.headers.get('location') ?? undefined, 'x-ai-remaining': res.headers.get('x-ai-remaining') } as Record<string, any> };
    },
  };
  return { app, mails, seen };
}
type App = ReturnType<typeof setup>['app'];

const cookieOf = (res: { headers: Record<string, any> }) => {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : sc;
  return first ? String(first).split(';')[0] : '';
};
const post = (app: App, url: string, body: unknown, cookie = '', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: body as object, headers: { cookie, ...headers } });

async function signupAndVerify(t: ReturnType<typeof setup>, email = 'ann@example.com') {
  assert.equal((await post(t.app, '/api/auth/signup', { email, password: PASSWORD, name: 'Ann' })).statusCode, 200);
  const link = /http:\/\/localhost:3000(\/api\/auth\/verify\?token=[\w-]+)/.exec(t.mails.at(-1)!.text)![1];
  const res = await t.app.inject({ method: 'GET', url: link });
  return { res, cookie: cookieOf(res), link };
}

test('signup sends a confirmation email; verifying logs the user in', async () => {
  const t = setup();
  const { res, cookie } = await signupAndVerify(t);
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /\?verified=1$/);
  const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.json().user.email, 'ann@example.com');
});

test('cannot log in before confirming the email; can after', async () => {
  const t = setup();
  await post(t.app, '/api/auth/signup', { email: 'bob@example.com', password: PASSWORD });
  const early = await post(t.app, '/api/auth/login', { email: 'bob@example.com', password: PASSWORD });
  assert.equal(early.statusCode, 403);
  assert.equal(early.json().error, 'email_not_verified');
  await t.app.inject({ method: 'GET', url: /(\/api\/auth\/verify\?token=[\w-]+)/.exec(t.mails.at(-1)!.text)![1] });
  const ok = await post(t.app, '/api/auth/login', { email: 'bob@example.com', password: PASSWORD });
  assert.equal(ok.statusCode, 200);
  assert.ok(cookieOf(ok));
});

test('wrong password and unknown user get the same answer', async () => {
  const t = setup();
  await signupAndVerify(t);
  const a = await post(t.app, '/api/auth/login', { email: 'ann@example.com', password: 'nope-nope-nope' });
  const b = await post(t.app, '/api/auth/login', { email: 'ghost@example.com', password: 'nope-nope-nope' });
  assert.equal(a.statusCode, 401);
  assert.deepEqual(a.json(), b.json());
});

test('signup validates input and does not reveal existing accounts', async () => {
  const t = setup();
  assert.equal((await post(t.app, '/api/auth/signup', { email: 'not-an-email', password: PASSWORD })).statusCode, 400);
  assert.equal((await post(t.app, '/api/auth/signup', { email: 'a@example.com', password: 'short' })).statusCode, 400);
  await signupAndVerify(t, 'dup@example.com');
  const again = await post(t.app, '/api/auth/signup', { email: 'dup@example.com', password: 'another long password' });
  assert.equal(again.statusCode, 200); // same generic answer as a brand-new address
  assert.equal(again.json().ok, true);
});

test('verification links are single-use and garbage tokens are refused', async () => {
  const t = setup();
  const { link } = await signupAndVerify(t);
  const reuse = await t.app.inject({ method: 'GET', url: link });
  assert.match(String(reuse.headers.location), /verify_error=1/);
  const junk = await t.app.inject({ method: 'GET', url: '/api/auth/verify?token=abc' });
  assert.match(String(junk.headers.location), /verify_error=1/);
});

test('logout invalidates the session', async () => {
  const t = setup();
  const { cookie } = await signupAndVerify(t);
  await post(t.app, '/api/auth/logout', {}, cookie);
  const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.json().user, null);
});

test('Google sign-in creates a verified account and links by email', async () => {
  const t = setup();
  const g = await post(t.app, '/api/auth/google', { credential: 'good' });
  assert.equal(g.statusCode, 200);
  assert.equal(g.json().user.email, 'gina@example.com');
  assert.ok(cookieOf(g));
  const again = await post(t.app, '/api/auth/google', { credential: 'good' });
  assert.equal(again.json().user.id, g.json().user.id); // same account, not a duplicate
  assert.equal((await post(t.app, '/api/auth/google', { credential: 'forged' })).statusCode, 401);
  assert.equal((await post(t.app, '/api/auth/google', { credential: 'unverified' })).statusCode, 403);
});

test('requests from a foreign origin are rejected', async () => {
  const t = setup();
  const bad = await post(t.app, '/api/auth/login', { email: 'a@example.com', password: 'x' }, '', { origin: 'https://evil.example' });
  assert.equal(bad.statusCode, 403);
  const good = await post(t.app, '/api/auth/login', { email: 'a@example.com', password: 'x' }, '', { origin: 'http://localhost:3000' });
  assert.equal(good.statusCode, 401);
});

test('AI is guarded: anonymous 401, unverified 401 (no session), verified streams', async () => {
  const t = setup();
  const body = { messages: [{ role: 'user', content: 'Which organ is this?' }] };
  assert.equal((await post(t.app, '/api/ai/chat', body)).statusCode, 401);
  const { cookie } = await signupAndVerify(t);
  const res = await post(t.app, '/api/ai/chat', body, cookie);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'Looks like kidney.');
});

test('AI request carries slide context and validates images', async () => {
  const t = setup();
  const { cookie } = await signupAndVerify(t);
  const px = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const res = await post(t.app, '/api/ai/chat', {
    messages: [{ role: 'user', content: 'Opinion on this?' }],
    context: { slideName: 'Case 01.svs', magnification: '10×', viewImage: px, annotation: { kind: 'rect', note: 'odd area', image: px } },
  }, cookie);
  assert.equal(res.statusCode, 200);
  const sent = t.seen[0].messages.at(-1).content;
  assert.equal(sent.filter((b: any) => b.type === 'image').length, 2);
  const text = sent.find((b: any) => b.type === 'text').text;
  assert.match(text, /Case 01\.svs/);
  assert.match(text, /odd area/);
  // a non-image data URL is dropped, not forwarded
  const t2 = setup();
  const c2 = (await signupAndVerify(t2)).cookie;
  await post(t2.app, '/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }], context: { viewImage: 'data:text/html;base64,PHNjcmlwdD4=' } }, c2);
  assert.equal(t2.seen[0].messages.at(-1).content.filter((b: any) => b.type === 'image').length, 0);
});

test('AI rejects malformed messages and enforces the daily limit', async () => {
  const t = setup();
  const { cookie } = await signupAndVerify(t);
  assert.equal((await post(t.app, '/api/ai/chat', { messages: [] }, cookie)).statusCode, 400);
  assert.equal((await post(t.app, '/api/ai/chat', { messages: [{ role: 'system', content: 'x' }] }, cookie)).statusCode, 400);
  assert.equal((await post(t.app, '/api/ai/chat', { messages: [{ role: 'assistant', content: 'x' }] }, cookie)).statusCode, 400);
  const ok = { messages: [{ role: 'user', content: 'hi' }] };
  for (let i = 0; i < 3; i++) assert.equal((await post(t.app, '/api/ai/chat', ok, cookie)).statusCode, 200);
  const over = await post(t.app, '/api/ai/chat', ok, cookie);
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error, 'daily_limit');
});

test('AI without a configured provider answers 503; failures before streaming answer 502', async () => {
  const none = setup({}, null);
  const c1 = (await signupAndVerify(none)).cookie;
  assert.equal((await post(none.app, '/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] }, c1)).statusCode, 503);
  const broken: AiClient = { mock: false, provider: 'anthropic', model: 'fake', stream() { return (async function* () { throw new Error('upstream down'); })(); } };
  const t = setup({}, broken);
  const c2 = (await signupAndVerify(t)).cookie;
  const res = await post(t.app, '/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] }, c2);
  assert.equal(res.statusCode, 502);
  // a failed call must not use up the user's quota
  const ok = setup({ AI_DAILY_LIMIT: '1' }, broken);
  const c3 = (await signupAndVerify(ok)).cookie;
  await post(ok.app, '/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] }, c3);
  assert.notEqual((await post(ok.app, '/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] }, c3)).json().error, 'daily_limit');
});

test('config endpoint reports what is available without leaking secrets', async () => {
  const t = setup({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com', ANTHROPIC_API_KEY: 'sk-secret' });
  const c = (await t.app.inject({ method: 'GET', url: '/api/auth/config' })).json();
  assert.equal(c.googleClientId, 'abc.apps.googleusercontent.com');
  assert.equal(c.aiEnabled, true);
  assert.ok(!JSON.stringify(c).includes('sk-secret'));
});

test('OpenAI-compatible client (Ollama etc.) sends images as data URLs and streams the reply', async () => {
  let seenBody: any, seenAuth: string | undefined;
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    let raw = ''; req.on('data', c => (raw += c)); req.on('end', () => {
      seenBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const w of ['Likely ', 'kidney', ' cortex.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.write(': keep-alive\n\n'); res.write('data: [DONE]\n\n'); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const client = makeOpenAiCompatClient(`http://127.0.0.1:${port}/v1`, 'qwen2.5vl:3b', 'k');
    let out = '';
    for await (const c of client.stream({ system: 'SYS', messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }, { type: 'text', text: 'organ?' }] }] })) out += c;
    assert.equal(out, 'Likely kidney cortex.');
    assert.equal(seenAuth, 'Bearer k');
    assert.equal(seenBody.model, 'qwen2.5vl:3b');
    assert.equal(seenBody.stream, true);
    assert.equal(seenBody.messages[0].role, 'system');
    assert.equal(seenBody.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,QUJD');
    assert.equal(seenBody.messages[1].content[1].text, 'organ?');
  } finally { server.close(); }
  // a failing backend surfaces as an error (so the route answers 502 instead of an empty stream)
  const bad = makeOpenAiCompatClient('http://127.0.0.1:1/v1', 'm');
  await assert.rejects(async () => { for await (const _ of bad.stream({ system: '', messages: [{ role: 'user', content: 'x' }] })) { /* */ } });
  assert.equal(toOpenAiMessages('S', [{ role: 'user', content: 'plain' }])[1].content, 'plain');
});

const ann = (id: string) => ({ id, type: 'Annotation', body: [], target: { selector: { type: 'FragmentSelector', value: 'xywh=pixel:1,2,3,4' } } });
const put = (app: App, body: unknown, cookie = '') => app.inject({ method: 'PUT', url: '/api/annotations', payload: body as object, headers: { cookie } });

test('annotations: need an account; anonymous gets 401', async () => {
  const t = setup();
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/annotations' })).statusCode, 401);
  assert.equal((await put(t.app, { slide: 'public/a.svs', annotations: [ann('1')] })).statusCode, 401);
});

test('annotations: saved per user and slide, replaced on update, returned after "sign-in"', async () => {
  const t = setup();
  const { cookie } = await signupAndVerify(t, 'cara@example.com');
  assert.equal((await put(t.app, { slide: 'public/Case 01.svs', annotations: [ann('a'), ann('b')], updatedAt: 1000 }, cookie)).statusCode, 200);
  await put(t.app, { slide: 'public/Case 02.svs', annotations: [ann('c')] }, cookie);
  await put(t.app, { slide: 'public/Case 01.svs', annotations: [ann('a')], updatedAt: 2000 }, cookie); // replaces, not appends
  const all = (await t.app.inject({ method: 'GET', url: '/api/annotations', headers: { cookie } })).json().slides;
  assert.deepEqual(Object.keys(all).sort(), ['public/Case 01.svs', 'public/Case 02.svs']);
  assert.equal(all['public/Case 01.svs'].annotations.length, 1);
  assert.equal(all['public/Case 01.svs'].updatedAt, 2000);
  // a brand-new "login" session of the same user sees the same data
  const login = await post(t.app, '/api/auth/login', { email: 'cara@example.com', password: PASSWORD });
  const again = (await t.app.inject({ method: 'GET', url: '/api/annotations', headers: { cookie: cookieOf(login) } })).json().slides;
  assert.equal(again['public/Case 02.svs'].annotations[0].id, 'c');
});

test('annotations: users cannot see each other\'s work', async () => {
  const t = setup();
  const a = (await signupAndVerify(t, 'one@example.com')).cookie;
  await put(t.app, { slide: 'public/x.svs', annotations: [ann('secret')] }, a);
  const b = (await signupAndVerify(t, 'two@example.com')).cookie;
  assert.deepEqual((await t.app.inject({ method: 'GET', url: '/api/annotations', headers: { cookie: b } })).json().slides, {});
});

test('annotations: an empty list removes the slide; bad input is rejected', async () => {
  const t = setup();
  const { cookie } = await signupAndVerify(t, 'dan@example.com');
  await put(t.app, { slide: 's.svs', annotations: [ann('1')] }, cookie);
  await put(t.app, { slide: 's.svs', annotations: [] }, cookie);
  assert.deepEqual((await t.app.inject({ method: 'GET', url: '/api/annotations', headers: { cookie } })).json().slides, {});
  assert.equal((await put(t.app, { slide: '', annotations: [] }, cookie)).statusCode, 400);
  assert.equal((await put(t.app, { slide: 's.svs', annotations: 'nope' }, cookie)).statusCode, 400);
  assert.equal((await put(t.app, { slide: 's.svs', annotations: [{ noId: true }] }, cookie)).statusCode, 400);
  const huge = Array.from({ length: 30 }, (_, i) => ({ id: String(i), blob: 'x'.repeat(100_000) }));
  assert.equal((await put(t.app, { slide: 's.svs', annotations: huge }, cookie)).statusCode, 413);
});

test('annotations: foreign origins cannot write', async () => {
  const t = setup();
  const { cookie } = await signupAndVerify(t, 'eve@example.com');
  const r = await t.app.inject({ method: 'PUT', url: '/api/annotations', payload: { slide: 's', annotations: [ann('1')] }, headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 403);
});

test('without a database the API says so instead of crashing; config still works', async () => {
  const h = createHandler(cfg(), { sendEmail: async () => {}, verifyGoogle: null, ai: null });
  const me = await h(new Request('http://localhost:3000/api/auth/me'));
  assert.equal(me.status, 503);
  assert.equal((await me.json()).error, 'database_not_configured');
  const c = await h(new Request('http://localhost:3000/api/auth/config'));
  assert.equal(c.status, 200);
});

test('rate limits are kept in the database, so they hold across handler instances', async () => {
  const db = memoryDb();
  const mk = () => createHandler(cfg(), { db, sendEmail: async () => {}, verifyGoogle: null, ai: null });
  const login = (h: ReturnType<typeof mk>) => h(new Request('http://localhost:3000/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ email: 'a@example.com', password: 'x' }) }));
  const statuses: number[] = [];
  for (let i = 0; i < 22; i++) statuses.push((await login(i % 2 ? mk() : mk())).status); // a fresh instance each time, like cold starts
  assert.equal(statuses.filter(s => s === 401).length, 20);
  assert.deepEqual(statuses.slice(20), [429, 429]);
});

test('non-JSON bodies are refused (form posts cannot be used for CSRF)', async () => {
  const t = setup();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: undefined, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.statusCode, 415);
});

test('slides token: needs a signed-in user, and only works when a secret is configured', async () => {
  const none = setup();
  assert.equal((await post(none.app, '/api/auth/slides-token', {})).statusCode, 401);
  const c = (await signupAndVerify(none, 'tok0@example.com')).cookie;
  assert.equal((await post(none.app, '/api/auth/slides-token', {}, c)).statusCode, 503); // no SLIDES_TOKEN_SECRET
  const weak = setup({ SLIDES_TOKEN_SECRET: 'too-short' });
  const c2 = (await signupAndVerify(weak, 'tok1@example.com')).cookie;
  assert.equal((await post(weak.app, '/api/auth/slides-token', {}, c2)).statusCode, 503); // a weak secret is refused
});

test('slides token: a valid HS256 JWT that fs-slides can verify', async () => {
  const secret = 'a-very-long-shared-secret-for-the-test-0123456789';
  const t = setup({ SLIDES_TOKEN_SECRET: secret });
  const { cookie } = await signupAndVerify(t, 'Tok2@Example.com'); // stored lower-case
  const res = await post(t.app, '/api/auth/slides-token', {}, cookie);
  assert.equal(res.statusCode, 200);
  const { token, expiresAt } = res.json();
  const [h, p, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
  assert.equal(sig, createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.email, 'tok2@example.com');
  assert.equal(claims.iss, 'pathy-studio');
  assert.equal(claims.aud, 'fs-slides');
  assert.equal(claims.exp - claims.iat, 900);
  assert.equal(expiresAt, claims.exp * 1000);
  assert.ok(claims.exp * 1000 > Date.now() && claims.exp * 1000 <= Date.now() + 901_000);
});

test('slides token: issuer and audience follow AUTH_ISSUER / AUTH_AUDIENCE (same names fs-slides reads)', async () => {
  const t = setup({ SLIDES_TOKEN_SECRET: 'a-very-long-shared-secret-for-the-test-0123456789', AUTH_ISSUER: 'iss-x', AUTH_AUDIENCE: 'aud-y' });
  const { cookie } = await signupAndVerify(t, 'tok3@example.com');
  const claims = JSON.parse(Buffer.from((await post(t.app, '/api/auth/slides-token', {}, cookie)).json().token.split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, 'iss-x');
  assert.equal(claims.aud, 'aud-y');
});

test('emails that could escape a folder are not accepted at signup, and the helper agrees', async () => {
  const t = setup();
  for (const bad of ['../x@example.com', 'a/b@example.com', 'a\\b@example.com', 'x..y@example.com', '.dot@example.com']) {
    assert.equal((await post(t.app, '/api/auth/signup', { email: bad, password: PASSWORD })).statusCode, 400, bad);
  }
  assert.ok(isSafeFolderName('first.last+tag@sub.example.co'));
  assert.ok(!isSafeFolderName('/abs@x.com') && !isSafeFolderName('') && !isSafeFolderName('nul\u0000@x.com'));
});
