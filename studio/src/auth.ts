// Client for the pathy-api service (same origin via nginx: the session cookie is httpOnly, JS never sees it).
export interface User { id: number; email: string; name: string | null }
export interface AuthConfig {
  googleClientId: string | null; aiEnabled: boolean; aiMock: boolean; aiDailyLimit: number;
  aiProvider: 'anthropic' | 'openai-compatible' | 'mock' | null; aiModel: string | null;
}

export class ApiError extends Error { constructor(message: string, public code?: string, public status?: number) { super(message); } }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(path, { credentials: 'same-origin', ...init }); }
  catch { throw new ApiError('Cannot reach the server. Check your connection.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.message ?? friendly(data.error) ?? `Request failed (${r.status})`, data.error, r.status);
  return data as T;
}
const friendly = (code?: string) => ({
  invalid_email: 'Enter a valid email address.',
  weak_password: 'Use at least 10 characters for the password.',
  too_many_requests: 'Too many attempts. Wait a few minutes and try again.',
  forbidden_origin: 'This site is not allowed to reach the server.',
  invalid_google_token: 'Google sign-in failed. Try again.',
}[code ?? ''] as string | undefined);

const post = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const fetchConfig = () => call<AuthConfig>('/api/auth/config');
export const fetchMe = () => call<{ user: User | null }>('/api/auth/me').then(r => r.user);
export const signup = (email: string, password: string, name: string) => post<{ ok: true; message: string }>('/api/auth/signup', { email, password, name });
export const login = (email: string, password: string) => post<{ user: User }>('/api/auth/login', { email, password }).then(r => r.user);
export const resend = (email: string) => post<{ ok: true; message: string }>('/api/auth/resend', { email });
export const googleLogin = (credential: string) => post<{ user: User }>('/api/auth/google', { credential }).then(r => r.user);
export const logout = () => post<{ ok: true }>('/api/auth/logout', {});

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatContext {
  slideName?: string; magnification?: string; viewImage?: string;
  annotation?: { kind: string; size?: string; note?: string; image?: string };
}

/** Streams the assistant's answer; resolves with how many messages are left today (if the server says). */
export async function streamChat(messages: ChatMessage[], context: ChatContext, onText: (t: string) => void, signal?: AbortSignal): Promise<number | null> {
  let r: Response;
  try {
    r = await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, context }) });
  } catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new ApiError('Cannot reach the server. Check your connection.'); }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new ApiError(d.message ?? `Request failed (${r.status})`, d.error, r.status);
  }
  const reader = r.body!.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; onText(dec.decode(value, { stream: true })); }
  const left = r.headers.get('X-AI-Remaining');
  return left === null ? null : Number(left);
}
