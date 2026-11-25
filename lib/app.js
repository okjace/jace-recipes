// The Jace Recipes API. One handler for every /api/* request, used by both
// the Vercel function (api/index.js) and the local dev server (server.js).
import { randomBytes, randomUUID } from 'node:crypto';
import { query, one } from './db.js';
import { moderateRecipe, moderateName, moderateComment, mentions } from './moderation.js';
import { sendEmail, quote, EMAIL_TYPES, DEFAULT_EMAIL_PREFS } from './email.js';
import { authorizeUrl, exchangeCode, getUserInfo, jaceBlockedTerms } from './jace.js';
import { generateRecipe, aiConfigured } from './ai.js';
import { polishRecipe } from './polish.js';
import { notify, clearInvite, inbox, unreadCount } from './notify.js';
import { sessionSub, sessionCookie, clearSession, stateCookie, clearState, readCookie, unseal, STATE_COOKIE } from './session.js';

const ADMIN = (process.env.ADMIN_USERNAME || 'okjace').toLowerCase();
const ADMIN_SUB = process.env.ADMIN_JACE_SUB || null; // optional: pin the admin to one Jace account id
export const CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Lunchbox', 'Snacks', 'Desserts', 'Drinks', 'Baby & Toddler', 'Holidays'];

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isAdmin = (u) => Boolean(u) && u.username.toLowerCase() === ADMIN && (!ADMIN_SUB || u.sub === ADMIN_SUB);
const canVerify = (u) => Boolean(u) && (isAdmin(u) || u.role === 'verifier');
const requireUser = (u) => {
  if (!u) throw new HttpError(401, 'Sign in with Jace first.');
  if (u.banned || u.jace_banned) throw new HttpError(403, 'This Jace account is suspended from Jace Recipes.');
  return u;
};
const requireAdmin = (u) => { if (!isAdmin(u)) throw new HttpError(403, `Only @${ADMIN} can do that.`); return u; };

function appOrigin(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}
const isSecure = (req) => appOrigin(req).startsWith('https://');
const safeNext = (v) => (typeof v === 'string' && /^\/(?!\/|\\)/.test(v) ? v : '/');

// ---------------------------------------------------------------- views
function publicUser(u) {
  if (!u) return { username: 'deleted', displayName: 'Deleted user', avatar: null, bio: '', role: 'user' };
  return { username: u.username, displayName: u.display_name, avatar: u.avatar_url, bio: u.bio, role: isAdmin(u) ? 'admin' : u.role, createdAt: Number(u.created_at) };
}
const USER_COLS = 'u.sub AS u_sub, u.username AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url, u.bio AS u_bio, u.role AS u_role, u.created_at AS u_created_at';
const RECIPE_SELECT = `SELECT r.*, ${USER_COLS},
  (SELECT AVG(stars)::float8 FROM ratings x WHERE x.recipe_id = r.id) AS rating_avg,
  (SELECT COUNT(*)::int FROM ratings x WHERE x.recipe_id = r.id) AS rating_count,
  (SELECT COUNT(*)::int FROM comments c WHERE c.recipe_id = r.id AND c.status = 'published') AS comment_count,
  (SELECT COALESCE(json_agg(json_build_object('sub', k.sub, 'status', k.status, 'username', cu.username, 'displayName', cu.display_name, 'avatar', cu.avatar_url) ORDER BY k.created_at), '[]'::json)
     FROM collaborators k JOIN users cu ON cu.sub = k.sub WHERE k.recipe_id = r.id) AS collabs
  FROM recipes r JOIN users u ON u.sub = r.author_sub`;
function recipeView(row, viewer, full = false) {
  const author = { sub: row.u_sub, username: row.u_username, display_name: row.u_display_name, avatar_url: row.u_avatar_url, bio: row.u_bio, role: row.u_role, created_at: row.u_created_at };
  const out = {
    id: row.id, title: row.title, description: row.description, category: row.category, prepTime: row.prep_time,
    servings: row.servings, image: row.image_url, verified: row.verified, visibility: row.visibility || 'public', allergens: row.allergens || [], aiAssisted: Boolean(row.ai_assisted), status: row.status, author: publicUser(author),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), safetyNotes: row.safety_notes || [],
    rating: row.rating_avg == null ? null : Math.round(Number(row.rating_avg) * 10) / 10, ratingCount: Number(row.rating_count || 0),
    commentCount: Number(row.comment_count || 0),
  };
  if (full) {
    out.ingredients = row.ingredients;
    out.steps = row.steps;
    // Always run the latest rules on the recipe page, so older recipes get new safety notes too.
    const mod = moderateRecipe(row);
    out.safetyNotes = mod.safetyNotes;
    out.checks = mod.checks;
    out.allergens = mod.allergens;
  }
  out.allergyHits = allergyHits({ ...row, allergens: out.allergens }, viewer);
  const collabs = row.collabs || [];
  const insider = viewer && (viewer.sub === row.author_sub || isAdmin(viewer) || collabs.some((c) => c.sub === viewer.sub));
  // Accepted co-authors are public; open invites only show to the people involved.
  out.collaborators = collabs.filter((c) => c.status === 'accepted' || insider).map((c) => ({ username: c.username, displayName: c.displayName, avatar: c.avatar, status: c.status }));
  out.isOwner = Boolean(viewer && (viewer.sub === row.author_sub || isAdmin(viewer)));
  out.canEdit = canEdit(row, viewer);
  out.myInvite = Boolean(viewer && collabs.some((c) => c.sub === viewer.sub && c.status === 'invited'));
  if (viewer && (viewer.sub === row.author_sub || isAdmin(viewer))) {
    out.modReasons = row.mod_reasons || [];
    out.takedownReason = row.takedown_reason || null;
  }
  return out;
}
const collabOf = (row, viewer, statuses = ['accepted']) => Boolean(viewer && (row.collabs || []).some((c) => c.sub === viewer.sub && statuses.includes(c.status)));
// Co-authors (and people invited, so they can decide) can open private and held recipes too.
const canSee = (row, viewer) => (row.status === 'published' && row.visibility !== 'private') || Boolean(viewer && (viewer.sub === row.author_sub || isAdmin(viewer) || collabOf(row, viewer, ['accepted', 'invited'])));
const canEdit = (row, viewer) => Boolean(viewer && (viewer.sub === row.author_sub || isAdmin(viewer) || collabOf(row, viewer)));
const teamOf = (row) => [row.author_sub, ...(row.collabs || []).filter((c) => c.status === 'accepted').map((c) => c.sub)];

// Which of the viewer's allergies (the usual ones and any they typed in) this recipe has. Private to the viewer.
function allergyHits(row, viewer) {
  if (!viewer) return [];
  const fixed = (row.allergens || []).filter((a) => (viewer.allergies || []).includes(a));
  const custom = (viewer.custom_allergies || []).filter((t) => mentions(row.ingredients, t));
  return [...fixed, ...custom];
}

const getAdminUser = () => one(`SELECT * FROM users WHERE lower(username) = $1 ${ADMIN_SUB ? 'AND sub = $2' : ''} ORDER BY last_seen_at DESC LIMIT 1`, ADMIN_SUB ? [ADMIN, ADMIN_SUB] : [ADMIN]);
const getUser = (sub) => one('SELECT * FROM users WHERE sub = $1', [sub]);
const recipePath = (id) => `#/r/${id}`;
async function emailAdminReview(what, title, path) {
  const admin = await getAdminUser();
  if (admin) notify(admin.sub, { type: 'review', recipeId: (/#\/r\/(.+)$/.exec(path) || [])[1] || null, data: { what, title: quote(title, 120) } });
  sendEmail(admin, 'admin_review', {
    subject: `Waiting for review: ${quote(title, 80)}`,
    heading: `${what} is waiting for your review`,
    message: `Auto moderation held this for you to check:\n\n“${quote(title, 200)}”\n\nApprove it or take it down from the Admin page.`,
    buttonLabel: 'Review it', path,
  });
}

// ---------------------------------------------------------------- images
// Pictures are stored in the database and served from /api/images/<id>.
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
async function storeImage(value, current, owner, maxBytes) {
  if (value === undefined) return current;                 // unchanged
  if (value === null || value === '') { await dropImage(current); return null; }
  if (typeof value === 'string' && value === current) return current;
  if (typeof value === 'string' && /^https:\/\//.test(value) && value === current) return current;
  const m = typeof value === 'string' && IMAGE_RE.exec(value);
  if (!m) throw new HttpError(400, 'Pictures must be PNG, JPEG, WebP or GIF.');
  if (m[2].length * 0.75 > maxBytes) throw new HttpError(400, `That picture is too big (max ${Math.round(maxBytes / 1024)} KB).`);
  const id = randomUUID();
  await query('INSERT INTO images (id, owner_sub, mime, data, created_at) VALUES ($1, $2, $3, $4, $5)', [id, owner, `image/${m[1]}`, m[2], Date.now()]);
  await dropImage(current);
  return `/api/images/${id}`;
}
async function dropImage(url) {
  const m = /^\/api\/images\/([0-9a-f-]{36})$/.exec(url || '');
  if (m) await query('DELETE FROM images WHERE id = $1', [m[1]]);
}

// ---------------------------------------------------------------- recipes
// public: everyone, in lists and search. unlisted: anyone with the link. private: only the author (and the admin, for safety).
const VISIBILITY = ['public', 'unlisted', 'private'];
function parseRecipe(body) {
  const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => str(x, 300)).filter(Boolean).slice(0, 60);
  const r = {
    title: str(body.title, 100),
    description: str(body.description, 1000),
    category: CATEGORIES.includes(body.category) ? body.category : 'Dinner',
    prepTime: Math.max(0, Math.min(1440, parseInt(body.prepTime, 10) || 0)),
    servings: Math.max(1, Math.min(100, parseInt(body.servings, 10) || 1)),
    ingredients: lines(body.ingredients),
    steps: lines(body.steps),
    visibility: VISIBILITY.includes(body.visibility) ? body.visibility : 'public',
  };
  if (r.title.length < 3) throw new HttpError(400, 'Give your recipe a title (at least 3 letters).');
  return r;
}
async function runModeration(r, user, { recipeId = null, bypass = false } = {}) {
  const mod = moderateRecipe(r, await jaceBlockedTerms());
  if (mod.decision === 'block' && bypass && isAdmin(user)) {
    // @okjace chose "Publish anyway": keep the reasons on record.
    return { safetyNotes: mod.safetyNotes, allergens: mod.allergens, modReasons: [`Published by @${ADMIN} despite auto moderation: ${mod.reasons.join(' ')}`], status: 'published' };
  }
  if (mod.decision === 'block') {
    // Keep a copy so @okjace can see what was blocked (and publish it anyway if it was a mistake).
    const attemptId = randomUUID();
    const { image, ...data } = r;
    await query('INSERT INTO blocked_attempts (id, author_sub, recipe_id, data, reasons, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [attemptId, user.sub, recipeId, JSON.stringify(data), JSON.stringify(mod.reasons), Date.now()]);
    if (!isAdmin(user)) getAdminUser().then((a) => a && notify(a.sub, { type: 'blocked', recipeId, actorSub: user.sub, data: { title: quote(r.title, 120), reasons: mod.reasons } })).catch(() => {});
    throw new HttpError(422, 'Auto-moderation stopped this recipe.', { reasons: mod.reasons, canOverride: isAdmin(user) });
  }
  return {
    safetyNotes: mod.safetyNotes,
    allergens: mod.allergens,
    modReasons: mod.decision === 'review' ? mod.reasons : [],
    // Everyone's recipes go to the review queue when flagged, @okjace's too (approve with one click).
    // Private recipes skip the queue since nobody else can see them, but the block list still applies.
    status: mod.decision === 'review' && r.visibility !== 'private' ? 'pending' : 'published',
  };
}
async function findRecipe(id) {
  const row = await one(`${RECIPE_SELECT} WHERE r.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Recipe not found.');
  return row;
}
const sortSql = 'ORDER BY r.verified DESC, r.created_at DESC'; // Jace Verified always on top

const SEEDS = [
  { title: 'Sunday Morning Pancakes', category: 'Breakfast', prepTime: 20, servings: 4,
    description: 'Fluffy pancakes the whole family can help make. Kids love pouring the batter.',
    ingredients: ['1 1/2 cups flour', '3 1/2 tsp baking powder', '1 tbsp sugar', '1/4 tsp salt', '1 1/4 cups milk', '1 egg', '3 tbsp melted butter'],
    steps: ['Whisk the flour, baking powder, sugar and salt in a big bowl.', 'Make a well in the middle and pour in the milk, egg and melted butter. Mix until just smooth.', 'Heat a lightly oiled pan over medium heat. Pour about 1/4 cup of batter per pancake.', 'Flip when bubbles form on top, then cook until golden on the other side.'] },
  { title: 'Five-Minute Lunchbox Pinwheels', category: 'Lunchbox', prepTime: 5, servings: 2,
    description: 'Roll, slice, pack. A no-cook lunch that survives the backpack.',
    ingredients: ['2 large flour tortillas', '4 tbsp cream cheese', '4 slices turkey', '1 handful spinach', '1/4 cup shredded cheese'],
    steps: ['Spread cream cheese all the way to the edges of each tortilla.', 'Layer turkey, spinach and cheese on top.', 'Roll up tightly and slice into 1-inch rounds.', 'Pack with an ice pack to keep cold.'] },
  { title: 'One-Pan Chicken and Veggies', category: 'Dinner', prepTime: 35, servings: 4,
    description: 'Weeknight dinner with one pan to wash. Swap in whatever veggies your kids will eat.',
    ingredients: ['1 1/2 lb chicken thighs', '2 cups broccoli florets', '2 carrots, sliced', '1 bell pepper, chopped', '2 tbsp olive oil', '1 tsp garlic powder', '1 tsp paprika', 'Salt and pepper'],
    steps: ['Heat the oven to 425°F (220°C).', 'Toss the chicken and veggies with oil and spices on a sheet pan.', 'Spread everything out in one layer.', 'Roast 25 to 30 minutes until the chicken reaches 165°F inside.'] },
  { title: 'Banana Oat Baby Bites', category: 'Baby & Toddler', prepTime: 25, servings: 12,
    description: 'Soft, no-sugar-added bites that are easy for little hands to hold.',
    ingredients: ['2 ripe bananas', '1 cup rolled oats', '1/2 tsp cinnamon', '1/4 cup unsweetened applesauce'],
    steps: ['Heat the oven to 350°F (175°C) and line a tray with parchment.', 'Mash the bananas, then stir in oats, cinnamon and applesauce.', 'Scoop small spoonfuls onto the tray and flatten slightly.', 'Bake 15 minutes until set. Cool completely before serving.'] },
];
async function seedIfEmpty(admin) {
  const row = await one('SELECT COUNT(*)::int AS n FROM recipes');
  if (row.n > 0) return;
  const now = Date.now();
  for (const [i, s] of SEEDS.entries()) {
    const mod = moderateRecipe(s);
    await query(`INSERT INTO recipes (id, author_sub, title, description, category, prep_time, servings, ingredients, steps, verified, status, safety_notes, allergens, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'published',$10,$11,$12,$12)`,
    [randomUUID(), admin.sub, s.title, s.description, s.category, s.prepTime, s.servings, JSON.stringify(s.ingredients), JSON.stringify(s.steps), JSON.stringify(mod.safetyNotes), JSON.stringify(mod.allergens), now - i * 1000]);
  }
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/meta', () => ({ categories: CATEGORIES, admin: ADMIN, ai: aiConfigured(), allergens: ALLERGENS, emailTypes: EMAIL_TYPES }));

// ---- Sign in with Jace (the only way to sign in)
route('GET', '/api/auth/signin', ({ req, query: q }) => {
  const state = randomBytes(24).toString('base64url');
  const next = safeNext(q.get('next'));
  let url;
  try {
    url = authorizeUrl({ redirectUri: `${appOrigin(req)}/api/auth/callback`, state });
  } catch (e) {
    console.error(e.message);
    return { redirect: `/#/signin-error?reason=${encodeURIComponent('Sign in with Jace isn’t set up on this site yet.')}` };
  }
  return { redirect: url, headers: { 'Set-Cookie': stateCookie({ state, next }, isSecure(req)) } };
});

route('GET', '/api/auth/callback', async ({ req, query: q }) => {
  const secure = isSecure(req);
  const saved = unseal(readCookie(req, STATE_COOKIE));
  const fail = (reason) => ({ redirect: `/#/signin-error?reason=${encodeURIComponent(reason)}`, headers: { 'Set-Cookie': clearState(secure) } });
  if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'You cancelled signing in.' : 'Jace could not sign you in.');
  if (!saved || !q.get('state') || saved.state !== q.get('state') || !q.get('code')) return fail('That sign-in link expired. Try again.');
  let info;
  try {
    const token = await exchangeCode(q.get('code'), `${appOrigin(req)}/api/auth/callback`);
    info = await getUserInfo(token);
  } catch (e) {
    console.error(e);
    return fail('Could not reach Jace. Try again in a minute.');
  }
  if (info.banned) return fail('This Jace account is banned.');
  const now = Date.now();
  // Jace owns the username; display name and picture start from Jace but are then the person's own on Jace Recipes.
  const user = await one(`INSERT INTO users (sub, username, display_name, avatar_url, jace_banned, jace_muted, created_at, last_seen_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
    ON CONFLICT (sub) DO UPDATE SET username = EXCLUDED.username, jace_banned = EXCLUDED.jace_banned, jace_muted = EXCLUDED.jace_muted, last_seen_at = EXCLUDED.last_seen_at
    RETURNING *, (xmax = 0) AS inserted`, [info.sub, info.username, str(info.name, 40) || info.username, info.picture, info.banned, info.muted, now]);
  if (user.banned) return fail('This Jace account is suspended from Jace Recipes.');
  if (user.inserted) {
    sendEmail(user, 'welcome', {
      subject: 'Welcome to Jace Recipes',
      heading: `Welcome, ${quote(user.display_name, 40)}!`,
      message: 'Thanks for joining Jace Recipes, where parents share the recipes their families actually eat.\n\nHere’s what you can do:\n• Share your family favorites (we fix spelling for you)\n• Save your family’s allergies to get warnings on recipes\n• Rate and comment on recipes you try\n• Make a recipe with AI\n\nLook for the Jace Verified badge for tried-and-true picks.',
      buttonLabel: 'Share a recipe', path: '#/new',
    });
  }
  if (isAdmin(user)) await seedIfEmpty(user);
  return { redirect: saved.next || '/', headers: { 'Set-Cookie': [clearState(secure), sessionCookie(user.sub, secure)] } };
});

route('POST', '/api/auth/signout', ({ req }) => ({ body: { ok: true }, headers: { 'Set-Cookie': clearSession(isSecure(req)) } }));

// Allergies and email choices are private to the person.
const meView = (u) => ({ ...publicUser(u), muted: u.jace_muted, allergies: u.allergies || [], customAllergies: u.custom_allergies || [], emailPrefs: { ...DEFAULT_EMAIL_PREFS, ...(u.email_prefs || {}) } });
route('GET', '/api/me', ({ user }) => ({ user: user && !user.banned && !user.jace_banned ? meView(user) : null }));

// Jace username is fixed (Jace owns it). Display name, picture and bio can change here.
route('PATCH', '/api/me', async ({ user, body }) => {
  requireUser(user);
  const terms = await jaceBlockedTerms();
  let displayName = user.display_name;
  let bio = user.bio;
  if (body.displayName !== undefined) {
    displayName = str(body.displayName, 40);
    if (!displayName) throw new HttpError(400, 'Display name cannot be empty.');
    const bad = moderateName(displayName, terms);
    if (bad) throw new HttpError(400, bad);
  }
  if (body.bio !== undefined) {
    bio = str(body.bio, 300);
    if (bio && moderateName(bio, terms)) throw new HttpError(400, 'Please keep your bio family friendly.');
  }
  if (body.username !== undefined && body.username !== user.username) throw new HttpError(400, 'Your username comes from your Jace account and can only be changed on Jace.');
  const avatar = await storeImage(body.avatar, user.avatar_url, user.sub, 300 * 1024);
  const allergies = Array.isArray(body.allergies) ? [...new Set(body.allergies.filter((a) => ALLERGENS.includes(a)))] : (user.allergies || []);
  let custom = user.custom_allergies || [];
  if (Array.isArray(body.customAllergies)) {
    custom = [...new Set(body.customAllergies.map((t) => str(t, 40).toLowerCase()).filter((t) => t.length >= 2 && /[a-z]/.test(t)))];
    if (custom.length > 25) throw new HttpError(400, 'You can save up to 25 of your own allergies.');
  }
  let prefs = user.email_prefs || {};
  if (body.emailPrefs && typeof body.emailPrefs === 'object') {
    prefs = Object.fromEntries(Object.keys(EMAIL_TYPES).map((k) => [k, body.emailPrefs[k] !== false]));
  }
  const updated = await one('UPDATE users SET display_name = $2, bio = $3, avatar_url = $4, allergies = $5, custom_allergies = $6, email_prefs = $7 WHERE sub = $1 RETURNING *',
    [user.sub, displayName, bio, avatar, JSON.stringify(allergies), JSON.stringify(custom), JSON.stringify(prefs)]);
  return { user: meView(updated) };
});

route('GET', '/api/users/:username', async ({ user, params }) => {
  const u = await one('SELECT * FROM users WHERE lower(username) = lower($1) ORDER BY last_seen_at DESC LIMIT 1', [params.username]);
  if (!u || u.banned || u.jace_banned) throw new HttpError(404, 'No one on Jace Recipes has that Jace username.');
  const rows = await query(`${RECIPE_SELECT} WHERE r.author_sub = $1 OR EXISTS (SELECT 1 FROM collaborators k WHERE k.recipe_id = r.id AND k.sub = $1 AND k.status = 'accepted') ${sortSql}`, [u.sub]);
  const own = user && (user.sub === u.sub || isAdmin(user));
  return { user: publicUser(u), recipes: rows.filter((r) => (own ? true : r.status === 'published' && r.visibility === 'public')).map((r) => recipeView(r, user)) };
});

// Allergen names match lib/moderation.js. Older recipes get theirs worked out once.
export const ALLERGENS = ['peanut', 'tree nuts', 'milk', 'eggs', 'wheat', 'soy', 'fish', 'shellfish', 'sesame'];
let allergensFilled = false;
// Re-checks saved allergens with the latest rules once per server start, so rule improvements reach older recipes.
async function fillMissingAllergens() {
  if (allergensFilled) return;
  allergensFilled = true;
  const rows = await query('SELECT id, title, description, category, ingredients, steps, allergens FROM recipes ORDER BY created_at DESC LIMIT 2000');
  for (const r of rows) {
    const now = JSON.stringify(moderateRecipe(r).allergens);
    if (JSON.stringify(r.allergens) !== now) await query('UPDATE recipes SET allergens = $2 WHERE id = $1', [r.id, now]);
  }
}

// GET /api/recipes?q=&category=&verified=only|none&maxTime=30&sort=new|quick|az&free=milk,eggs&ai=none|only&offset=0&limit=24
route('GET', '/api/recipes', async ({ user, query: q }) => {
  await fillMissingAllergens();
  const where = ["r.status = 'published'", "r.visibility = 'public'", 'NOT u.banned', 'NOT u.jace_banned'];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const cat = q.get('category');
  if (cat === 'Jace Verified') where.push('r.verified');
  else if (cat && CATEGORIES.includes(cat)) where.push(`r.category = ${add(cat)}`);
  if (q.get('verified') === 'only') where.push('r.verified');
  if (q.get('verified') === 'none') where.push('NOT r.verified');
  if (q.get('ai') === 'none') where.push('NOT r.ai_assisted');
  if (q.get('ai') === 'only') where.push('r.ai_assisted');
  // "Hide my allergies": the usual allergens by the saved list, custom ones by the ingredients text (hides a bit more rather than less).
  if (q.get('hideMine') === '1' && user) {
    for (const a of user.allergies || []) where.push(`NOT (COALESCE(r.allergens, '[]'::jsonb) @> jsonb_build_array(${add(a)}::text))`);
    for (const t of user.custom_allergies || []) where.push(`r.ingredients::text NOT ILIKE ${add(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/(ies|es|s|y)$/, '')}%`)}`);
  }
  const maxTime = parseInt(q.get('maxTime'), 10);
  if (maxTime > 0) where.push(`r.prep_time > 0 AND r.prep_time <= ${add(maxTime)}`);
  for (const a of String(q.get('free') || '').split(',').map((x) => x.trim()).filter((x) => ALLERGENS.includes(x))) {
    where.push(`NOT (COALESCE(r.allergens, '[]'::jsonb) @> jsonb_build_array(${add(a)}::text))`);
  }
  const text = str(q.get('q'), 100);
  if (text) {
    const p = add(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(r.title ILIKE ${p} OR r.description ILIKE ${p} OR r.ingredients::text ILIKE ${p} OR u.display_name ILIKE ${p} OR u.username ILIKE ${p})`);
  }
  // Jace Verified recipes always come first, whatever the sort.
  const order = {
    quick: 'ORDER BY r.verified DESC, (r.prep_time = 0), r.prep_time ASC, r.created_at DESC',
    az: 'ORDER BY r.verified DESC, lower(r.title) ASC',
    top: 'ORDER BY r.verified DESC, rating_avg DESC NULLS LAST, rating_count DESC, r.created_at DESC',
  }[q.get('sort')] || sortSql;
  const limit = Math.max(1, Math.min(48, parseInt(q.get('limit'), 10) || 24));
  const offset = Math.max(0, parseInt(q.get('offset'), 10) || 0);
  const rows = await query(`${RECIPE_SELECT} WHERE ${where.join(' AND ')} ${order} LIMIT ${limit + 1} OFFSET ${offset}`, params);
  return { recipes: rows.slice(0, limit).map((r) => recipeView(r, user)), hasMore: rows.length > limit, nextOffset: offset + limit };
});

route('GET', '/api/recipes/:id', async ({ user, params }) => {
  const row = await findRecipe(params.id);
  if (!canSee(row, user)) throw new HttpError(404, 'Recipe not found.');
  const recipe = recipeView(row, user, true);
  if (user) recipe.myRating = (await one('SELECT stars FROM ratings WHERE recipe_id = $1 AND sub = $2', [row.id, user.sub]))?.stars || null;
  return { recipe };
});

// ---- Ratings (1 to 5 stars, one per person, not on your own recipe)
route('PUT', '/api/recipes/:id/rating', async ({ user, params, body }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  if (!canSee(row, user)) throw new HttpError(404, 'Recipe not found.');
  if (row.status !== 'published' || row.visibility === 'private') throw new HttpError(400, 'You can only rate published recipes.');
  if (row.author_sub === user.sub) throw new HttpError(400, 'You can’t rate your own recipe.');
  const stars = parseInt(body.stars, 10);
  if (body.stars === null || stars === 0) {
    await query('DELETE FROM ratings WHERE recipe_id = $1 AND sub = $2', [row.id, user.sub]);
  } else {
    if (!(stars >= 1 && stars <= 5)) throw new HttpError(400, 'Pick 1 to 5 stars.');
    await query(`INSERT INTO ratings (recipe_id, sub, stars, created_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (recipe_id, sub) DO UPDATE SET stars = EXCLUDED.stars`, [row.id, user.sub, stars, Date.now()]);
  }
  const recipe = recipeView(await findRecipe(row.id), user, true);
  recipe.myRating = stars >= 1 ? stars : null;
  return { recipe };
});

// ---- Comments (auto moderated; links and unkind words wait for @okjace)
const COMMENT_SELECT = `SELECT c.*, ${USER_COLS} FROM comments c JOIN users u ON u.sub = c.sub`;
function commentView(row, viewer) {
  const author = { sub: row.u_sub, username: row.u_username, display_name: row.u_display_name, avatar_url: row.u_avatar_url, bio: row.u_bio, role: row.u_role, created_at: row.u_created_at };
  const out = { id: row.id, recipeId: row.recipe_id, body: row.body, status: row.status, createdAt: Number(row.created_at), author: publicUser(author), mine: Boolean(viewer && viewer.sub === row.sub) };
  if (viewer && (viewer.sub === row.sub || isAdmin(viewer))) out.modReasons = row.mod_reasons || [];
  return out;
}

route('GET', '/api/recipes/:id/comments', async ({ user, params }) => {
  const row = await findRecipe(params.id);
  if (!canSee(row, user)) throw new HttpError(404, 'Recipe not found.');
  const rows = await query(`${COMMENT_SELECT} WHERE c.recipe_id = $1 AND NOT u.banned AND NOT u.jace_banned AND (c.status = 'published' OR c.sub = $2 OR $3) ORDER BY c.created_at ASC LIMIT 500`,
    [row.id, user?.sub || '', isAdmin(user)]);
  return { comments: rows.map((c) => commentView(c, user)) };
});

route('POST', '/api/recipes/:id/comments', async ({ user, params, body }) => {
  requireUser(user);
  if (user.jace_muted) throw new HttpError(403, 'Your Jace account is muted, so you can’t comment right now.');
  const row = await findRecipe(params.id);
  if (!canSee(row, user)) throw new HttpError(404, 'Recipe not found.');
  if ((row.status !== 'published' || row.visibility === 'private') && !isAdmin(user)) throw new HttpError(400, 'You can only comment on published recipes.');
  const text = str(body.body, 1000);
  if (text.length < 2) throw new HttpError(400, 'Write a comment first.');
  const recent = await one('SELECT COUNT(*)::int AS n FROM comments WHERE sub = $1 AND created_at > $2', [user.sub, Date.now() - 3600_000]);
  if (recent.n >= 30 && !isAdmin(user)) throw new HttpError(429, 'That’s a lot of comments! Try again in a bit.');
  const mod = moderateComment(text, await jaceBlockedTerms());
  if (mod.decision === 'block') throw new HttpError(422, 'Auto-moderation stopped this comment.', { reasons: mod.reasons });
  const id = randomUUID();
  const status = mod.decision === 'review' && !isAdmin(user) ? 'pending' : 'published';
  await query('INSERT INTO comments (id, recipe_id, sub, body, status, mod_reasons, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, row.id, user.sub, text, status, JSON.stringify(mod.decision === 'review' ? mod.reasons : []), Date.now()]);
  if (status === 'pending') emailAdminReview('A comment', `${text}`, recipePath(row.id));
  else if (row.author_sub !== user.sub) emailNewComment(row, user, text);
  return { status: 201, body: { comment: commentView(await one(`${COMMENT_SELECT} WHERE c.id = $1`, [id]), user) } };
});

route('DELETE', '/api/comments/:id', async ({ user, params }) => {
  requireUser(user);
  const c = await one('SELECT c.*, r.author_sub AS recipe_author FROM comments c JOIN recipes r ON r.id = c.recipe_id WHERE c.id = $1', [params.id]);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (c.sub !== user.sub && !isAdmin(user)) throw new HttpError(403, 'You can only delete your own comments.');
  await query('DELETE FROM comments WHERE id = $1', [c.id]);
  return { ok: true };
});

function emailNewComment(recipe, commenter, text) {
  for (const sub of teamOf(recipe)) notify(sub, { type: 'comment', recipeId: recipe.id, actorSub: commenter.sub, data: { text: quote(text, 200) } });
  getUser(recipe.author_sub).then((author) => sendEmail(author, 'comments', {
    subject: `New comment on “${quote(recipe.title, 80)}”`,
    heading: `${quote(commenter.display_name, 40)} commented on your recipe`,
    message: `“${quote(text, 600)}”\n\n— ${commenter.display_name} (@${commenter.username}) on ${recipe.title}`,
    buttonLabel: 'See the comment', path: `${recipePath(recipe.id)}`,
  })).catch(() => {});
}

route('POST', '/api/comments/:id/approve', async ({ user, params }) => {
  requireAdmin(user);
  const c = await one('SELECT * FROM comments WHERE id = $1', [params.id]);
  await query("UPDATE comments SET status = 'published', mod_reasons = '[]' WHERE id = $1", [params.id]);
  if (c && c.status === 'pending') {
    const [recipe, commenter] = await Promise.all([one('SELECT * FROM recipes WHERE id = $1', [c.recipe_id]), getUser(c.sub)]);
    if (recipe && commenter && recipe.author_sub !== commenter.sub) emailNewComment(recipe, commenter, c.body);
  }
  return { ok: true };
});

route('POST', '/api/recipes', async ({ user, body }) => {
  requireUser(user);
  if (user.jace_muted) throw new HttpError(403, 'Your Jace account is muted, so you can’t post right now.');
  const recent = await one('SELECT COUNT(*)::int AS n FROM recipes WHERE author_sub = $1 AND created_at > $2', [user.sub, Date.now() - 3600_000]);
  if (recent.n >= 10 && !isAdmin(user)) throw new HttpError(429, 'That’s a lot of recipes! Try again in an hour.');
  let r = parseRecipe(body);
  // Auto spelling and grammar fixes (on unless the author turns them off), then auto moderation on the fixed text.
  let fixed = { fixes: 0, by: null };
  if (body.autoFix !== false) {
    fixed = await polishRecipe(r);
    r = { ...r, ...fixed.recipe };
  }
  const mod = await runModeration(r, user, { bypass: body.bypassModeration === true });
  const id = randomUUID();
  const image = await storeImage(body.image || null, null, user.sub, 700 * 1024);
  const now = Date.now();
  await query(`INSERT INTO recipes (id, author_sub, title, description, category, prep_time, servings, ingredients, steps, image_url, verified, status, safety_notes, mod_reasons, created_at, updated_at, ai_assisted, allergens, visibility)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18)`,
  [id, user.sub, r.title, r.description, r.category, r.prepTime, r.servings, JSON.stringify(r.ingredients), JSON.stringify(r.steps), image,
    Boolean(body.verified) && canVerify(user), mod.status, JSON.stringify(mod.safetyNotes), JSON.stringify(mod.modReasons), now, Boolean(body.aiAssisted), JSON.stringify(mod.allergens), r.visibility]);
  if (mod.status === 'pending') emailAdminReview('A new recipe', r.title, recipePath(id));
  return { status: 201, body: { recipe: recipeView(await findRecipe(id), user, true), fixes: fixed.fixes, fixedBy: fixed.by } };
});

route('PUT', '/api/recipes/:id', async ({ user, params, body }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  const mine = row.author_sub === user.sub;
  if (!canEdit(row, user)) throw new HttpError(403, 'You can only edit your own recipes, or ones you’re making with someone.');
  if (row.status === 'removed' && !isAdmin(user)) throw new HttpError(403, `This recipe was taken down by @${ADMIN} and can’t be edited.`);
  if (user.jace_muted && !isAdmin(user)) throw new HttpError(403, 'Your Jace account is muted, so you can’t edit right now.');
  let r = parseRecipe(body);
  // Auto spelling and grammar fixes (on unless the author turns them off), then auto moderation on the fixed text.
  let fixed = { fixes: 0, by: null };
  if (body.autoFix !== false) {
    fixed = await polishRecipe(r);
    r = { ...r, ...fixed.recipe };
  }
  if (!mine && !isAdmin(user)) r.visibility = row.visibility || 'public'; // only the owner decides who can see it
  const mod = await runModeration(r, user, { recipeId: row.id, bypass: body.bypassModeration === true });
  let verified = row.verified;
  // Verifiers manage the badge on their own recipes; @okjace on any recipe.
  if (body.verified !== undefined && canVerify(user) && (isAdmin(user) || mine)) verified = Boolean(body.verified);
  const status = row.status === 'removed' ? 'removed' : mod.status;
  const image = await storeImage(body.image, row.image_url, row.author_sub, 700 * 1024);
  await query(`UPDATE recipes SET title=$2, description=$3, category=$4, prep_time=$5, servings=$6, ingredients=$7, steps=$8, image_url=$9, verified=$10, status=$11, safety_notes=$12, mod_reasons=$13, updated_at=$14, allergens=$15, visibility=$16 WHERE id=$1`,
    [row.id, r.title, r.description, r.category, r.prepTime, r.servings, JSON.stringify(r.ingredients), JSON.stringify(r.steps), image, verified, status, JSON.stringify(mod.safetyNotes), JSON.stringify(mod.modReasons), Date.now(), JSON.stringify(mod.allergens), r.visibility]);
  if (status === 'pending' && row.status !== 'pending') emailAdminReview('An edited recipe', r.title, recipePath(row.id));
  return { recipe: recipeView(await findRecipe(row.id), user, true), fixes: fixed.fixes, fixedBy: fixed.by };
});

route('DELETE', '/api/recipes/:id', async ({ user, params }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  if (row.author_sub !== user.sub && !isAdmin(user)) throw new HttpError(403, 'You can only delete your own recipes.');
  await query('DELETE FROM recipes WHERE id = $1', [row.id]);
  await dropImage(row.image_url);
  return { ok: true };
});

// ---- Make a recipe with AI: returns a draft (not saved). Publishing it goes through auto moderation again.
const AI_DAILY_LIMIT = Math.max(1, parseInt(process.env.AI_DAILY_LIMIT, 10) || 20);
route('POST', '/api/ai/recipe', async ({ user, body }) => {
  requireUser(user);
  if (user.jace_muted) throw new HttpError(403, 'Your Jace account is muted, so you can’t use the AI right now.');
  const prompt = str(body.prompt, 500);
  if (prompt.length < 3) throw new HttpError(400, 'Tell the AI what you’d like to make.');
  const category = CATEGORIES.includes(body.category) ? body.category : null;
  const terms = await jaceBlockedTerms();
  // Check the request itself first, so unsafe asks never reach the AI.
  const ask = moderateRecipe({ title: prompt, description: '', ingredients: ['-'], steps: ['-'], category: category || 'Dinner' }, terms);
  if (ask.decision === 'block') throw new HttpError(422, 'The AI can’t help with that request.', { reasons: ask.reasons });
  const day = new Date().toISOString().slice(0, 10);
  const usage = await one(`INSERT INTO ai_usage (sub, day, count) VALUES ($1, $2, 1)
    ON CONFLICT (sub, day) DO UPDATE SET count = ai_usage.count + 1 RETURNING count`, [user.sub, day]);
  if (usage.count > AI_DAILY_LIMIT && !isAdmin(user)) {
    await query('UPDATE ai_usage SET count = count - 1 WHERE sub = $1 AND day = $2', [user.sub, day]);
    throw new HttpError(429, `You’ve used the AI ${AI_DAILY_LIMIT} times today. Try again tomorrow.`);
  }
  let draft;
  try {
    draft = parseRecipe(await generateRecipe({ prompt, category, categories: CATEGORIES }));
  } catch (e) {
    await query('UPDATE ai_usage SET count = count - 1 WHERE sub = $1 AND day = $2', [user.sub, day]); // failed tries don't count
    throw e.status ? new HttpError(e.status, e.message, e.extra) : e;
  }
  // The AI's answer goes through the same auto moderation as any recipe.
  const mod = moderateRecipe(draft, terms);
  if (mod.decision === 'block') throw new HttpError(422, 'The AI came up with something that didn’t pass our safety checks. Try asking a different way.', { reasons: mod.reasons });
  return { draft: { ...draft, safetyNotes: mod.safetyNotes, needsReview: mod.decision === 'review' ? mod.reasons : [] }, left: Math.max(0, AI_DAILY_LIMIT - usage.count) };
});

route('GET', '/api/images/:id', async ({ params }) => {
  const img = await one('SELECT mime, data FROM images WHERE id = $1', [params.id]);
  if (!img) throw new HttpError(404, 'Picture not found.');
  return { raw: Buffer.from(img.data, 'base64'), type: img.mime, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } };
});

// ---- @okjace admin powers
route('POST', '/api/recipes/:id/verify', async ({ user, params, body }) => {
  requireAdmin(user);
  const before = await findRecipe(params.id);
  await query('UPDATE recipes SET verified = $2 WHERE id = $1', [params.id, Boolean(body.verified)]);
  if (body.verified && !before.verified) for (const sub of teamOf(before)) notify(sub, { type: 'verified', recipeId: before.id, actorSub: user.sub });
  if (body.verified && !before.verified && before.author_sub !== user.sub) {
    getUser(before.author_sub).then((a) => sendEmail(a, 'recipe_updates', {
      subject: `Your recipe is now Jace Verified!`,
      heading: '✓ Your recipe is Jace Verified',
      message: `Great news: @${ADMIN} gave “${quote(before.title, 100)}” the Jace Verified badge. It now shows at the top of Jace Recipes for other parents to find.`,
      buttonLabel: 'See your recipe', path: recipePath(before.id),
    })).catch(() => {});
  }
  return { recipe: recipeView(await findRecipe(params.id), user, true) };
});

route('POST', '/api/recipes/:id/takedown', async ({ user, params, body }) => {
  requireAdmin(user);
  const before = await findRecipe(params.id);
  const reason = str(body.reason, 300) || `Removed by @${ADMIN}.`;
  await query("UPDATE recipes SET status = 'removed', takedown_reason = $2 WHERE id = $1", [params.id, reason]);
  if (before.status !== 'removed') for (const sub of teamOf(before)) notify(sub, { type: 'taken_down', recipeId: before.id, actorSub: user.sub, data: { reason } });
  if (before.status !== 'removed' && before.author_sub !== user.sub) {
    getUser(before.author_sub).then((a) => sendEmail(a, 'recipe_updates', {
      subject: `Your recipe “${quote(before.title, 80)}” was taken down`,
      heading: 'Your recipe was taken down',
      message: `@${ADMIN} took down “${quote(before.title, 100)}” from Jace Recipes.\n\nReason: ${quote(reason, 300)}\n\nOnly you can see it now.`,
      buttonLabel: 'See your recipe', path: recipePath(before.id),
    })).catch(() => {});
  }
  return { recipe: recipeView(await findRecipe(params.id), user, true) };
});

route('POST', '/api/recipes/:id/restore', async ({ user, params }) => {
  requireAdmin(user);
  const before = await findRecipe(params.id);
  await query("UPDATE recipes SET status = 'published', takedown_reason = NULL, mod_reasons = '[]' WHERE id = $1", [params.id]);
  if (before.status !== 'published') for (const sub of teamOf(before)) notify(sub, { type: before.status === 'pending' ? 'approved' : 'restored', recipeId: before.id, actorSub: user.sub });
  if (before.status !== 'published' && before.author_sub !== user.sub) {
    const approved = before.status === 'pending';
    getUser(before.author_sub).then((a) => sendEmail(a, 'recipe_updates', {
      subject: approved ? `Your recipe “${quote(before.title, 80)}” is live` : `Your recipe “${quote(before.title, 80)}” is back`,
      heading: approved ? 'Your recipe was approved' : 'Your recipe was restored',
      message: approved
        ? `@${ADMIN} checked “${quote(before.title, 100)}” and it’s now live on Jace Recipes for other parents to see.`
        : `@${ADMIN} put “${quote(before.title, 100)}” back on Jace Recipes.`,
      buttonLabel: 'See your recipe', path: recipePath(before.id),
    })).catch(() => {});
  }
  return { recipe: recipeView(await findRecipe(params.id), user, true) };
});

route('GET', '/api/admin/overview', async ({ user }) => {
  requireAdmin(user);
  const pendingComments = await query(`${COMMENT_SELECT} WHERE c.status = 'pending' ORDER BY c.created_at ASC LIMIT 200`);
  const blocked = await query(`SELECT b.*, u.username, u.display_name, u.avatar_url FROM blocked_attempts b JOIN users u ON u.sub = b.author_sub
    WHERE b.status = 'blocked' ORDER BY b.created_at DESC LIMIT 200`);
  const [pending, removed, verified, users] = await Promise.all([
    query(`${RECIPE_SELECT} WHERE r.status = 'pending' ${sortSql}`),
    query(`${RECIPE_SELECT} WHERE r.status = 'removed' ${sortSql}`),
    query(`${RECIPE_SELECT} WHERE r.verified ${sortSql}`),
    query('SELECT u.*, (SELECT COUNT(*)::int FROM recipes r WHERE r.author_sub = u.sub) AS recipe_count FROM users u ORDER BY u.created_at DESC LIMIT 500'),
  ]);
  return {
    pending: pending.map((r) => recipeView(r, user)),
    removed: removed.map((r) => recipeView(r, user)),
    verified: verified.map((r) => recipeView(r, user)),
    users: users.map((u) => ({ ...publicUser(u), banned: u.banned, jaceBanned: u.jace_banned, recipeCount: u.recipe_count })),
    pendingComments: pendingComments.map((c) => commentView(c, user)),
    blocked: blocked.map((b) => ({ id: b.id, recipeId: b.recipe_id, recipe: b.data, reasons: b.reasons, createdAt: Number(b.created_at),
      author: { username: b.username, displayName: b.display_name, avatar: b.avatar_url } })),
  };
});

route('POST', '/api/admin/users/:username', async ({ user, params, body }) => {
  requireAdmin(user);
  const u = await one('SELECT * FROM users WHERE lower(username) = lower($1) ORDER BY last_seen_at DESC LIMIT 1', [params.username.replace(/^@/, '')]);
  if (!u) throw new HttpError(404, `@${params.username} hasn’t signed in to Jace Recipes yet. Ask them to sign in with Jace once, then try again.`);
  if (isAdmin(u)) throw new HttpError(400, `@${ADMIN} is always the admin.`);
  const role = body.role === undefined ? u.role : (body.role === 'verifier' ? 'verifier' : 'user');
  const banned = body.banned === undefined ? u.banned : Boolean(body.banned);
  const updated = await one('UPDATE users SET role = $2, banned = $3 WHERE sub = $1 RETURNING *', [u.sub, role, banned]);
  if (role === 'verifier' && u.role !== 'verifier') {
    notify(updated.sub, { type: 'role', actorSub: user.sub });
    sendEmail(updated, 'role', {
      subject: 'You can now post Jace Verified recipes',
      heading: '✓ You’re a Jace Verified poster',
      message: `@${ADMIN} made you a verified poster on Jace Recipes. When you share a recipe, you can tick “Post as a Jace Verified recipe” and it gets the badge and shows at the top.`,
      buttonLabel: 'Share a recipe', path: '#/new',
    });
  }
  return { user: { ...publicUser(updated), banned: updated.banned } };
});

// ---- Blocked recipes: @okjace can publish them anyway, or dismiss them
route('POST', '/api/admin/blocked/:id', async ({ user, params, body }) => {
  requireAdmin(user);
  const b = await one("SELECT * FROM blocked_attempts WHERE id = $1 AND status = 'blocked'", [params.id]);
  if (!b) throw new HttpError(404, 'That blocked recipe was already handled.');
  if (body.action === 'dismiss') {
    await query("UPDATE blocked_attempts SET status = 'dismissed' WHERE id = $1", [b.id]);
    return { ok: true };
  }
  if (body.action !== 'publish') throw new HttpError(400, 'Choose publish or dismiss.');
  const r = { ...b.data };
  const mod = moderateRecipe(r, await jaceBlockedTerms());
  const reasons = JSON.stringify([`Published by @${ADMIN} despite auto moderation: ${(b.reasons || []).join(' ')}`]);
  let id = b.recipe_id;
  const existing = id ? await one('SELECT id FROM recipes WHERE id = $1', [id]) : null;
  if (existing) {
    await query(`UPDATE recipes SET title=$2, description=$3, category=$4, prep_time=$5, servings=$6, ingredients=$7, steps=$8, status='published', safety_notes=$9, mod_reasons=$10, updated_at=$11, allergens=$12, visibility=$13 WHERE id=$1`,
      [id, r.title, r.description || '', r.category, r.prepTime || 0, r.servings || 1, JSON.stringify(r.ingredients), JSON.stringify(r.steps), JSON.stringify(mod.safetyNotes), reasons, Date.now(), JSON.stringify(mod.allergens), r.visibility || 'public']);
  } else {
    id = randomUUID();
    await query(`INSERT INTO recipes (id, author_sub, title, description, category, prep_time, servings, ingredients, steps, status, safety_notes, mod_reasons, created_at, updated_at, allergens, visibility)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$11,$12,$12,$13,$14)`,
    [id, b.author_sub, r.title, r.description || '', r.category, r.prepTime || 0, r.servings || 1, JSON.stringify(r.ingredients), JSON.stringify(r.steps), JSON.stringify(mod.safetyNotes), reasons, Date.now(), JSON.stringify(mod.allergens), r.visibility || 'public']);
  }
  await query("UPDATE blocked_attempts SET status = 'published', recipe_id = $2 WHERE id = $1", [b.id, id]);
  notify(b.author_sub, { type: 'approved', recipeId: id, actorSub: user.sub });
  return { recipe: recipeView(await findRecipe(id), user, true) };
});

// ---- Making recipes together: the owner invites people by Jace username
route('POST', '/api/recipes/:id/collaborators', async ({ user, params, body }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  if (!canSee(row, user)) throw new HttpError(404, 'Recipe not found.');
  if (row.author_sub !== user.sub && !isAdmin(user)) throw new HttpError(403, 'Only the recipe’s owner can invite people.');
  const name = str(body.username, 40).replace(/^@/, '');
  if (!name) throw new HttpError(400, 'Type a Jace username.');
  const invitee = await one('SELECT * FROM users WHERE lower(username) = lower($1) ORDER BY last_seen_at DESC LIMIT 1', [name]);
  if (!invitee || invitee.banned || invitee.jace_banned) throw new HttpError(404, `@${name} isn’t on Jace Recipes yet. Ask them to sign in with Jace once, then invite them.`);
  if (invitee.sub === row.author_sub) throw new HttpError(400, 'That’s the recipe’s owner.');
  if ((row.collabs || []).length >= 20) throw new HttpError(400, 'A recipe can have up to 20 people.');
  const existing = (row.collabs || []).find((c) => c.sub === invitee.sub);
  if (existing) throw new HttpError(409, existing.status === 'accepted' ? `@${invitee.username} is already making this with you.` : `@${invitee.username} already has an invite.`);
  await query("INSERT INTO collaborators (recipe_id, sub, status, invited_by, created_at) VALUES ($1, $2, 'invited', $3, $4)", [row.id, invitee.sub, user.sub, Date.now()]);
  await notify(invitee.sub, { type: 'invite', recipeId: row.id, actorSub: user.sub, data: { title: quote(row.title, 120) } });
  sendEmail(invitee, 'invites', {
    subject: `${quote(user.display_name, 40)} invited you to make “${quote(row.title, 80)}”`,
    heading: 'You’re invited to make a recipe together',
    message: `${user.display_name} (@${user.username}) invited you to work on “${quote(row.title, 120)}” on Jace Recipes. Once you accept, you can edit it together.`,
    buttonLabel: 'See the invite', path: '#/inbox',
  });
  return { recipe: recipeView(await findRecipe(row.id), user, true) };
});

// Owner removes someone, or a co-author leaves (DELETE …/collaborators/<their username>).
route('DELETE', '/api/recipes/:id/collaborators/:username', async ({ user, params }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  const c = (row.collabs || []).find((x) => x.username.toLowerCase() === params.username.toLowerCase());
  if (!c) throw new HttpError(404, 'They aren’t on this recipe.');
  if (c.sub !== user.sub && row.author_sub !== user.sub && !isAdmin(user)) throw new HttpError(403, 'Only the recipe’s owner can remove people.');
  await query('DELETE FROM collaborators WHERE recipe_id = $1 AND sub = $2', [row.id, c.sub]);
  await clearInvite(c.sub, row.id);
  return { ok: true };
});

// The invited person accepts or declines.
route('POST', '/api/recipes/:id/invite', async ({ user, params, body }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  if (!collabOf(row, user, ['invited'])) throw new HttpError(404, 'That invite isn’t open anymore.');
  if (body.action === 'accept') {
    await query("UPDATE collaborators SET status = 'accepted' WHERE recipe_id = $1 AND sub = $2", [row.id, user.sub]);
    notify(row.author_sub, { type: 'invite_accepted', recipeId: row.id, actorSub: user.sub });
  } else {
    await query('DELETE FROM collaborators WHERE recipe_id = $1 AND sub = $2', [row.id, user.sub]);
  }
  await clearInvite(user.sub, row.id);
  return { recipe: body.action === 'accept' ? recipeView(await findRecipe(row.id), user, true) : null };
});

// ---- Notifications (🔔)
route('GET', '/api/inbox', async ({ user, query: q }) => {
  requireUser(user);
  const unread = await unreadCount(user.sub);
  if (q.get('count')) return { unread };
  return { items: await inbox(user.sub), unread };
});

route('PATCH', '/api/inbox', async ({ user, body }) => {
  requireUser(user);
  if (body.all) await query('UPDATE notifications SET read_at = $2 WHERE user_sub = $1 AND read_at IS NULL', [user.sub, Date.now()]);
  if (body.delete) await query('DELETE FROM notifications WHERE user_sub = $1 AND id = $2', [user.sub, str(body.delete, 64)]);
  return { items: await inbox(user.sub), unread: await unreadCount(user.sub) };
});

// ---------------------------------------------------------------- http glue
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body; // Vercel parsed it
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 3 * 1024 * 1024) throw new HttpError(413, 'That upload is too big.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON.'); }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    const match = routes.map((r) => ({ r, m: r.method === req.method && r.re.exec(url.pathname) })).find((x) => x.m);
    if (!match) return sendJson(res, 404, { error: 'Not found.' });
    // JSON-only writes: plain cross-site forms can't send application/json.
    if (req.method !== 'GET' && !/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
    const params = {};
    match.r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match.m[i + 1]); });
    const body = req.method === 'GET' ? {} : await readBody(req);
    const sub = sessionSub(req);
    const user = sub ? await one('SELECT * FROM users WHERE sub = $1', [sub]) : null;
    const out = await match.r.handler({ req, user, body, params, query: url.searchParams });
    if (out && out.redirect) {
      res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...(out.headers || {}) });
      return res.end();
    }
    if (out && out.raw) {
      res.writeHead(200, { 'Content-Type': out.type, ...SECURITY_HEADERS, ...(out.headers || {}) });
      return res.end(out.raw);
    }
    if (out && out.body !== undefined && (out.status || out.headers)) return sendJson(res, out.status || 200, out.body, out.headers);
    return sendJson(res, 200, out);
  } catch (err) {
    if (!err.status) console.error(err);
    return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.', ...(err.extra || {}) });
  }
}
