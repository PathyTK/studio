// Runs the same handler as a plain Node HTTP server (Docker / local). On Vercel this file is not used.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig } from './config.js';
import { createHandler } from './handler.js';

const cfg = loadConfig();
const missing: string[] = [];
if (!cfg.databaseUrl) missing.push('DATABASE_URL (users and saved annotations)');
if (!cfg.resendApiKey) missing.push('RESEND_API_KEY (confirmation emails)');
if (!cfg.googleClientId) missing.push('GOOGLE_CLIENT_ID (Google sign-in)');
if (!cfg.anthropicApiKey && !(cfg.llmBaseUrl && cfg.llmModel)) missing.push('ANTHROPIC_API_KEY or LLM_BASE_URL+LLM_MODEL (AI chat)');
if (!cfg.anthropicApiKey && cfg.llmBaseUrl && cfg.llmModel) console.log(`[config] AI chat uses the OpenAI-compatible backend ${cfg.llmBaseUrl} (model ${cfg.llmModel}).`);
if (missing.length) {
  console.warn(`[config] not set: ${missing.join(', ')}.` +
    (cfg.production ? ' These features will be unavailable.' : ' Dev mode: emails are printed here and the AI answers with a mock.'));
}

const handler = createHandler(cfg);

createServer(async (req, res) => {
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
      duplex: 'half',
    } as RequestInit);
    const response = await handler(request);
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (response.body) {
      const reader = response.body.getReader();
      res.on('close', () => { reader.cancel().catch(() => {}); });
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
    }
    res.end();
  } catch (e) {
    console.error('request failed', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"internal_error"}');
  }
}).listen(cfg.port, '0.0.0.0', () => console.log(`pathy-server listening on :${cfg.port} (${cfg.appUrl})`));
