'use strict';
// Jace Recipes front end. Everything user-written is inserted as text, never HTML.

const state = { me: null, categories: [], admin: 'okjace' };
const app = document.getElementById('app');
const nav = document.getElementById('nav');
const VERIFIED = 'Jace Verified';
const EMOJI = { Breakfast: '🥞', Lunch: '🥪', Dinner: '🍲', Lunchbox: '🍱', Snacks: '🍎', Desserts: '🧁', Drinks: '🥤', 'Baby & Toddler': '🍼', Holidays: '🎄' };

// ------------------------------------------------------------ helpers
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used for our own static SVG icons
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const svgCheck = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5l2.6 2 3.3-.3.9 3.2 2.8 1.8-1.2 3.1 1.2 3.1-2.8 1.8-.9 3.2-3.3-.3-2.6 2-2.6-2-3.3.3-.9-3.2L2.4 14.4l1.2-3.1L2.4 8.2l2.8-1.8.9-3.2 3.3.3z"/><path d="M10.6 15.6l-3.2-3.2 1.4-1.4 1.8 1.8 4.6-4.6 1.4 1.4z" fill="#fff"/></svg>';
const verifiedBadge = () => h('span', { class: 'badge-verified', title: 'A verified Jace recipe', html: svgCheck + '<span>Jace Verified</span>' });
const userCheck = (u) => (u.role === 'admin' || u.role === 'verifier') ? h('span', { class: 'user-check', title: u.role === 'admin' ? 'Jace Recipes founder' : 'Can post verified Jace recipes', html: svgCheck }) : null;

function avatar(u, size = '') {
  if (u.avatar) return h('img', { class: `avatar ${size}`, src: u.avatar, alt: '' });
  return h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' }, (u.displayName || u.username || '?').trim().charAt(0).toUpperCase());
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.data = data; e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function errorBox(err) {
  const reasons = err.data && err.data.reasons;
  return h('div', { class: 'notice error', role: 'alert' }, h('strong', {}, err.message), reasons && reasons.length ? h('ul', {}, reasons.map((r) => h('li', {}, r))) : null);
}
const go = (hash) => { location.hash = hash; };
const timeAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  for (const [n, u] of [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return '';
};
const isAdmin = () => state.me && state.me.role === 'admin';
const canVerify = () => state.me && (state.me.role === 'admin' || state.me.role === 'verifier');

// Shrink uploaded pictures in the browser so they stay small.
function pickImage(maxSide, quality = 0.85) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    input.onchange = () => {
      const file = input.files[0]; if (!file) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { toast('That file is not a picture.'); resolve(null); };
      img.src = URL.createObjectURL(file);
    };
    input.click();
  });
}

// ------------------------------------------------------------ nav
// Light / dark mode. Follows the device until the person picks one.
const THEME_KEY = 'jr-theme';
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function themeButton() {
  const dark = currentTheme() === 'dark';
  return h('button', {
    class: 'icon-btn', type: 'button', title: dark ? 'Switch to light mode' : 'Switch to dark mode', 'aria-label': dark ? 'Switch to light mode' : 'Switch to dark mode',
    html: dark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    onclick: () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      renderNav();
    },
  });
}

function renderNav() {
  nav.replaceChildren(themeButton());
  if (state.me) {
    nav.append(
      h('a', { class: 'btn primary small', href: '#/new' }, '+ Add recipe'),
      isAdmin() ? h('a', { class: 'link hide-sm', href: '#/admin' }, 'Admin') : null,
      h('a', { class: 'me', href: `#/u/${state.me.username}`, title: 'Your profile' }, avatar(state.me), h('span', { class: 'name' }, state.me.displayName)),
    );
  } else {
    nav.append(signInButton(null, 'small'));
  }
}

// ------------------------------------------------------------ cards
function recipeCard(r) {
  return h('a', { class: `card${r.verified ? ' is-verified' : ''}`, href: `#/r/${r.id}` },
    h('div', { class: 'card-img' }, r.image ? h('img', { src: r.image, alt: '', loading: 'lazy' }) : EMOJI[r.category] || '🍽️'),
    h('div', { class: 'card-body' },
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
        r.verified ? verifiedBadge() : null,
        h('span', { class: 'tag' }, r.category),
        r.status !== 'published' ? h('span', { class: `status-pill ${r.status}` }, r.status === 'pending' ? 'In review' : 'Taken down') : null),
      h('h3', { class: 'card-title' }, r.title),
      r.description ? h('div', { class: 'muted', style: 'font-size:.92rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' }, r.description) : null,
      h('div', { class: 'card-meta' }, avatar(r.author), h('span', {}, r.author.displayName), userCheck(r.author), r.prepTime ? h('span', { style: 'margin-left:auto' }, `⏱ ${r.prepTime} min`) : null)));
}
const grid = (list, emptyText) => list.length ? h('div', { class: 'grid' }, list.map(recipeCard)) : h('div', { class: 'empty' }, emptyText);

// ------------------------------------------------------------ pages
async function pageHome(params) {
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const search = h('input', { type: 'search', placeholder: 'Search recipes, ingredients or parents…', value: q, 'aria-label': 'Search recipes' });
  const submit = (e) => { e.preventDefault(); const p = new URLSearchParams(); if (search.value.trim()) p.set('q', search.value.trim()); if (category) p.set('category', category); go(`#/?${p}`); };
  const chip = (name, label, extra = '') => h('button', {
    class: `chip ${extra}${category === name ? ' on' : ''}`,
    onclick: () => { const p = new URLSearchParams(); if (q) p.set('q', q); if (name) p.set('category', name); go(`#/?${p}`); },
  }, label);

  app.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', {}, 'Recipes from real parents'),
      h('p', { class: 'muted' }, 'Weeknight dinners, lunchbox ideas and baby food that families actually make. Look for the ', h('b', { style: 'color:var(--gold)' }, 'Jace Verified'), ' badge for tried-and-true picks.'),
      h('form', { class: 'search', onsubmit: submit }, search, h('button', { class: 'btn primary' }, 'Search')),
      h('div', { class: 'chips' }, chip('', 'All'), chip(VERIFIED, '✓ Jace Verified', 'verified-chip'), state.categories.map((c) => chip(c, `${EMOJI[c] || ''} ${c}`)))),
    h('div', { id: 'results' }, h('div', { class: 'empty' }, 'Loading recipes…')));

  const p = new URLSearchParams(); if (q) p.set('q', q); if (category) p.set('category', category);
  const { recipes } = await api('GET', `/api/recipes?${p}`);
  const results = document.getElementById('results');
  const verified = recipes.filter((r) => r.verified);
  const rest = recipes.filter((r) => !r.verified);

  if (category === VERIFIED || q || category) {
    results.replaceChildren(
      h('h2', { class: 'section-title' }, category === VERIFIED ? [verifiedBadge(), ' recipes'] : (category || `Results for “${q}”`)),
      grid(recipes, 'No recipes here yet. Be the first to add one!'));
    return;
  }
  results.replaceChildren(
    ...(verified.length ? [h('h2', { class: 'section-title' }, verifiedBadge(), 'Jace Verified recipes'), grid(verified, '')] : []),
    h('h2', { class: 'section-title' }, 'From the community'),
    grid(rest, state.me ? 'No community recipes yet. Share your family favorite!' : 'No community recipes yet. Join and share your family favorite!'));
}

async function pageRecipe(id) {
  const { recipe: r } = await api('GET', `/api/recipes/${encodeURIComponent(id)}`);
  const mine = state.me && state.me.username === r.author.username;
  const notices = [];
  if (r.status === 'pending') notices.push(h('div', { class: 'notice warn' }, h('strong', {}, 'Waiting for review. '), 'Auto-moderation sent this recipe to @okjace before it goes public.', r.modReasons && r.modReasons.length ? h('ul', {}, r.modReasons.map((x) => h('li', {}, x))) : null));
  if (r.status === 'removed') notices.push(h('div', { class: 'notice error' }, h('strong', {}, 'Taken down by @okjace. '), r.takedownReason || ''));

  const adminBar = isAdmin() ? h('div', { class: 'admin-bar' },
    h('strong', {}, 'Admin'),
    h('button', { class: 'btn gold small', onclick: async () => { await api('POST', `/api/recipes/${r.id}/verify`, { verified: !r.verified }); toast(r.verified ? 'Removed from Jace Verified' : 'Added to Jace Verified'); route(); } }, r.verified ? 'Remove verified badge' : '✓ Make Jace Verified'),
    r.status === 'published'
      ? h('button', { class: 'btn danger small', onclick: () => takedown(r.id) }, 'Take down')
      : h('button', { class: 'btn small', onclick: async () => { await api('POST', `/api/recipes/${r.id}/restore`, {}); toast(r.status === 'pending' ? 'Approved and published' : 'Recipe restored'); route(); } }, r.status === 'pending' ? 'Approve & publish' : 'Restore')) : null;

  app.replaceChildren(h('article', { class: 'recipe' },
    h('div', {},
      h('div', { class: 'recipe-hero' }, r.image ? h('img', { src: r.image, alt: r.title }) : EMOJI[r.category] || '🍽️'),
      r.safetyNotes.length ? h('div', { class: 'safety' }, h('h3', {}, '🛡️ Safety notes'), h('ul', {}, r.safetyNotes.map((n) => h('li', {}, n))), h('div', { class: 'muted', style: 'font-size:.8rem;margin-top:6px' }, 'Added automatically by Jace Recipes auto-moderation.')) : null),
    h('div', {},
      notices,
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, r.verified ? verifiedBadge() : null, h('a', { class: 'tag', href: `#/?category=${encodeURIComponent(r.category)}`, style: 'text-decoration:none' }, r.category)),
      h('h1', {}, r.title),
      h('a', { class: 'byline', href: `#/u/${r.author.username}` }, avatar(r.author, 'md'), h('div', {}, h('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:800' }, r.author.displayName, userCheck(r.author)), h('div', { class: 'muted', style: 'font-size:.88rem' }, `@${r.author.username} · ${timeAgo(r.createdAt)}`))),
      r.description ? h('p', {}, r.description) : null,
      h('div', { class: 'facts' }, r.prepTime ? h('span', { class: 'tag' }, `⏱ ${r.prepTime} min`) : null, h('span', { class: 'tag' }, `🍽 Serves ${r.servings}`)),
      adminBar,
      (mine || isAdmin()) ? h('div', { class: 'actions' },
        r.status !== 'removed' || isAdmin() ? h('a', { class: 'btn small', href: `#/edit/${r.id}` }, 'Edit') : null,
        h('button', { class: 'btn danger small', onclick: async () => { if (!confirm('Delete this recipe forever?')) return; await api('DELETE', `/api/recipes/${r.id}`); toast('Recipe deleted'); go('#/'); } }, 'Delete')) : null,
      h('div', { class: 'panel' }, h('h2', {}, 'Ingredients'), h('ul', { class: 'ingredients' }, r.ingredients.map((i) => h('li', {}, h('input', { type: 'checkbox', 'aria-label': `Got ${i}` }), h('span', {}, i))))),
      h('div', { class: 'panel' }, h('h2', {}, 'Steps'), h('ol', { class: 'steps' }, r.steps.map((s) => h('li', {}, h('span', {}, s))))))));
}

async function takedown(id) {
  const reason = prompt('Why is this recipe being taken down? (The author will see this.)', 'This recipe breaks the Jace Recipes rules.');
  if (reason === null) return;
  await api('POST', `/api/recipes/${id}/takedown`, { reason });
  toast('Recipe taken down');
  route();
}

async function pageEditor(id) {
  if (!state.me) return go('#/signin');
  let r = { title: '', description: '', category: state.categories[0], prepTime: '', servings: 4, ingredients: [], steps: [], image: null, verified: false };
  if (id) r = (await api('GET', `/api/recipes/${encodeURIComponent(id)}`)).recipe;
  let image = r.image;
  const f = {
    title: h('input', { type: 'text', value: r.title, maxlength: 100, required: true, placeholder: 'Grandma’s Mac and Cheese' }),
    description: h('textarea', { maxlength: 1000, placeholder: 'What makes it a family favorite?', style: 'min-height:80px' }, r.description),
    category: h('select', {}, state.categories.map((c) => h('option', { value: c, selected: c === r.category }, c))),
    prepTime: h('input', { type: 'number', min: 0, max: 1440, value: r.prepTime || '', placeholder: '30' }),
    servings: h('input', { type: 'number', min: 1, max: 100, value: r.servings }),
    ingredients: h('textarea', { placeholder: '2 cups flour\n1 egg\n1 cup milk' }, r.ingredients.join('\n')),
    steps: h('textarea', { placeholder: 'Mix the dry ingredients.\nAdd the egg and milk.\nCook until golden.' }, r.steps.join('\n')),
    verified: h('input', { type: 'checkbox', checked: r.verified }),
  };
  const preview = h('div', { class: 'photo-preview' });
  const drawPreview = () => preview.replaceChildren(image ? h('img', { src: image, alt: '' }) : 'No photo');
  drawPreview();
  const msg = h('div');
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, id ? 'Save changes' : 'Publish recipe');

  const onsubmit = async (e) => {
    e.preventDefault(); msg.replaceChildren(); saveBtn.disabled = true;
    const body = { title: f.title.value, description: f.description.value, category: f.category.value, prepTime: f.prepTime.value, servings: f.servings.value, ingredients: f.ingredients.value, steps: f.steps.value, image };
    if (canVerify()) body.verified = f.verified.checked;
    try {
      const { recipe } = await api(id ? 'PUT' : 'POST', id ? `/api/recipes/${id}` : '/api/recipes', body);
      toast(recipe.status === 'pending' ? 'Sent to review before it goes public' : 'Recipe published!');
      go(`#/r/${recipe.id}`);
    } catch (err) { msg.replaceChildren(errorBox(err)); msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); } finally { saveBtn.disabled = false; }
  };

  app.replaceChildren(h('div', { class: 'form-page' },
    h('h1', {}, id ? 'Edit recipe' : 'Share a recipe'),
    h('p', { class: 'muted' }, 'Every recipe is checked by auto-moderation to keep Jace Recipes safe for families.'),
    state.me.muted ? h('div', { class: 'notice warn' }, 'Your Jace account is muted, so you can’t post or edit recipes right now.') : null,
    h('form', { class: 'panel', onsubmit },
      h('label', {}, 'Title'), f.title,
      h('label', {}, 'Short description'), f.description,
      h('div', { class: 'row' },
        h('div', {}, h('label', {}, 'Category'), f.category),
        h('div', {}, h('label', {}, 'Time (minutes)'), f.prepTime),
        h('div', {}, h('label', {}, 'Serves'), f.servings)),
      h('label', {}, 'Ingredients ', h('span', { class: 'hint' }, '(one per line)')), f.ingredients,
      h('label', {}, 'Steps ', h('span', { class: 'hint' }, '(one per line)')), f.steps,
      h('label', {}, 'Photo'),
      h('div', { class: 'photo-pick' }, preview,
        h('button', { class: 'btn small', type: 'button', onclick: async () => { const d = await pickImage(1000, 0.8); if (d) { image = d; drawPreview(); } } }, 'Choose photo'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { image = null; drawPreview(); } }, 'Remove')),
      canVerify() ? h('label', { class: 'check' }, f.verified, verifiedBadge(), 'Post as a Jace Verified recipe') : null,
      msg,
      h('div', { class: 'actions', style: 'margin-top:20px' }, saveBtn, h('a', { class: 'btn', href: id ? `#/r/${id}` : '#/' }, 'Cancel')))));
}

async function pageProfile(username) {
  const { user: u, recipes } = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  const mine = state.me && state.me.username === u.username;
  app.replaceChildren(
    h('div', { class: 'profile-head' }, avatar(u, 'lg'),
      h('div', { style: 'flex:1;min-width:200px' },
        h('h1', {}, u.displayName, userCheck(u)),
        h('div', { class: 'muted', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, `@${u.username}`,
          u.role === 'admin' ? h('span', { class: 'role-pill' }, 'Founder') : u.role === 'verifier' ? h('span', { class: 'role-pill' }, 'Verified poster') : null,
          h('span', {}, `· ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`)),
        u.bio ? h('p', { style: 'margin:8px 0 0' }, u.bio) : null),
      mine ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/settings' }, 'Edit profile'), h('button', { class: 'btn', onclick: logout }, 'Sign out')) : null),
    h('h2', { class: 'section-title' }, mine ? 'Your recipes' : 'Recipes'),
    grid(recipes, mine ? 'You haven’t shared any recipes yet.' : 'No recipes yet.'));
}

async function pageSettings() {
  if (!state.me) return go('#/signin');
  const me = state.me;
  let avatarData = me.avatar;
  const preview = h('span');
  const removeBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { avatarData = null; draw(); } }, 'Remove');
  const draw = () => { preview.replaceChildren(avatar({ ...me, avatar: avatarData }, 'lg')); removeBtn.classList.toggle('hidden', !avatarData); };
  draw();
  const name = h('input', { type: 'text', value: me.displayName, maxlength: 40, required: true });
  const bio = h('textarea', { maxlength: 300, style: 'min-height:80px', placeholder: 'Mom of 3, loves quick dinners…' }, me.bio || '');
  const msg = h('div');

  app.replaceChildren(h('div', { class: 'form-page' },
    h('h1', {}, 'Your Jace Recipes profile'),
    h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault(); msg.replaceChildren();
      try {
        state.me = (await api('PATCH', '/api/me', { displayName: name.value, bio: bio.value, avatar: avatarData })).user;
        renderNav(); toast('Profile saved'); go(`#/u/${me.username}`);
      } catch (err) { msg.replaceChildren(errorBox(err)); }
    } },
      h('label', {}, 'Jace username'),
      h('div', { class: 'jace-id' }, jaceLogo(20), h('strong', {}, `@${me.username}`)),
      h('div', { class: 'hint', style: 'margin-top:6px' }, 'Your username comes from your Jace account. Your picture and display name here are just for Jace Recipes.'),
      h('label', {}, 'Profile picture'),
      h('div', { class: 'photo-pick' }, preview,
        h('button', { class: 'btn small', type: 'button', onclick: async () => { const d = await pickImage(256, 0.85); if (d) { avatarData = d; draw(); } } }, 'Upload picture'),
        removeBtn),
      h('label', {}, 'Display name'), name,
      h('label', {}, 'Bio'), bio,
      msg,
      h('div', { class: 'actions', style: 'margin-top:20px' }, h('button', { class: 'btn primary' }, 'Save'), h('a', { class: 'btn', href: `#/u/${me.username}` }, 'Cancel')))));
}

const jaceLogo = (size = 22) => h('img', { src: '/jace.svg', width: size, height: size, alt: '' });
const signInHref = (next) => `/api/auth/signin?next=${encodeURIComponent(next || `/${location.hash || ''}`)}`;
const signInButton = (next, cls = '') => h('a', { class: `btn jace-btn ${cls}`, href: signInHref(next) }, jaceLogo(20), 'Sign in with Jace');

function pageSignIn(params) {
  if (state.me) return go('#/');
  const reason = params.get('reason');
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'panel', style: 'text-align:center' },
    h('img', { src: '/icon.svg', width: 56, height: 56, alt: '', style: 'margin:0 auto 14px' }),
    h('h1', { style: 'font-size:1.7rem' }, 'Welcome to Jace Recipes'),
    h('p', { class: 'muted' }, 'Sign in with your Jace account to share recipes, save your profile and help other parents.'),
    reason ? h('div', { class: 'notice error', role: 'alert' }, reason) : null,
    signInButton('/', 'wide'),
    h('p', { class: 'muted', style: 'font-size:.88rem;margin:16px 0 0' }, 'No Jace account yet? You can make one on the Jace sign-in page.'))));
}

async function pageAdmin(tab = 'queue') {
  if (!isAdmin()) return go('#/');
  const data = await api('GET', '/api/admin/overview');
  const tabs = [['queue', `Review queue (${data.pending.length})`], ['verified', `Verified recipes (${data.verified.length})`], ['people', 'People & verifiers'], ['removed', `Taken down (${data.removed.length})`]];
  const reload = () => pageAdmin(tab);

  const recipeRow = (r, buttons) => h('div', { class: 'item' },
    h('div', { class: 'grow' },
      h('a', { class: 'title', href: `#/r/${r.id}` }, r.title), ' ', r.verified ? verifiedBadge() : null,
      h('div', { class: 'muted', style: 'font-size:.88rem' }, `by @${r.author.username} · ${r.category} · ${timeAgo(r.createdAt)}`),
      r.modReasons && r.modReasons.length ? h('div', { style: 'font-size:.88rem;margin-top:4px' }, '⚠️ ', r.modReasons.join(' ')) : null,
      r.takedownReason ? h('div', { style: 'font-size:.88rem;margin-top:4px;color:var(--danger)' }, r.takedownReason) : null),
    buttons);
  const act = (label, cls, fn) => h('button', { class: `btn small ${cls}`, onclick: async () => { try { await fn(); reload(); } catch (e) { toast(e.message); } } }, label);

  let body;
  if (tab === 'queue') {
    body = data.pending.length ? data.pending.map((r) => recipeRow(r, [
      act('Approve', 'primary', () => api('POST', `/api/recipes/${r.id}/restore`, {})),
      h('button', { class: 'btn small danger', onclick: async () => { await takedown(r.id); } }, 'Take down')])) : h('div', { class: 'empty' }, 'Nothing waiting. Auto-moderation is keeping things tidy. 🎉');
  } else if (tab === 'verified') {
    body = [h('p', { class: 'muted' }, 'Open any recipe and press “Make Jace Verified” to add it here.'),
      data.verified.length ? data.verified.map((r) => recipeRow(r, [act('Remove badge', 'gold', () => api('POST', `/api/recipes/${r.id}/verify`, { verified: false }))])) : h('div', { class: 'empty' }, 'No verified recipes yet.')];
  } else if (tab === 'removed') {
    body = data.removed.length ? data.removed.map((r) => recipeRow(r, [act('Restore', '', () => api('POST', `/api/recipes/${r.id}/restore`, {}))])) : h('div', { class: 'empty' }, 'No recipes have been taken down.');
  } else {
    const input = h('input', { type: 'text', placeholder: 'Jace username to make a verifier' });
    body = [
      h('p', { class: 'muted' }, 'Verifiers can post recipes with the Jace Verified badge.'),
      h('form', { class: 'add-row', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', `/api/admin/users/${encodeURIComponent(input.value.trim().replace(/^@/, '').toLowerCase())}`, { role: 'verifier' }); toast('Verifier added'); reload(); } catch (err) { toast(err.message); } } },
        input, h('button', { class: 'btn primary' }, 'Add verifier')),
      data.users.map((u) => h('div', { class: 'item' },
        avatar(u, 'md'),
        h('div', { class: 'grow' }, h('a', { class: 'title', href: `#/u/${u.username}` }, u.displayName), ' ', userCheck(u),
          h('div', { class: 'muted', style: 'font-size:.88rem' }, `@${u.username} · ${u.recipeCount} recipes${u.banned ? ' · suspended' : ''}`)),
        u.role === 'admin' ? h('span', { class: 'role-pill' }, 'Founder') : [
          u.role === 'verifier'
            ? act('Remove verifier', 'gold', () => api('POST', `/api/admin/users/${u.username}`, { role: 'user' }))
            : act('Make verifier', 'gold', () => api('POST', `/api/admin/users/${u.username}`, { role: 'verifier' })),
          act(u.banned ? 'Unsuspend' : 'Suspend', 'danger', () => api('POST', `/api/admin/users/${u.username}`, { banned: !u.banned })),
        ])),
    ];
  }

  app.replaceChildren(
    h('div', { style: 'padding-top:28px' }, h('h1', {}, 'Admin'), h('p', { class: 'muted' }, 'Only @okjace can see this page.')),
    h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('a', { class: `chip${k === tab ? ' on' : ''}`, href: `#/admin/${k}`, style: 'text-decoration:none' }, label))),
    h('div', { class: 'list' }, body));
}

async function logout() {
  await api('POST', '/api/auth/signout', {});
  state.me = null; renderNav(); toast('Signed out'); go('#/');
}

// ------------------------------------------------------------ router
async function route() {
  const [pathPart, queryPart] = (location.hash.slice(1) || '/').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart || '');
  window.scrollTo(0, 0);
  try {
    switch (parts[0]) {
      case undefined: await pageHome(params); break;
      case 'r': await pageRecipe(parts[1]); break;
      case 'new': await pageEditor(); break;
      case 'edit': await pageEditor(parts[1]); break;
      case 'u': await pageProfile(parts[1]); break;
      case 'settings': await pageSettings(); break;
      case 'signin': case 'login': case 'register': pageSignIn(params); break;
      case 'signin-error': pageSignIn(params); break;
      case 'admin': await pageAdmin(parts[1]); break;
      default: app.replaceChildren(h('div', { class: 'empty' }, 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
    }
  } catch (err) {
    app.replaceChildren(h('div', { class: 'form-page' }, errorBox(err), h('a', { class: 'btn', href: '#/' }, 'Back to recipes')));
  }
}

(async function start() {
  const [meta, me] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/me')]);
  state.categories = meta.categories; state.admin = meta.admin; state.me = me.user;
  renderNav();
  window.addEventListener('hashchange', route);
  route();
})();
