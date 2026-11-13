// Short-lived tokens that let a signed-in studio user call fs-slides (their private slides).
// HS256 JWT signed with SLIDES_TOKEN_SECRET, the same secret fs-slides verifies with. No library needed.
import { createHmac } from 'node:crypto';

export const SLIDES_TOKEN_TTL_SECONDS = 15 * 60;
export const MIN_SECRET_LENGTH = 32;

/** The email becomes a directory name in fs-slides: it must not be able to point anywhere else. */
export const isSafeFolderName = (name: string) =>
  name.length > 0 && name.length <= 254 && name.includes('@') && !name.startsWith('.') && !name.includes('..') && !/[\/\\\u0000-\u001f\u007f]/.test(name);

export function signSlidesToken(
  secret: string,
  claims: { issuer: string; audience: string; userId: number; email: string },
  nowMs = Date.now(),
): { token: string; expiresAt: number } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + SLIDES_TOKEN_TTL_SECONDS;
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: claims.issuer, aud: claims.audience, sub: String(claims.userId), email: claims.email, iat, exp })}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return { token: `${data}.${sig}`, expiresAt: exp * 1000 };
}
