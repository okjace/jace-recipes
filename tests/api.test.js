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
  const ok = await mom('POST', '/api/recipes', { title: 'Honey chicken', ingredients: '1 lb chicken\n2 tbsp honey', steps: 'Heat the pan over medium heat, then cook everything for ten minutes, stirring often.', verified: true });
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
  const v = await dad('POST', '/api/recipes', { title: 'Easy salad', ingredients: 'lettuce\ncucumber', steps: 'Chop the lettuce and cucumber, then toss them together in a big bowl.', verified: true });
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
  const made = await mom('POST', '/api/recipes', { title: 'Delete me please', ingredients: 'rice\nwater', steps: 'Heat the pan over medium heat, then cook everything for ten minutes, stirring often.' });
  const id = made.data.recipe.id;
  assert.equal((await dad('DELETE', `/api/recipes/${id}`, {})).status, 403);
  assert.equal((await mom('DELETE', `/api/recipes/${id}`, {})).status, 200);
  assert.equal((await mom('GET', `/api/recipes/${id}`)).status, 404);
});

test('filters, sorting and load more', async () => {
  const anon = client(null);
  for (let i = 0; i < 3; i++) await dad('POST', '/api/recipes', { title: `Milk toast ${i}`, ingredients: '1 cup milk\nbread', steps: 'Toast the bread, warm the milk, then pour the milk over the toast.', prepTime: 5 + i });
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

test('spelling and grammar are fixed when publishing (unless turned off)', async () => {
  const r = await mom('POST', '/api/recipes', { title: 'choclate banana bites', ingredients: '2 bananas\n1/2 cup choclate chips', steps: 'slice teh bananas into coins and dip each one in melted chocolate.\nchill them in the fridge for 20 minutes untill firm' });
  assert.equal(r.status, 201);
  assert.equal(r.data.recipe.title, 'Chocolate Banana Bites'); // mock AI does Title Case
  assert.equal(r.data.recipe.ingredients[1], '1/2 cup chocolate chips');
  assert.equal(r.data.recipe.steps[1], 'Chill them in the fridge for 20 minutes until firm.');
  assert.ok(r.data.fixes >= 3);
  const off = await mom('POST', '/api/recipes', { title: 'choclate dip for apples', ingredients: '1 cup choclate', steps: 'Melt the chocolate gently, then dip apple slices into it.', autoFix: false });
  assert.equal(off.data.recipe.title, 'choclate dip for apples');
});

test('ratings and comments', async () => {
  const r = (await mom('POST', '/api/recipes', { title: 'Apple Oat Crumble', ingredients: '4 apples\n1 cup oats\n3 tbsp butter', steps: 'Slice the apples into a dish and top with oats mixed with butter.\nBake at 350°F for 30 minutes until golden.' })).data.recipe;
  assert.equal((await mom('PUT', `/api/recipes/${r.id}/rating`, { stars: 5 })).status, 400); // not your own
  assert.equal((await dad('PUT', `/api/recipes/${r.id}/rating`, { stars: 9 })).status, 400);
  await dad('PUT', `/api/recipes/${r.id}/rating`, { stars: 4 });
  const rated = await admin('PUT', `/api/recipes/${r.id}/rating`, { stars: 5 });
  assert.equal(rated.data.recipe.rating, 4.5);
  assert.equal(rated.data.recipe.ratingCount, 2);
  assert.equal((await dad('GET', `/api/recipes/${r.id}`)).data.recipe.myRating, 4);
  const top = await client(null)('GET', '/api/recipes?sort=top&verified=none');
  assert.equal(top.data.recipes[0].id, r.id);

  const ok = await dad('POST', `/api/recipes/${r.id}/comments`, { body: 'Made this tonight, the kids loved it!' });
  assert.equal(ok.data.comment.status, 'published');
  assert.equal((await dad('POST', `/api/recipes/${r.id}/comments`, { body: 'this is sh1t' })).status, 422);
  const held = await dad('POST', `/api/recipes/${r.id}/comments`, { body: 'more at www.example.com' });
  assert.equal(held.data.comment.status, 'pending');
  const publicList = await client(null)('GET', `/api/recipes/${r.id}/comments`);
  assert.equal(publicList.data.comments.length, 1);
  assert.equal((await admin('GET', '/api/admin/overview')).data.pendingComments.length, 1);
  await admin('POST', `/api/comments/${held.data.comment.id}/approve`, {});
  assert.equal((await client(null)('GET', `/api/recipes/${r.id}/comments`)).data.comments.length, 2);
  assert.equal((await mom('DELETE', `/api/comments/${ok.data.comment.id}`, {})).status, 403);
  assert.equal((await dad('DELETE', `/api/comments/${ok.data.comment.id}`, {})).status, 200);
  assert.equal((await client(null)('GET', '/api/recipes?verified=none&sort=top')).data.recipes[0].commentCount, 1);
});

test('allergies are saved privately', async () => {
  const me = await dad('PATCH', '/api/me', { allergies: ['milk', 'peanut', 'not-a-thing'] });
  assert.deepEqual(me.data.user.allergies, ['milk', 'peanut']);
  assert.deepEqual((await dad('GET', '/api/me')).data.user.allergies, ['milk', 'peanut']);
  assert.equal((await client(null)('GET', '/api/users/dadcooks')).data.user.allergies, undefined);
});

const inbox = async () => (await (await fetch(`${JACE}/_emails`)).json()).emails;
const settle = () => new Promise((r) => setTimeout(r, 300));

test('emails go through Jace for the right events', async () => {
  await settle();
  let mail = await inbox();
  // Welcome emails on first sign-in (not on later sign-ins).
  assert.equal(mail.filter((m) => m.to === 'u-momchef' && m.subject === 'Welcome to Jace Recipes').length, 1);
  const r = (await mom('POST', '/api/recipes', { title: 'Sunny Egg Muffins', ingredients: '6 eggs\n1 cup spinach', steps: 'Whisk the eggs with spinach and pour into a muffin tin.\nBake at 350°F for 20 minutes until set.' })).data.recipe;
  await dad('POST', `/api/recipes/${r.id}/comments`, { body: 'Great breakfast idea!' });
  await admin('POST', `/api/recipes/${r.id}/verify`, { verified: true });
  await admin('POST', `/api/recipes/${r.id}/takedown`, { reason: 'Testing takedown' });
  await admin('POST', `/api/recipes/${r.id}/restore`, {});
  const held = (await dad('POST', '/api/recipes', { title: 'Lye pretzels', ingredients: 'food grade lye\nflour', steps: 'Dip the shaped dough in the lye bath, then bake until brown.' })).data.recipe;
  assert.equal(held.status, 'pending');
  await settle();
  mail = await inbox();
  const toMom = mail.filter((m) => m.to === 'u-momchef').map((m) => m.subject);
  assert.ok(toMom.some((s) => /New comment on “Sunny Egg Muffins”/.test(s)));
  assert.ok(toMom.some((s) => /Jace Verified/.test(s)));
  assert.ok(toMom.some((s) => /was taken down/.test(s)));
  assert.ok(toMom.some((s) => /is back/.test(s)));
  assert.ok(mail.some((m) => m.to === 'u-okjace' && /Waiting for review: Lye pretzels/i.test(m.subject)));
  assert.ok(mail.every((m) => m.button_url === undefined || m.button_url.startsWith('http')));
});

test('people can turn email types off', async () => {
  const me = await mom('PATCH', '/api/me', { emailPrefs: { comments: false } });
  assert.equal(me.data.user.emailPrefs.comments, false);
  assert.equal(me.data.user.emailPrefs.recipe_updates, true);
  const r = (await mom('POST', '/api/recipes', { title: 'Quiet Pasta Salad', ingredients: '2 cups pasta\n1 cup peas', steps: 'Cook the pasta, cool it, then stir in the peas and a little olive oil.' })).data.recipe;
  const before = (await inbox()).length;
  await dad('POST', `/api/recipes/${r.id}/comments`, { body: 'Yum, will try this!' });
  await settle();
  assert.equal((await inbox()).length, before);
});

test('custom allergies warn and hide', async () => {
  const r = (await mom('POST', '/api/recipes', { title: 'Strawberry Yogurt Pops', ingredients: '1 cup strawberries\n1 cup yogurt', steps: 'Blend the strawberries with the yogurt, pour into molds and freeze overnight.' })).data.recipe;
  const me = await dad('PATCH', '/api/me', { allergies: [], customAllergies: ['Strawberry', ' kiwi ', 'x'] });
  assert.deepEqual(me.data.user.customAllergies, ['strawberry', 'kiwi']);
  const seen = await dad('GET', `/api/recipes/${r.id}`);
  assert.deepEqual(seen.data.recipe.allergyHits, ['strawberry']);
  assert.deepEqual((await mom('GET', `/api/recipes/${r.id}`)).data.recipe.allergyHits, []);
  const hidden = await dad('GET', '/api/recipes?hideMine=1&limit=48');
  assert.ok(!hidden.data.recipes.some((x) => x.id === r.id));
  assert.ok((await dad('GET', '/api/recipes?limit=48')).data.recipes.some((x) => x.id === r.id));
});

test('AI picks only free, current text models', async () => {
  const { pickFreeModels } = await import('../lib/ai.js');
  const picked = pickFreeModels([
    { id: 'google/gemma-4-31b-it:free', architecture: { output_modalities: ['text'] } },
    { id: 'openai/gpt-5:paid' },
    { id: 'liquid/lfm-3-1.7b:free' },
    { id: 'nvidia/nemotron-3.5-super-vl:free' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  ]);
  assert.deepEqual(picked, ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']);
});

test('admin recipes and edits are moderated too', async () => {
  const bad = await admin('POST', '/api/recipes', { title: 'Party Snack Mix', ingredients: '2 coconuts\n3 peanuts\npoison', steps: 'Mix everything together in a big bowl and serve at the party.' });
  assert.equal(bad.status, 422);
  const ok = (await admin('POST', '/api/recipes', { title: 'Party Snack Mix', ingredients: '2 cups pretzels\n1 cup raisins', steps: 'Mix everything together in a big bowl and serve at the party.' })).data.recipe;
  assert.equal(ok.status, 'published');
  const edited = await admin('PUT', `/api/recipes/${ok.id}`, { title: 'Etst', ingredients: '2 coconuts\n3 peanuts', steps: 'mix' });
  assert.equal(edited.data.recipe.status, 'pending'); // vague edit goes to the queue, even for @okjace
  assert.equal((await admin('PUT', `/api/recipes/${ok.id}`, { title: 'Etst', ingredients: '3 peanuts\npoison', steps: 'mix' })).status, 422);
  const page = (await admin('GET', `/api/recipes/${ok.id}`)).data.recipe;
  assert.ok(page.checks.some((c) => !c.ok));
  assert.ok(page.safetyNotes.some((n) => /choking/i.test(n)));
});

test('private and unlisted recipes', async () => {
  const gran = client((await signIn('grandma')).cookie);
  const body = (title, visibility) => ({ title, visibility, ingredients: '1 cup oats\n1 cup milk', steps: 'Warm the milk, stir in the oats and cook for five minutes until creamy.' });
  const priv = (await gran('POST', '/api/recipes', body('Secret Family Oatmeal', 'private'))).data.recipe;
  const unl = (await gran('POST', '/api/recipes', body('Link Only Oatmeal', 'unlisted'))).data.recipe;
  assert.equal(priv.visibility, 'private');
  const anon = client(null);
  assert.equal((await anon('GET', `/api/recipes/${priv.id}`)).status, 404);
  assert.equal((await dad('GET', `/api/recipes/${priv.id}`)).status, 404);
  assert.equal((await gran('GET', `/api/recipes/${priv.id}`)).status, 200);
  assert.equal((await admin('GET', `/api/recipes/${priv.id}`)).status, 200);
  assert.equal((await anon('GET', `/api/recipes/${unl.id}`)).status, 200); // with the link
  const list = (await anon('GET', '/api/recipes?limit=48&q=Oatmeal')).data.recipes.map((r) => r.id);
  assert.ok(!list.includes(priv.id) && !list.includes(unl.id));
  const profileAnon = (await anon('GET', '/api/users/grandma')).data.recipes.map((r) => r.id);
  assert.ok(!profileAnon.includes(priv.id) && !profileAnon.includes(unl.id));
  const profileMine = (await gran('GET', '/api/users/grandma')).data.recipes.map((r) => r.id);
  assert.ok(profileMine.includes(priv.id) && profileMine.includes(unl.id));
  assert.equal((await dad('POST', `/api/recipes/${priv.id}/comments`, { body: 'hi there' })).status, 404);
  assert.equal((await dad('PUT', `/api/recipes/${unl.id}/rating`, { stars: 5 })).status, 200);
  // A vague private recipe isn't held for review: nobody else can see it.
  const vague = (await gran('POST', '/api/recipes', { title: 'eat', visibility: 'private', ingredients: '2 nuts', steps: 'mix' })).data.recipe;
  assert.equal(vague.status, 'published');
  // Making it public later sends it to review.
  assert.equal((await gran('PUT', `/api/recipes/${vague.id}`, { title: 'eat', visibility: 'public', ingredients: '2 nuts', steps: 'mix' })).data.recipe.status, 'pending');
});
