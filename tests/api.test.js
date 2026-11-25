// End-to-end API test: starts the mock Jace and the app (with a throwaway
// local Postgres), signs in through the real OAuth redirects and checks the
// permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = 'http://localhost:3917';
const JACE = 'http://localhost:4917';
const dir = mkdtempSync(path.join(tmpdir(), 'jace-recipes-test-'));
const procs = [];

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  const env = { ...process.env, JACE_URL: JACE, JACE_CLIENT_ID: 'test', JACE_CLIENT_SECRET: 'test', SESSION_SECRET: 'x'.repeat(40), PGLITE_DIR: path.join(dir, 'db'), APP_URL: APP, DATABASE_URL: '', MOCK_AI_URL: `${JACE}/v1`, OPENROUTER_API_KEY: '' };
  procs.push(spawn(process.execPath, ['scripts/mock-jace.js'], { env: { ...env, PORT: '4917' }, stdio: 'ignore' }));
  procs.push(spawn(process.execPath, ['server.js'], { env: { ...env, PORT: '3917' }, stdio: 'inherit' }));
  await waitFor(`${JACE}/x`);
  await waitFor(`${APP}/api/meta`);
});
after(() => { procs.forEach((p) => p.kill()); rmSync(dir, { recursive: true, force: true }); });

/** Signs in through /api/auth/signin → mock Jace → /api/auth/callback and returns the cookie. */
async function signIn(as) {
  const start = await fetch(`${APP}/api/auth/signin?next=/%23/new`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = start.headers.get('set-cookie').split(';')[0];
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.origin, JACE);
  authorize.searchParams.set('as', as);
  const jace = await fetch(authorize, { redirect: 'manual' });
  const back = await fetch(jace.headers.get('location'), { redirect: 'manual', headers: { cookie: state } });
  assert.equal(back.status, 302);
  const session = back.headers.getSetCookie().find((c) => c.startsWith('jr_session=') && !c.includes('Max-Age=0'));
  return { location: back.headers.get('location'), cookie: session ? session.split(';')[0] : null };
}

function client(cookie) {
  return async (method, url, body) => {
    const res = await fetch(`${APP}${url}`, { method, headers: { cookie: cookie || '', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
}

let admin, mom, dad;

test('sign in with Jace (the only way in)', async () => {
  const a = await signIn('okjace');
  assert.equal(a.location, '/#/new');
  admin = client(a.cookie);
  mom = client((await signIn('momchef')).cookie);
  dad = client((await signIn('dadcooks')).cookie);
  assert.equal((await admin('GET', '/api/me')).data.user.role, 'admin');
  assert.equal((await mom('GET', '/api/me')).data.user.username, 'momchef');
  assert.equal((await client(null)('POST', '/api/register', {})).status, 404); // no password accounts
});

test('banned Jace accounts cannot sign in', async () => {
  const b = await signIn('bannedbob');
  assert.equal(b.cookie, null);
  assert.match(b.location, /signin-error/);
});

test('state is checked', async () => {
  const res = await fetch(`${APP}/api/auth/callback?code=x&state=forged`, { redirect: 'manual' });
  assert.match(res.headers.get('location'), /signin-error/);
});

test('verified recipes are seeded and listed first', async () => {
  const { data } = await client(null)('GET', '/api/recipes');
  assert.ok(data.recipes.length >= 4);
  assert.ok(data.recipes[0].verified);
});

test('display name and picture change, username does not', async () => {
  const pic = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const r = await mom('PATCH', '/api/me', { displayName: 'Super Mom', avatar: pic });
  assert.equal(r.data.user.displayName, 'Super Mom');
  assert.match(r.data.user.avatar, /^\/api\/images\//);
  const img = await fetch(`${APP}${r.data.user.avatar}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await mom('PATCH', '/api/me', { username: 'other' })).status, 400);
  assert.equal((await mom('PATCH', '/api/me', { displayName: 'sh1t cook' })).status, 400);
  // Signing in again keeps the Jace Recipes display name.
  mom = client((await signIn('momchef')).cookie);
  assert.equal((await mom('GET', '/api/me')).data.user.displayName, 'Super Mom');
});

let momRecipe;
test('auto moderation blocks, holds and publishes', async () => {
  const bad = await mom('POST', '/api/recipes', { title: 'Fun drink', ingredients: '1 cup bleach', steps: 'mix' });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.reasons.length);
  assert.equal((await mom('POST', '/api/recipes', { title: 'Words', ingredients: 'rice', steps: 'mockbadword' })).status, 422);
  const held = await mom('POST', '/api/recipes', { title: 'Pretzels', ingredients: 'food grade lye\nflour', steps: 'bake' });
  assert.equal(held.data.recipe.status, 'pending');
  assert.equal((await client(null)('GET', `/api/recipes/${held.data.recipe.id}`)).status, 404);
  const ok = await mom('POST', '/api/recipes', { title: 'Honey chicken', ingredients: '1 lb chicken\n2 tbsp honey', steps: 'cook', verified: true });
  assert.equal(ok.data.recipe.status, 'published');
  assert.equal(ok.data.recipe.verified, false); // not a verifier yet
  assert.ok(ok.data.recipe.safetyNotes.length >= 2);
  momRecipe = ok.data.recipe.id;
  const queue = await admin('GET', '/api/admin/overview');
  assert.equal(queue.data.pending.length, 1);
  assert.equal((await admin('POST', `/api/recipes/${held.data.recipe.id}/restore`, {})).data.recipe.status, 'published');
});

test('only @okjace verifies, takes down and manages verifiers', async () => {
  assert.equal((await mom('POST', `/api/recipes/${momRecipe}/verify`, { verified: true })).status, 403);
  assert.equal((await mom('POST', `/api/recipes/${momRecipe}/takedown`, {})).status, 403);
  assert.equal((await mom('POST', '/api/admin/users/dadcooks', { role: 'verifier' })).status, 403);
  assert.equal((await admin('POST', `/api/recipes/${momRecipe}/verify`, { verified: true })).data.recipe.verified, true);
  assert.equal((await admin('POST', '/api/admin/users/nobodyyet', { role: 'verifier' })).status, 404);
  assert.equal((await admin('POST', '/api/admin/users/dadcooks', { role: 'verifier' })).data.user.role, 'verifier');
  const v = await dad('POST', '/api/recipes', { title: 'Easy salad', ingredients: 'lettuce', steps: 'toss', verified: true });
  assert.equal(v.data.recipe.verified, true);
  const down = await admin('POST', `/api/recipes/${momRecipe}/takedown`, { reason: 'Test' });
  assert.equal(down.data.recipe.status, 'removed');
  assert.equal((await client(null)('GET', `/api/recipes/${momRecipe}`)).status, 404);
  assert.equal((await mom('GET', `/api/recipes/${momRecipe}`)).data.recipe.takedownReason, 'Test');
  assert.equal((await mom('PUT', `/api/recipes/${momRecipe}`, { title: 'Again', ingredients: 'x', steps: 'y' })).status, 403);
  const verifiedList = await client(null)('GET', '/api/recipes?category=Jace%20Verified');
  assert.ok(verifiedList.data.recipes.every((r) => r.verified));
});

test('muted Jace accounts cannot post', async () => {
  const muted = client((await signIn('mutedmom')).cookie);
  assert.equal((await muted('POST', '/api/recipes', { title: 'Soup', ingredients: 'water', steps: 'boil' })).status, 403);
});

test('writes need JSON (blocks cross-site form posts)', async () => {
  const res = await fetch(`${APP}/api/recipes`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(res.status, 415);
});

test('authors can delete their own recipes, others cannot', async () => {
  const made = await mom('POST', '/api/recipes', { title: 'Delete me', ingredients: 'rice', steps: 'cook' });
  const id = made.data.recipe.id;
  assert.equal((await dad('DELETE', `/api/recipes/${id}`, {})).status, 403);
  assert.equal((await mom('DELETE', `/api/recipes/${id}`, {})).status, 200);
  assert.equal((await mom('GET', `/api/recipes/${id}`)).status, 404);
});

test('filters, sorting and load more', async () => {
  const anon = client(null);
  for (let i = 0; i < 3; i++) await dad('POST', '/api/recipes', { title: `Milk toast ${i}`, ingredients: '1 cup milk\nbread', steps: 'toast', prepTime: 5 + i });
  const community = await anon('GET', '/api/recipes?verified=none');
  assert.ok(community.data.recipes.length > 0 && community.data.recipes.every((r) => !r.verified));
  const verified = await anon('GET', '/api/recipes?verified=only');
  assert.ok(verified.data.recipes.every((r) => r.verified));
  const dairyFree = await anon('GET', '/api/recipes?free=milk');
  assert.ok(dairyFree.data.recipes.length > 0);
  assert.ok(dairyFree.data.recipes.every((r) => !r.allergens.includes('milk')));
  const quick = await anon('GET', '/api/recipes?maxTime=6&verified=none');
  assert.ok(quick.data.recipes.every((r) => r.prepTime > 0 && r.prepTime <= 6));
  const page1 = await anon('GET', '/api/recipes?limit=2');
  assert.equal(page1.data.recipes.length, 2);
  assert.equal(page1.data.hasMore, true);
  const page2 = await anon('GET', `/api/recipes?limit=2&offset=${page1.data.nextOffset}`);
  assert.notEqual(page2.data.recipes[0].id, page1.data.recipes[0].id);
  const az = await anon('GET', '/api/recipes?sort=az&verified=none');
  const titles = az.data.recipes.map((r) => r.title.toLowerCase());
  assert.deepEqual(titles, [...titles].sort());
});

test('AI recipe maker makes a moderated draft', async () => {
  const ok = await mom('POST', '/api/ai/recipe', { prompt: 'chicken and rice dinner' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.draft.title, 'Cheesy Chicken Rice Bake');
  assert.ok(ok.data.draft.steps.every((s) => !/^\d/.test(s))); // numbering removed
  assert.ok(ok.data.draft.safetyNotes.some((n) => /165°F/.test(n)));
  // The AI's answer is checked too.
  const bad = await mom('POST', '/api/ai/recipe', { prompt: 'a trick drink' });
  assert.equal(bad.status, 422);
  // Off-topic asks get the AI's refusal.
  assert.equal((await mom('POST', '/api/ai/recipe', { prompt: 'do my homework' })).status, 422);
  // Unsafe asks never reach the AI.
  assert.equal((await mom('POST', '/api/ai/recipe', { prompt: 'cookies with bleach' })).status, 422);
  assert.equal((await client(null)('POST', '/api/ai/recipe', { prompt: 'soup' })).status, 401);
  const pub = await mom('POST', '/api/recipes', { ...ok.data.draft, ingredients: ok.data.draft.ingredients.join('\n'), steps: ok.data.draft.steps.join('\n'), aiAssisted: true });
  assert.equal(pub.data.recipe.aiAssisted, true);
  const aiOnly = await client(null)('GET', '/api/recipes?ai=only');
  assert.ok(aiOnly.data.recipes.length >= 1 && aiOnly.data.recipes.every((r) => r.aiAssisted));
});
