// The session is one encrypted, HTTP-only cookie (AES-256-GCM, key derived
// from SESSION_SECRET) holding the Jace user id. Nothing to store server side.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'jr_session';
export const STATE_COOKIE = 'jr_oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters (see README.md).');
  return createHash('sha256').update(secret).digest();
}

export function seal(data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(value) {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export const sessionCookie = (sub, secure) => cookie(SESSION_COOKIE, seal({ sub, exp: Date.now() + SESSION_MAX_AGE * 1000 }), SESSION_MAX_AGE, secure);
export const clearSession = (secure) => cookie(SESSION_COOKIE, '', 0, secure);
export const stateCookie = (value, secure) => cookie(STATE_COOKIE, seal(value), 600, secure);
export const clearState = (secure) => cookie(STATE_COOKIE, '', 0, secure);

/** The signed-in Jace user id, or null. */
export function sessionSub(req) {
  const s = unseal(readCookie(req, SESSION_COOKIE));
  return s && s.sub && s.exp > Date.now() ? s.sub : null;
}
