// Sign in with Jace: plain OAuth 2.0 authorization code flow against Jace
// (https://jaceo.vercel.app). The client secret only ever lives on the server.

export const JACE_URL = (process.env.JACE_URL || 'https://jaceo.vercel.app').replace(/\/$/, '');

function credentials() {
  const clientId = process.env.JACE_CLIENT_ID;
  const clientSecret = process.env.JACE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('JACE_CLIENT_ID and JACE_CLIENT_SECRET must be set (see README.md).');
  return { clientId, clientSecret };
}

export function authorizeUrl({ redirectUri, state }) {
  const url = new URL(`${JACE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials().clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'profile');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(`${JACE_URL}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) throw new Error(`Jace token exchange failed: ${data?.error ?? res.status}`);
  return data.access_token;
}

/** { sub, username, name, picture, banned, muted } */
export async function getUserInfo(token) {
  const res = await fetch(`${JACE_URL}/api/oauth/userinfo`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.sub) throw new Error(`Jace userinfo failed: ${res.status}`);
  return {
    sub: String(data.sub),
    username: String(data.username || 'jace_user'),
    name: String(data.display_name || data.name || data.username || 'Jace user'),
    picture: typeof data.picture === 'string' && /^https:\/\//.test(data.picture) ? data.picture : null,
    banned: Boolean(data.banned),
    muted: Boolean(data.muted),
  };
}

// Jace's own auto moderation terms (Manage account → Moderation on Jace).
// Only works once Jace Recipes is an official app; otherwise we just use our own lists.
let automodCache = { at: 0, terms: [] };
export async function jaceBlockedTerms() {
  if (Date.now() - automodCache.at < 5 * 60 * 1000) return automodCache.terms;
  let terms = [];
  try {
    const { clientId, clientSecret } = credentials();
    const res = await fetch(`${JACE_URL}/api/oauth/automod`, {
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.enabled !== false && Array.isArray(data.blocked_terms)) terms = data.blocked_terms.filter((t) => typeof t === 'string' && t.trim());
    }
  } catch { /* Jace unreachable: fall back to our own lists */ }
  automodCache = { at: Date.now(), terms };
  return terms;
}
