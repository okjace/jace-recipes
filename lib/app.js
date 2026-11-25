// The Jace Recipes API. One handler for every /api/* request, used by both
// the Vercel function (api/index.js) and the local dev server (server.js).
import { randomBytes, randomUUID } from 'node:crypto';
import { query, one } from './db.js';
import { moderateRecipe, moderateName } from './moderation.js';
import { authorizeUrl, exchangeCode, getUserInfo, jaceBlockedTerms } from './jace.js';
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
const RECIPE_SELECT = `SELECT r.*, ${USER_COLS} FROM recipes r JOIN users u ON u.sub = r.author_sub`;
function recipeView(row, viewer, full = false) {
  const author = { sub: row.u_sub, username: row.u_username, display_name: row.u_display_name, avatar_url: row.u_avatar_url, bio: row.u_bio, role: row.u_role, created_at: row.u_created_at };
  const out = {
    id: row.id, title: row.title, description: row.description, category: row.category, prepTime: row.prep_time,
    servings: row.servings, image: row.image_url, verified: row.verified, status: row.status, author: publicUser(author),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), safetyNotes: row.safety_notes || [],
  };
  if (full) { out.ingredients = row.ingredients; out.steps = row.steps; }
  if (viewer && (viewer.sub === row.author_sub || isAdmin(viewer))) {
    out.modReasons = row.mod_reasons || [];
    out.takedownReason = row.takedown_reason || null;
  }
  return out;
}
const canSee = (row, viewer) => row.status === 'published' || (viewer && (viewer.sub === row.author_sub || isAdmin(viewer)));

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
  };
  if (r.title.length < 3) throw new HttpError(400, 'Give your recipe a title (at least 3 letters).');
  return r;
}
async function runModeration(r, user) {
  const mod = moderateRecipe(r, await jaceBlockedTerms());
  if (mod.decision === 'block') throw new HttpError(422, 'Auto-moderation stopped this recipe.', { reasons: mod.reasons });
  return {
    safetyNotes: mod.safetyNotes,
    modReasons: mod.decision === 'review' ? mod.reasons : [],
    // @okjace's own recipes skip the review queue (never the block list).
    status: mod.decision === 'review' && !isAdmin(user) ? 'pending' : 'published',
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
    await query(`INSERT INTO recipes (id, author_sub, title, description, category, prep_time, servings, ingredients, steps, verified, status, safety_notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'published',$10,$11,$11)`,
    [randomUUID(), admin.sub, s.title, s.description, s.category, s.prepTime, s.servings, JSON.stringify(s.ingredients), JSON.stringify(s.steps), JSON.stringify(moderateRecipe(s).safetyNotes), now - i * 1000]);
  }
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/meta', () => ({ categories: CATEGORIES, admin: ADMIN }));

// ---- Sign in with Jace (the only way to sign in)
route('GET', '/api/auth/signin', ({ req, query: q }) => {
  const state = randomBytes(24).toString('base64url');
  const next = safeNext(q.get('next'));
  const url = authorizeUrl({ redirectUri: `${appOrigin(req)}/api/auth/callback`, state });
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
    RETURNING *`, [info.sub, info.username, str(info.name, 40) || info.username, info.picture, info.banned, info.muted, now]);
  if (user.banned) return fail('This Jace account is suspended from Jace Recipes.');
  if (isAdmin(user)) await seedIfEmpty(user);
  return { redirect: saved.next || '/', headers: { 'Set-Cookie': [clearState(secure), sessionCookie(user.sub, secure)] } };
});

route('POST', '/api/auth/signout', ({ req }) => ({ body: { ok: true }, headers: { 'Set-Cookie': clearSession(isSecure(req)) } }));

route('GET', '/api/me', ({ user }) => ({ user: user && !user.banned && !user.jace_banned ? { ...publicUser(user), muted: user.jace_muted } : null }));

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
  const updated = await one('UPDATE users SET display_name = $2, bio = $3, avatar_url = $4 WHERE sub = $1 RETURNING *', [user.sub, displayName, bio, avatar]);
  return { user: publicUser(updated) };
});

route('GET', '/api/users/:username', async ({ user, params }) => {
  const u = await one('SELECT * FROM users WHERE lower(username) = lower($1) ORDER BY last_seen_at DESC LIMIT 1', [params.username]);
  if (!u || u.banned || u.jace_banned) throw new HttpError(404, 'No one on Jace Recipes has that Jace username.');
  const rows = await query(`${RECIPE_SELECT} WHERE r.author_sub = $1 ${sortSql}`, [u.sub]);
  return { user: publicUser(u), recipes: rows.filter((r) => canSee(r, user)).map((r) => recipeView(r, user)) };
});

route('GET', '/api/recipes', async ({ user, query: q }) => {
  const where = ["r.status = 'published'", 'NOT u.banned', 'NOT u.jace_banned'];
  const params = [];
  const cat = q.get('category');
  if (cat === 'Jace Verified') where.push('r.verified');
  else if (cat && CATEGORIES.includes(cat)) { params.push(cat); where.push(`r.category = $${params.length}`); }
  const text = str(q.get('q'), 100);
  if (text) {
    params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(r.title ILIKE $${params.length} OR r.description ILIKE $${params.length} OR r.ingredients::text ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.username ILIKE $${params.length})`);
  }
  const rows = await query(`${RECIPE_SELECT} WHERE ${where.join(' AND ')} ${sortSql} LIMIT 200`, params);
  return { recipes: rows.map((r) => recipeView(r, user)) };
});

route('GET', '/api/recipes/:id', async ({ user, params }) => {
  const row = await findRecipe(params.id);
  if (!canSee(row, user)) throw new HttpError(404, 'Recipe not found.');
  return { recipe: recipeView(row, user, true) };
});

route('POST', '/api/recipes', async ({ user, body }) => {
  requireUser(user);
  if (user.jace_muted) throw new HttpError(403, 'Your Jace account is muted, so you can’t post right now.');
  const recent = await one('SELECT COUNT(*)::int AS n FROM recipes WHERE author_sub = $1 AND created_at > $2', [user.sub, Date.now() - 3600_000]);
  if (recent.n >= 10 && !isAdmin(user)) throw new HttpError(429, 'That’s a lot of recipes! Try again in an hour.');
  const r = parseRecipe(body);
  const mod = await runModeration(r, user);
  const id = randomUUID();
  const image = await storeImage(body.image || null, null, user.sub, 700 * 1024);
  const now = Date.now();
  await query(`INSERT INTO recipes (id, author_sub, title, description, category, prep_time, servings, ingredients, steps, image_url, verified, status, safety_notes, mod_reasons, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
  [id, user.sub, r.title, r.description, r.category, r.prepTime, r.servings, JSON.stringify(r.ingredients), JSON.stringify(r.steps), image,
    Boolean(body.verified) && canVerify(user), mod.status, JSON.stringify(mod.safetyNotes), JSON.stringify(mod.modReasons), now]);
  return { status: 201, body: { recipe: recipeView(await findRecipe(id), user, true) } };
});

route('PUT', '/api/recipes/:id', async ({ user, params, body }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  const mine = row.author_sub === user.sub;
  if (!mine && !isAdmin(user)) throw new HttpError(403, 'You can only edit your own recipes.');
  if (row.status === 'removed' && !isAdmin(user)) throw new HttpError(403, `This recipe was taken down by @${ADMIN} and can’t be edited.`);
  if (user.jace_muted && !isAdmin(user)) throw new HttpError(403, 'Your Jace account is muted, so you can’t edit right now.');
  const r = parseRecipe(body);
  const mod = await runModeration(r, user);
  let verified = row.verified;
  // Verifiers manage the badge on their own recipes; @okjace on any recipe.
  if (body.verified !== undefined && canVerify(user) && (isAdmin(user) || mine)) verified = Boolean(body.verified);
  const status = row.status === 'removed' ? 'removed' : mod.status;
  const image = await storeImage(body.image, row.image_url, row.author_sub, 700 * 1024);
  await query(`UPDATE recipes SET title=$2, description=$3, category=$4, prep_time=$5, servings=$6, ingredients=$7, steps=$8, image_url=$9, verified=$10, status=$11, safety_notes=$12, mod_reasons=$13, updated_at=$14 WHERE id=$1`,
    [row.id, r.title, r.description, r.category, r.prepTime, r.servings, JSON.stringify(r.ingredients), JSON.stringify(r.steps), image, verified, status, JSON.stringify(mod.safetyNotes), JSON.stringify(mod.modReasons), Date.now()]);
  return { recipe: recipeView(await findRecipe(row.id), user, true) };
});

route('DELETE', '/api/recipes/:id', async ({ user, params }) => {
  requireUser(user);
  const row = await findRecipe(params.id);
  if (row.author_sub !== user.sub && !isAdmin(user)) throw new HttpError(403, 'You can only delete your own recipes.');
  await query('DELETE FROM recipes WHERE id = $1', [row.id]);
  await dropImage(row.image_url);
  return { ok: true };
});

route('GET', '/api/images/:id', async ({ params }) => {
  const img = await one('SELECT mime, data FROM images WHERE id = $1', [params.id]);
  if (!img) throw new HttpError(404, 'Picture not found.');
  return { raw: Buffer.from(img.data, 'base64'), type: img.mime, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } };
});

// ---- @okjace admin powers
route('POST', '/api/recipes/:id/verify', async ({ user, params, body }) => {
  requireAdmin(user);
  await findRecipe(params.id);
  await query('UPDATE recipes SET verified = $2 WHERE id = $1', [params.id, Boolean(body.verified)]);
  return { recipe: recipeView(await findRecipe(params.id), user, true) };
});

route('POST', '/api/recipes/:id/takedown', async ({ user, params, body }) => {
  requireAdmin(user);
  await findRecipe(params.id);
  await query("UPDATE recipes SET status = 'removed', takedown_reason = $2 WHERE id = $1", [params.id, str(body.reason, 300) || `Removed by @${ADMIN}.`]);
  return { recipe: recipeView(await findRecipe(params.id), user, true) };
});

route('POST', '/api/recipes/:id/restore', async ({ user, params }) => {
  requireAdmin(user);
  await findRecipe(params.id);
  await query("UPDATE recipes SET status = 'published', takedown_reason = NULL, mod_reasons = '[]' WHERE id = $1", [params.id]);
  return { recipe: recipeView(await findRecipe(params.id), user, true) };
});

route('GET', '/api/admin/overview', async ({ user }) => {
  requireAdmin(user);
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
  return { user: { ...publicUser(updated), banned: updated.banned } };
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
