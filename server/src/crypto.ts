import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((res, rej) => _scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do the work, even for unknown users, so response time doesn't reveal which emails exist.
  const parts = (stored ?? '').split('$');
  const ok = parts.length === 6 && parts[0] === 'scrypt';
  const salt = ok ? Buffer.from(parts[4], 'base64') : Buffer.alloc(16);
  const expected = ok ? Buffer.from(parts[5], 'base64') : Buffer.alloc(KEYLEN);
  const key = await scrypt(password, salt, ok ? Number(parts[1]) : N, ok ? Number(parts[2]) : R, ok ? Number(parts[3]) : P);
  return ok && key.length === expected.length && timingSafeEqual(key, expected);
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
