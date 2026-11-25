// Emails from Jace Recipes, sent through Jace's email API (POST /api/oauth/email)
// with the app's client id and secret. Jace sends them from its own address in
// its email template, using Jace Recipes' colors. Jace only emails people who
// have signed in to Jace Recipes and have a confirmed email, and people can
// turn all app emails off on Jace (Manage account → Emails). Jace allows 20
// emails per person per day.
//
// On top of that, each person picks which kinds they want in Jace Recipes
// Settings (EMAIL_TYPES below). Sending never blocks or breaks a request.
import { JACE_URL } from './jace.js';

export const EMAIL_TYPES = {
  comments: 'Someone comments on my recipe',
  invites: 'Someone invites me to make a recipe with them',
  recipe_updates: 'My recipe is approved, made Jace Verified or taken down',
  role: 'I can post Jace Verified recipes',
  welcome: 'Welcome email',
  admin_review: 'Admin: something is waiting for review',
};
export const DEFAULT_EMAIL_PREFS = Object.fromEntries(Object.keys(EMAIL_TYPES).map((k) => [k, true]));

const appUrl = () => (process.env.APP_URL || 'https://jace-recipes.vercel.app').replace(/\/$/, '');

// Jace's light colors, so the email looks like Jace Recipes.
const theme = () => ({
  background: '#f4f5f7', card: '#ffffff', line: '#dfe2e7', text: '#16181d', muted: '#5d6470', accent: '#1f9d5a', on_accent: '#ffffff',
  logo_url: `${appUrl()}/icon.png`, home_url: appUrl(),
});

// Lets a send finish after the response on Vercel; locally it just runs.
async function later(promise) {
  if (process.env.VERCEL) {
    try {
      const { waitUntil } = await import('@vercel/functions');
      waitUntil(promise);
      return;
    } catch { /* fall through */ }
  }
  promise.catch(() => {});
}

export const wantsEmail = (user, type) => Boolean(user) && ({ ...DEFAULT_EMAIL_PREFS, ...(user.email_prefs || {}) })[type] !== false;

/**
 * Queues an email to a Jace Recipes user. Never throws.
 * @param {object} user  a users row (needs sub and email_prefs)
 * @param {keyof EMAIL_TYPES} type
 * @param {{subject:string, heading?:string, message:string, buttonLabel?:string, path?:string}} mail
 */
export function sendEmail(user, type, mail) {
  if (!user || user.banned || user.jace_banned || !wantsEmail(user, type)) return;
  const id = process.env.JACE_CLIENT_ID;
  const secret = process.env.JACE_CLIENT_SECRET;
  if (!id || !secret || process.env.EMAILS_OFF === '1') return;
  const send = (async () => {
    try {
      const res = await fetch(`${JACE_URL}/api/oauth/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
        body: JSON.stringify({
          user_id: user.sub,
          subject: mail.subject.replace(/[\r\n]+/g, ' ').slice(0, 150),
          heading: (mail.heading || '').slice(0, 150) || undefined,
          message: mail.message.slice(0, 5000),
          button_label: mail.path ? (mail.buttonLabel || 'Open Jace Recipes').slice(0, 40) : undefined,
          button_url: mail.path ? `${appUrl()}/${mail.path.replace(/^\//, '')}` : undefined,
          theme: theme(),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) console.warn(`[email] ${type} not sent: Jace answered ${res.status}`);
    } catch (e) {
      console.warn(`[email] ${type} not sent: ${e.message}`);
    }
  })();
  return later(send);
}

// Shortens user-written text quoted in an email.
export const quote = (t, n = 300) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
