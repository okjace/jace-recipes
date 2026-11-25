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
  // Every write is sent as JSON (the server refuses anything else), even when there's nothing to send.
  if (method !== 'GET' && body === undefined) body = {};
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
      state.ai ? h('a', { class: 'link hide-sm', href: '#/ai' }, '✨ AI') : null,
      h('a', { class: 'icon-btn bell', href: '#/inbox', title: 'Notifications', 'aria-label': state.unread ? `Notifications, ${state.unread} new` : 'Notifications' },
        h('span', { 'aria-hidden': 'true' }, '🔔'), state.unread ? h('span', { class: 'badge' }, state.unread > 99 ? '99+' : String(state.unread)) : null),
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
        r.aiAssisted ? h('span', { class: 'tag ai-tag', title: 'Made with AI help' }, '✨ AI') : null,
        r.visibility === 'private' ? h('span', { class: 'tag', title: 'Only you can see this' }, '🔒 Private') : r.visibility === 'unlisted' ? h('span', { class: 'tag', title: 'Anyone with the link can see this' }, '🔗 Unlisted') : null,
        myAllergyHits(r).length ? h('span', { class: 'tag allergy-tag', title: 'Contains something on your allergy list' }, `⚠️ ${myAllergyHits(r).map(allergyName).join(', ')}`) : null,
        r.status !== 'published' ? h('span', { class: `status-pill ${r.status}` }, r.status === 'pending' ? 'In review' : 'Taken down') : null),
      h('h3', { class: 'card-title' }, r.title),
      r.description ? h('div', { class: 'muted', style: 'font-size:.92rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' }, r.description) : null,
      h('div', { class: 'card-meta' }, avatar(r.author), h('span', {}, r.author.displayName), userCheck(r.author),
        h('span', { class: 'card-stats' },
          r.ratingCount ? h('span', { title: `${r.rating} out of 5 from ${r.ratingCount} rating${r.ratingCount === 1 ? '' : 's'}` }, h('span', { class: 'stars-inline' }, '★'), ` ${r.rating}`) : null,
          r.commentCount ? h('span', { title: `${r.commentCount} comment${r.commentCount === 1 ? '' : 's'}` }, `💬 ${r.commentCount}`) : null,
          r.prepTime ? h('span', {}, `⏱ ${r.prepTime} min`) : null))));
}
const ALLERGY_NAMES = { peanut: 'peanuts', 'tree nuts': 'tree nuts', milk: 'dairy', eggs: 'eggs', wheat: 'wheat', soy: 'soy', fish: 'fish', shellfish: 'shellfish', sesame: 'sesame' };
const myAllergyHits = (r) => (state.me ? r.allergyHits || [] : []);
const allergyName = (a) => ALLERGY_NAMES[a] || a;
const hasMyAllergies = () => Boolean(state.me && ((state.me.allergies || []).length || (state.me.customAllergies || []).length));
const starText = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
const grid = (list, emptyText) => list.length ? h('div', { class: 'grid' }, list.map(recipeCard)) : h('div', { class: 'empty' }, emptyText);

// ------------------------------------------------------------ pages
const PREVIEW = 6; // recipes per section on the home page
const ALLERGEN_LABELS = { peanut: 'Peanut-free', 'tree nuts': 'Tree-nut-free', milk: 'Dairy-free', eggs: 'Egg-free', wheat: 'Wheat-free', soy: 'Soy-free', fish: 'Fish-free', shellfish: 'Shellfish-free', sesame: 'Sesame-free' };
const browseHref = (params) => `#/browse?${new URLSearchParams(params)}`;

function searchForm(value = '') {
  const search = h('input', { type: 'search', placeholder: 'Search recipes, ingredients or parents…', value, 'aria-label': 'Search recipes' });
  return h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); go(browseHref(search.value.trim() ? { q: search.value.trim() } : {})); } },
    search, h('button', { class: 'btn primary' }, 'Search'));
}

function sectionHead(title, href, label) {
  return h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, title), href ? h('a', { class: 'view-all', href }, label || 'View all', ' →') : null);
}

async function pageHome() {
  app.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', {}, 'Recipes from real parents'),
      h('p', { class: 'muted' }, 'Weeknight dinners, lunchbox ideas and baby food that families actually make. Look for the ', h('b', { style: 'color:var(--gold)' }, 'Jace Verified'), ' badge for tried-and-true picks.'),
      searchForm(),
      h('div', { class: 'chips' },
        h('a', { class: 'chip verified-chip', href: browseHref({ verified: 'only' }) }, '✓ Jace Verified'),
        state.categories.map((c) => h('a', { class: 'chip', href: browseHref({ category: c }) }, `${EMOJI[c] || ''} ${c}`))),
      state.me && state.ai ? h('a', { class: 'ai-cta', href: '#/ai' }, h('span', { class: 'ai-spark', 'aria-hidden': 'true' }, '✨'), h('span', {}, h('strong', {}, 'Make a recipe with AI'), h('span', { class: 'muted' }, ' Tell it what you have and who’s eating.'))) : null),
    h('div', { id: 'results' }, h('div', { class: 'empty' }, 'Loading recipes…')));

  const [verified, community] = await Promise.all([
    api('GET', `/api/recipes?verified=only&limit=${PREVIEW}`),
    api('GET', `/api/recipes?verified=none&limit=${PREVIEW}`),
  ]);
  const results = document.getElementById('results');
  if (!results) return;
  results.replaceChildren(
    ...(verified.recipes.length ? [
      sectionHead([verifiedBadge(), ' Jace Verified recipes'], verified.hasMore ? browseHref({ verified: 'only' }) : null, 'View all verified'),
      grid(verified.recipes, '')] : []),
    sectionHead('From the community', community.hasMore ? browseHref({ verified: 'none' }) : null, 'View all community'),
    grid(community.recipes, state.me ? 'No community recipes yet. Share your family favorite!' : 'No community recipes yet. Sign in with Jace and share your family favorite!'),
    h('div', { class: 'center' }, h('a', { class: 'btn', href: '#/browse' }, 'Browse all recipes with filters')));
}

// All recipes, with filters. Every filter lives in the URL so it can be shared and survives a refresh.
async function pageBrowse(params) {
  const p = Object.fromEntries(params);
  const set = (key, value) => {
    const next = { ...p };
    if (value === '' || value == null || value === false) delete next[key]; else next[key] = value;
    go(browseHref(next));
  };
  const select = (key, label, options) => h('label', { class: 'filter' }, h('span', {}, label),
    h('select', { onchange: (e) => set(key, e.target.value) }, options.map(([v, text]) => h('option', { value: v, selected: (p[key] || '') === v }, text))));
  const free = (p.free || '').split(',').filter(Boolean);
  const toggleFree = (a) => set('free', (free.includes(a) ? free.filter((x) => x !== a) : [...free, a]).join(','));
  const activeCount = ['category', 'verified', 'maxTime', 'ai', 'free', 'q', 'hideMine'].filter((k) => p[k]).length;

  let title = 'All recipes';
  if (p.verified === 'only') title = 'Jace Verified recipes';
  else if (p.verified === 'none') title = 'Community recipes';
  if (p.category) title = `${p.category}${p.verified === 'only' ? ' · Jace Verified' : p.verified === 'none' ? ' · Community' : ''}`;
  if (p.q) title = `Results for “${p.q}”`;

  const results = h('div', { class: 'grid' });
  const status = h('div', { class: 'empty' }, 'Loading recipes…');
  const more = h('button', { class: 'btn hidden' }, 'Load more');
  let offset = 0;
  const load = async () => {
    more.disabled = true;
    const q = new URLSearchParams({ ...p, offset: String(offset), limit: '24' });
    try {
      const data = await api('GET', `/api/recipes?${q}`);
      results.append(...data.recipes.map(recipeCard));
      offset = data.nextOffset;
      more.classList.toggle('hidden', !data.hasMore);
      status.classList.toggle('hidden', results.children.length > 0);
      status.textContent = 'No recipes match these filters. Try removing one.';
    } catch (err) { status.replaceChildren(errorBox(err)); }
    more.disabled = false;
  };
  more.onclick = load;

  app.replaceChildren(
    h('div', { style: 'padding-top:24px' },
      h('a', { class: 'back', href: '#/' }, '← Home'),
      h('h1', {}, p.verified === 'only' && !p.q ? [verifiedBadge(), ' ', title.replace('Jace Verified recipes', 'recipes')] : title),
      searchForm(p.q || ''),
      h('div', { class: 'filters' },
        select('verified', 'Show', [['', 'All recipes'], ['only', 'Jace Verified only'], ['none', 'Community only']]),
        select('category', 'Category', [['', 'Any category'], ...state.categories.map((c) => [c, c])]),
        select('maxTime', 'Time', [['', 'Any time'], ['15', '15 min or less'], ['30', '30 min or less'], ['60', '1 hour or less']]),
        select('sort', 'Sort', [['', 'Newest'], ['top', 'Top rated'], ['quick', 'Quickest'], ['az', 'A to Z']]),
        select('ai', 'AI', [['', 'Any'], ['none', 'Not made with AI'], ['only', 'Made with AI help']])),
      h('div', { class: 'chips allergen-chips', role: 'group', 'aria-label': 'Allergy filters' },
        h('span', { class: 'muted', style: 'font-weight:700;align-self:center' }, 'Allergies:'),
        hasMyAllergies()
          ? h('button', { class: `chip my-allergies${p.hideMine === '1' ? ' on' : ''}`, 'aria-pressed': String(p.hideMine === '1'), onclick: () => set('hideMine', p.hideMine === '1' ? '' : '1') }, p.hideMine === '1' ? '✓ Hiding my allergies' : '⚠️ Hide my allergies')
          : state.me ? h('a', { class: 'chip', href: '#/settings' }, '+ Save my allergies') : null,
        state.allergens.map((a) => h('button', { class: `chip${free.includes(a) ? ' on' : ''}`, 'aria-pressed': String(free.includes(a)), onclick: () => toggleFree(a) }, ALLERGEN_LABELS[a] || `${a}-free`))),
      h('p', { class: 'hint' }, 'Allergy filters use the ingredients list. Always read the ingredients yourself if someone has a serious allergy.'),
      activeCount ? h('a', { class: 'btn small', href: '#/browse', style: 'margin-bottom:8px' }, 'Clear filters') : null),
    results, status, h('div', { class: 'center', style: 'padding-bottom:40px' }, more));
  await load();
}

// Make a recipe with AI. The AI writes a draft; the parent checks and edits it before publishing.
async function pageAI() {
  if (!state.me) return go('#/signin');
  const prompt = h('textarea', { maxlength: 500, required: true, style: 'min-height:110px', placeholder: 'A quick dinner with chicken, rice and broccoli that my picky 5-year-old will eat' });
  const category = h('select', {}, h('option', { value: '' }, 'Let the AI pick'), state.categories.map((c) => h('option', { value: c }, c)));
  const out = h('div');
  const go_ = h('button', { class: 'btn primary', type: 'submit' }, '✨ Make recipe');
  const ideas = ['Lunchbox ideas with no nuts', 'Soft finger food for a 1-year-old', 'Healthy after-school snack in 10 minutes', 'Dinner with what’s left: eggs, cheese, spinach, tortillas'];

  const submit = async (e) => {
    e.preventDefault();
    out.replaceChildren(h('div', { class: 'panel ai-loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Cooking up your recipe… this can take up to a minute.'));
    go_.disabled = true;
    try {
      const ask = () => api('POST', '/api/ai/recipe', { prompt: prompt.value, category: category.value });
      let result;
      try { result = await ask(); } catch (err) {
        if (err.status !== 503 || /isn’t set up/.test(err.message)) throw err;
        // Free AI models are sometimes busy: wait a moment and try once more before giving up.
        out.replaceChildren(h('div', { class: 'panel ai-loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'The AI is busy, trying another one…'));
        await new Promise((r) => setTimeout(r, 4000));
        result = await ask();
      }
      const { draft, left } = result;
      state.aiDraft = draft;
      out.replaceChildren(h('div', { class: 'panel ai-result' },
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, h('span', { class: 'tag ai-tag' }, '✨ AI draft'), h('span', { class: 'tag' }, draft.category), draft.prepTime ? h('span', { class: 'tag' }, `⏱ ${draft.prepTime} min`) : null, h('span', { class: 'tag' }, `🍽 Serves ${draft.servings}`)),
        h('h2', {}, draft.title),
        draft.description ? h('p', {}, draft.description) : null,
        draft.safetyNotes.length ? h('div', { class: 'safety' }, h('h3', {}, '🛡️ Safety notes'), h('ul', {}, draft.safetyNotes.map((n) => h('li', {}, n)))) : null,
        draft.needsReview.length ? h('div', { class: 'notice warn' }, 'If you publish this, @okjace will check it first: ', draft.needsReview.join(' ')) : null,
        h('h3', {}, 'Ingredients'), h('ul', {}, draft.ingredients.map((i) => h('li', {}, i))),
        h('h3', {}, 'Steps'), h('ol', {}, draft.steps.map((s) => h('li', {}, s))),
        h('p', { class: 'hint' }, 'AI can make mistakes. Read it over and change anything before you share it.'),
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: '#/new?from=ai' }, 'Edit & publish'),
          h('button', { class: 'btn', type: 'button', onclick: submit }, 'Try again')),
        h('p', { class: 'hint' }, `${left} AI recipe${left === 1 ? '' : 's'} left today.`)));
    } catch (err) {
      out.replaceChildren(errorBox(err));
    } finally { go_.disabled = false; }
  };

  app.replaceChildren(h('div', { class: 'form-page' },
    h('a', { class: 'back', href: '#/' }, '← Home'),
    h('h1', {}, '✨ Make a recipe with AI'),
    h('p', { class: 'muted' }, 'Say what you’d like to cook, what you have, and who’s eating. You’ll get a draft you can edit before you share it.'),
    state.me.muted ? h('div', { class: 'notice warn' }, 'Your Jace account is muted, so you can’t use the AI right now.') : null,
    h('form', { class: 'panel', onsubmit: submit },
      h('label', {}, 'What should we make?'), prompt,
      h('div', { class: 'chips', style: 'margin-top:10px' }, ideas.map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { prompt.value = t; prompt.focus(); } }, t))),
      h('label', {}, 'Category'), category,
      h('div', { class: 'actions', style: 'margin-top:18px' }, go_),
      h('p', { class: 'hint' }, 'Your request is sent to a free AI model on OpenRouter. Don’t include private information. Every AI recipe goes through Jace Recipes auto moderation.')),
    out));
}

async function pageRecipe(id) {
  const { recipe: r } = await api('GET', `/api/recipes/${encodeURIComponent(id)}`);
  const mine = state.me && state.me.username === r.author.username;
  const team = (r.collaborators || []).filter((c) => c.status === 'accepted');
  const notices = [];
  if (r.status === 'pending') notices.push(h('div', { class: 'notice warn' }, h('strong', {}, 'Waiting for review. '), 'Auto-moderation sent this recipe to @okjace before it goes public.', r.modReasons && r.modReasons.length ? h('ul', {}, r.modReasons.map((x) => h('li', {}, x))) : null));
  if (r.status === 'removed') notices.push(h('div', { class: 'notice error' }, h('strong', {}, 'Taken down by @okjace. '), r.takedownReason || ''));
  if (r.status === 'published' && r.modReasons && r.modReasons.length) {
    notices.push(h('div', { class: 'notice warn' }, h('strong', {}, '🛡️ Auto moderation flagged this. '),
      r.visibility === 'private' ? 'It’s private, so only you can see it.' : 'It was approved by @okjace.',
      h('ul', {}, r.modReasons.map((x) => h('li', {}, x)))));
  }
  const hits = myAllergyHits(r);
  if (hits.length) {
    notices.unshift(h('div', { class: 'notice allergy', role: 'alert' }, h('strong', {}, '⚠️ Allergy warning: '),
      `this recipe contains ${hits.map(allergyName).join(', ')}, which ${hits.length === 1 ? 'is' : 'are'} on your allergy list.`,
      h('div', { class: 'hint', style: 'margin-top:4px' }, 'Found from the ingredients list. Always check labels too.')));
  }

  const adminBar = isAdmin() ? h('div', { class: 'admin-bar' },
    h('strong', {}, 'Admin'),
    h('button', { class: 'btn gold small', onclick: async () => { await api('POST', `/api/recipes/${r.id}/verify`, { verified: !r.verified }); toast(r.verified ? 'Removed from Jace Verified' : 'Added to Jace Verified'); route(); } }, r.verified ? 'Remove verified badge' : '✓ Make Jace Verified'),
    r.status === 'published'
      ? h('button', { class: 'btn danger small', onclick: () => takedown(r.id) }, 'Take down')
      : h('button', { class: 'btn small', onclick: async () => { await api('POST', `/api/recipes/${r.id}/restore`, {}); toast(r.status === 'pending' ? 'Approved and published' : 'Recipe restored'); route(); } }, r.status === 'pending' ? 'Approve & publish' : 'Restore')) : null;

  app.replaceChildren(h('article', { class: 'recipe' },
    h('div', {},
      h('div', { class: 'recipe-hero' }, r.image ? h('img', { src: r.image, alt: r.title }) : EMOJI[r.category] || '🍽️'),
      moderationPanel(r)),
    h('div', {},
      notices,
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, r.verified ? verifiedBadge() : null, h('a', { class: 'tag', href: browseHref({ category: r.category }), style: 'text-decoration:none' }, r.category), r.aiAssisted ? h('span', { class: 'tag ai-tag' }, '✨ Made with AI help') : null,
        r.visibility === 'private' ? h('span', { class: 'tag' }, '🔒 Private') : null,
        r.visibility === 'unlisted' ? [h('span', { class: 'tag' }, '🔗 Unlisted'), h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast(location.href); } } }, 'Copy link')] : null),
      h('h1', {}, r.title),
      h('a', { class: 'byline', href: `#/u/${r.author.username}` }, avatar(r.author, 'md'), h('div', {}, h('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:800' }, r.author.displayName, userCheck(r.author)), h('div', { class: 'muted', style: 'font-size:.88rem' }, `@${r.author.username} · ${timeAgo(r.createdAt)}`))),
      team.length ? h('div', { class: 'with-team' }, h('span', { class: 'muted' }, '👥 Made with '),
        team.map((c, i) => [i ? ', ' : '', h('a', { href: `#/u/${c.username}` }, c.displayName)])) : null,
      r.myInvite ? h('div', { class: 'notice invite' }, h('strong', {}, '👥 You’re invited! '), `${r.author.displayName} invited you to make this recipe together. If you accept, you can edit it with them.`,
        h('div', { class: 'actions', style: 'margin:10px 0 0' },
          h('button', { class: 'btn primary small', onclick: () => answerInvite(r.id, 'accept') }, 'Accept'),
          h('button', { class: 'btn small', onclick: () => answerInvite(r.id, 'decline') }, 'Decline'))) : null,
      r.description ? h('p', {}, r.description) : null,
      h('div', { class: 'facts' }, r.prepTime ? h('span', { class: 'tag' }, `⏱ ${r.prepTime} min`) : null, h('span', { class: 'tag' }, `🍽 Serves ${r.servings}`)),
      ratingBox(r, mine),
      adminBar,
      r.canEdit ? h('div', { class: 'actions' },
        r.status !== 'removed' || isAdmin() ? h('a', { class: 'btn small', href: `#/edit/${r.id}` }, 'Edit') : null,
        r.isOwner ? h('button', { class: 'btn small', onclick: () => document.getElementById('share')?.classList.toggle('hidden') }, '👥 Share') : null,
        !r.isOwner ? h('button', { class: 'btn small', onclick: async () => {
          if (!confirm('Stop making this recipe together? You won’t be able to edit it anymore.')) return;
          await api('DELETE', `/api/recipes/${r.id}/collaborators/${encodeURIComponent(state.me.username)}`); toast('You left the recipe'); route();
        } }, 'Leave') : null,
        !r.isOwner ? null : h('button', { class: 'btn danger small', onclick: async () => {
          if (!confirm(`Delete “${r.title}” forever? This can’t be undone.`)) return;
          try { await api('DELETE', `/api/recipes/${r.id}`); toast('Recipe deleted'); go(`#/u/${state.me.username}`); } catch (err) { toast(err.message); }
        } }, 'Delete')) : null,
      r.isOwner ? sharePanel(r) : null,
      h('div', { class: 'panel' }, h('h2', {}, 'Ingredients'), h('ul', { class: 'ingredients' }, r.ingredients.map((i) => h('li', {}, h('input', { type: 'checkbox', 'aria-label': `Got ${i}` }), h('span', {}, i))))),
      h('div', { class: 'panel' }, h('h2', {}, 'Steps'), h('ol', { class: 'steps' }, r.steps.map((s) => h('li', {}, h('span', {}, s))))),
      commentsBox(r))));
}

async function answerInvite(recipeId, action) {
  try {
    await api('POST', `/api/recipes/${recipeId}/invite`, { action });
    toast(action === 'accept' ? 'You’re in! You can edit this recipe now.' : 'Invite declined');
    refreshUnread();
    if (action === 'accept') go(`#/r/${recipeId}`); else if (location.hash.startsWith('#/r/')) go('#/inbox'); else route();
  } catch (err) { toast(err.message); }
}

function sharePanel(r) {
  const input = h('input', { type: 'text', placeholder: 'Jace username, like momchef', 'aria-label': 'Jace username to invite' });
  const msg = h('div');
  const people = (r.collaborators || []).map((c) => h('div', { class: 'item' }, avatar(c, 'md'),
    h('div', { class: 'grow' }, h('a', { class: 'title', href: `#/u/${c.username}` }, c.displayName), h('div', { class: 'muted', style: 'font-size:.88rem' }, `@${c.username} · ${c.status === 'accepted' ? 'Making it with you' : 'Invite sent'}`)),
    h('button', { class: 'btn small danger', onclick: async () => {
      await api('DELETE', `/api/recipes/${r.id}/collaborators/${encodeURIComponent(c.username)}`);
      toast(c.status === 'accepted' ? `Removed @${c.username}` : 'Invite cancelled'); route();
    } }, c.status === 'accepted' ? 'Remove' : 'Cancel invite')));
  return h('div', { class: 'panel hidden', id: 'share' },
    h('h2', {}, '👥 Make it together'),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Invite people by their Jace username. They get a notification, and once they accept they can edit this recipe with you.'),
    h('form', { class: 'add-row', onsubmit: async (e) => {
      e.preventDefault(); msg.replaceChildren();
      try {
        await api('POST', `/api/recipes/${r.id}/collaborators`, { username: input.value });
        toast(`Invite sent to @${input.value.replace(/^@/, '')}`); await route();
        document.getElementById('share')?.classList.remove('hidden');
      } catch (err) { msg.replaceChildren(errorBox(err)); }
    } }, input, h('button', { class: 'btn primary' }, 'Invite')),
    msg,
    people.length ? h('div', { class: 'list', style: 'padding:0' }, people) : null);
}

const NOTE_TEXT = {
  invite: (n) => [h('strong', {}, n.actor?.displayName || 'Someone'), ' invited you to make ', h('strong', {}, n.recipeTitle || n.data.title || 'a recipe'), ' together'],
  invite_accepted: (n) => [h('strong', {}, n.actor?.displayName || 'Someone'), ' accepted your invite to ', h('strong', {}, n.recipeTitle || 'your recipe')],
  comment: (n) => [h('strong', {}, n.actor?.displayName || 'Someone'), ' commented on ', h('strong', {}, n.recipeTitle || 'your recipe'), n.data.text ? `: “${n.data.text}”` : ''],
  approved: (n) => ['Your recipe ', h('strong', {}, n.recipeTitle || ''), ' was approved and is live'],
  restored: (n) => ['Your recipe ', h('strong', {}, n.recipeTitle || ''), ' was put back'],
  verified: (n) => ['✓ Your recipe ', h('strong', {}, n.recipeTitle || ''), ' is now Jace Verified!'],
  taken_down: (n) => ['Your recipe ', h('strong', {}, n.recipeTitle || ''), ' was taken down', n.data.reason ? `: ${n.data.reason}` : ''],
  role: () => ['You can now post ', h('strong', {}, 'Jace Verified'), ' recipes'],
  review: (n) => [`${n.data.what || 'Something'} is waiting for review: `, h('strong', {}, n.data.title || n.recipeTitle || '')],
  blocked: (n) => ['Auto moderation blocked ', h('strong', {}, n.data.title || 'a recipe'), n.actor ? [' by ', h('strong', {}, `@${n.actor.username}`)] : ''],
};

// Jace Recipes rules. Written for parents (and older kids) to read quickly.
const RULES = [
  ['🍽️', 'Real, safe food only', [
    'Share recipes for real food that is safe to eat.',
    'Never include things that aren’t food (cleaning products, chemicals, medicine, “poison” jokes) or dangerous tricks.',
    'Follow food safety: say safe cooking temperatures for meat, and don’t serve raw flour or raw eggs to kids.',
    'No drugs, cannabis edibles, diet pills or “detox” recipes.',
  ]],
  ['👶', 'Keep kids in mind', [
    'Jace Recipes is family friendly. Keep words, photos and jokes OK for kids to see.',
    'Baby & Toddler recipes: no honey for babies under 1, no alcohol, and cut food so it isn’t a choking hazard.',
    'Recipes with alcohol must say so clearly and aren’t for kids.',
  ]],
  ['⚠️', 'Be honest about allergies', [
    'List every ingredient, including small ones like nuts, sesame or butter.',
    'Don’t call a recipe “nut-free”, “dairy-free” or similar unless it really is.',
    'Allergy warnings on Jace Recipes come from the ingredients list. Always check labels yourself too.',
  ]],
  ['💬', 'Be kind', [
    'Comments and ratings should help other parents. Be kind, even when a recipe didn’t work for you.',
    'No bullying, hate, insults, threats or harassment of anyone.',
    'Respect other people’s recipes. Don’t copy someone’s recipe and post it as your own; credit where you got it.',
  ]],
  ['🔒', 'Keep things private and safe', [
    'Don’t share personal information (addresses, phone numbers, school names), yours or anyone else’s.',
    'No spam, ads, or links to sell things. A link to where a recipe came from is fine, but it may be checked first.',
    'Only invite people you know to make recipes with you, and only accept invites from people you know.',
  ]],
  ['✨', 'AI recipes', [
    'Read every line of an AI recipe before you share it. AI can make mistakes.',
    'You’re responsible for anything you publish, even if AI wrote the first draft.',
    'Recipes made with AI show a “Made with AI help” tag.',
  ]],
  ['🛡️', 'How moderation works', [
    'Every recipe, edit, comment and name is checked by auto moderation. Some are blocked, some wait for a person to review them, and some get safety notes added.',
    'Auto moderation can make mistakes in both directions. @okjace can approve, publish, take down or restore anything.',
    'Breaking the rules can get a recipe or comment taken down, and repeat or serious problems can get an account suspended from Jace Recipes.',
    'Banned or muted Jace accounts are also banned or muted here.',
  ]],
];

function pageRules() {
  app.replaceChildren(h('div', { class: 'form-page rules' },
    h('a', { class: 'back', href: '#/' }, '← Home'),
    h('h1', {}, 'Jace Recipes Rules'),
    h('p', { class: 'muted' }, 'Jace Recipes is a place for parents to share the food their families love. These rules keep it safe and friendly for everyone.'),
    RULES.map(([icon, title, items]) => h('section', { class: 'panel' },
      h('h2', {}, h('span', { 'aria-hidden': 'true' }, `${icon} `), title),
      h('ul', {}, items.map((t) => h('li', {}, t))))),
    h('div', { class: 'panel' },
      h('h2', {}, '📄 Jace Terms and Privacy'),
      h('p', { style: 'margin:0' }, 'Jace Recipes uses your Jace account, so the ',
        h('a', { href: 'https://github.com/okjace/jace/blob/main/legal/terms-of-service.md', target: '_blank', rel: 'noopener' }, 'Jace Terms of Service'), ' and ',
        h('a', { href: 'https://github.com/okjace/jace/blob/main/legal/privacy-policy.md', target: '_blank', rel: 'noopener' }, 'Jace Privacy Policy'),
        ' apply too. See something that breaks these rules? Tell @okjace.')),
    h('p', { class: 'hint', style: 'text-align:center' }, 'Last updated November 25, 2026.')));
}

async function pageInbox() {
  if (!state.me) return go('#/signin');
  const { items } = await api('GET', '/api/inbox');
  const draw = (list) => list.length ? list.map((n) => {
    const href = n.type === 'blocked' ? '#/admin/blocked' : n.type === 'role' ? '#/new' : n.recipeId ? `#/r/${n.recipeId}` : '#/';
    return h('div', { class: `item note${n.read ? '' : ' unread'}` },
      n.actor ? avatar(n.actor, 'md') : h('span', { class: 'avatar md', 'aria-hidden': 'true' }, n.type === 'verified' ? '✓' : '🍽'),
      h('div', { class: 'grow' },
        h('a', { href, class: 'note-text' }, ...(NOTE_TEXT[n.type] || (() => ['Notification']))(n)),
        h('div', { class: 'muted', style: 'font-size:.85rem' }, timeAgo(n.createdAt)),
        n.type === 'invite' ? h('div', { class: 'actions', style: 'margin:8px 0 0' },
          h('button', { class: 'btn primary small', onclick: () => answerInvite(n.recipeId, 'accept') }, 'Accept'),
          h('button', { class: 'btn small', onclick: () => answerInvite(n.recipeId, 'decline') }, 'Decline')) : null),
      n.type !== 'invite' ? h('button', { class: 'chip-x', title: 'Remove', 'aria-label': 'Remove notification', onclick: async () => {
        const res = await api('PATCH', '/api/inbox', { delete: n.id }); list = res.items; box.replaceChildren(...draw(list));
      } }, '×') : null);
  }) : [h('div', { class: 'empty' }, 'No notifications yet. Invites, comments and news about your recipes show up here.')];
  let list = items;
  const box = h('div', { class: 'list' }, ...draw(list));
  app.replaceChildren(h('div', { class: 'form-page' }, h('h1', {}, '🔔 Notifications'), box));
  // Opening the inbox marks everything read.
  if (items.some((n) => !n.read)) { await api('PATCH', '/api/inbox', { all: true }); state.unread = 0; renderNav(); }
}

async function refreshUnread() {
  if (!state.me) return;
  try {
    const { unread } = await api('GET', '/api/inbox?count=1');
    if (unread !== state.unread) { state.unread = unread; renderNav(); }
  } catch { /* offline */ }
}

function moderationPanel(r) {
  return h('div', { class: 'safety' },
    h('h3', {}, '🛡️ Checked by auto moderation'),
    h('ul', { class: 'checks' }, (r.checks || []).map((c) => (typeof c === 'string' ? h('li', {}, c) : h('li', { class: c.ok ? 'ok' : 'warn' }, c.text)))),
    r.safetyNotes.length ? [h('h3', { style: 'margin-top:12px' }, 'Safety notes'), h('ul', {}, r.safetyNotes.map((n) => h('li', {}, n)))] : null,
    h('div', { class: 'muted', style: 'font-size:.8rem;margin-top:8px' }, 'Jace Recipes checks every recipe for unsafe ingredients, allergens and bad language. It can miss things, so use your own judgment too.'));
}

function ratingBox(r, mine) {
  const summary = h('div', { class: 'rating-summary' },
    r.ratingCount ? [h('span', { class: 'stars-inline big', 'aria-hidden': 'true' }, starText(r.rating)), h('strong', {}, ` ${r.rating}`), h('span', { class: 'muted' }, ` (${r.ratingCount} rating${r.ratingCount === 1 ? '' : 's'})`)]
      : h('span', { class: 'muted' }, 'No ratings yet'));
  if (r.visibility === 'private') return null;
  if (!state.me || mine || r.status !== 'published') return h('div', { class: 'rating' }, summary);
  const stars = h('div', { class: 'star-input', role: 'radiogroup', 'aria-label': 'Your rating' });
  for (let n = 1; n <= 5; n++) {
    stars.append(h('button', {
      type: 'button', class: `star${r.myRating >= n ? ' on' : ''}`, role: 'radio', 'aria-checked': String(r.myRating === n), 'aria-label': `${n} star${n === 1 ? '' : 's'}`,
      onclick: async () => {
        try {
          const { recipe } = await api('PUT', `/api/recipes/${r.id}/rating`, { stars: r.myRating === n ? 0 : n });
          toast(recipe.myRating ? `You rated it ${recipe.myRating} star${recipe.myRating === 1 ? '' : 's'}` : 'Rating removed');
          Object.assign(r, { rating: recipe.rating, ratingCount: recipe.ratingCount, myRating: recipe.myRating });
          box.replaceWith(ratingBox(r, mine));
        } catch (err) { toast(err.message); }
      },
    }, '★'));
  }
  const box = h('div', { class: 'rating' }, summary, h('div', { class: 'rate-me' }, h('span', { class: 'muted' }, r.myRating ? 'Your rating:' : 'Rate it:'), stars));
  return box;
}

function commentsBox(r) {
  if (r.visibility === 'private') return null;
  const list = h('div', { class: 'comments' }, h('div', { class: 'muted' }, 'Loading comments…'));
  const title = h('h2', {}, 'Comments');
  const draw = (comments) => {
    title.textContent = comments.length ? `Comments (${comments.length})` : 'Comments';
    list.replaceChildren(...(comments.length ? comments.map((c) => h('div', { class: 'comment' },
      avatar(c.author, 'md'),
      h('div', { class: 'grow' },
        h('div', { class: 'comment-head' }, h('a', { href: `#/u/${c.author.username}`, style: 'font-weight:800;text-decoration:none' }, c.author.displayName), userCheck(c.author), h('span', { class: 'muted' }, `@${c.author.username} · ${timeAgo(c.createdAt)}`),
          c.status === 'pending' ? h('span', { class: 'status-pill pending' }, 'Waiting for review') : null),
        h('p', {}, c.body),
        c.status === 'pending' && c.modReasons && c.modReasons.length ? h('div', { class: 'hint' }, `Auto moderation: ${c.modReasons.join(' ')}`) : null,
        h('div', { class: 'actions', style: 'margin:4px 0 0' },
          isAdmin() && c.status === 'pending' ? h('button', { class: 'btn small', onclick: async () => { await api('POST', `/api/comments/${c.id}/approve`); toast('Comment approved'); load(); } }, 'Approve') : null,
          c.mine || isAdmin() ? h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this comment?')) return; try { await api('DELETE', `/api/comments/${c.id}`); toast('Comment deleted'); load(); } catch (err) { toast(err.message); } } }, c.mine ? 'Delete' : 'Take down') : null))))
      : [h('div', { class: 'muted' }, 'No comments yet. Made it? Tell other parents how it went!')]));
  };
  const load = async () => { try { draw((await api('GET', `/api/recipes/${r.id}/comments`)).comments); } catch (err) { list.replaceChildren(errorBox(err)); } };
  load();

  let form = null;
  if (state.me && r.status === 'published' && !state.me.muted) {
    const text = h('textarea', { maxlength: 1000, required: true, placeholder: 'Made it? Share how it went or a tip for other parents.', style: 'min-height:80px' });
    const msg = h('div');
    form = h('form', { class: 'comment-form', onsubmit: async (e) => {
      e.preventDefault(); msg.replaceChildren();
      try {
        const { comment } = await api('POST', `/api/recipes/${r.id}/comments`, { body: text.value });
        text.value = '';
        toast(comment.status === 'pending' ? 'Your comment will show after a quick review' : 'Comment posted');
        load();
      } catch (err) { msg.replaceChildren(errorBox(err)); }
    } }, text, msg, h('div', { class: 'actions' }, h('button', { class: 'btn primary small' }, 'Post comment')),
    h('div', { class: 'hint' }, 'Comments are checked by auto moderation. Be kind!'));
  } else if (!state.me) {
    form = h('p', {}, signInButton(location.hash.slice(1) ? `/${location.hash}` : '/', 'small'), ' to rate and comment.');
  }
  return h('div', { class: 'panel', id: 'comments' }, title, form, list);
}

async function takedown(id) {
  const reason = prompt('Why is this recipe being taken down? (The author will see this.)', 'This recipe breaks the Jace Recipes rules.');
  if (reason === null) return;
  await api('POST', `/api/recipes/${id}/takedown`, { reason });
  toast('Recipe taken down');
  route();
}

async function pageEditor(id, params = new URLSearchParams()) {
  if (!state.me) return go('#/signin');
  let r = { title: '', description: '', category: state.categories[0], prepTime: '', servings: 4, ingredients: [], steps: [], image: null, verified: false };
  const fromAI = !id && params.get('from') === 'ai' && state.aiDraft;
  if (fromAI) r = { ...r, ...state.aiDraft };
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
    autoFix: h('input', { type: 'checkbox', checked: true }),
    visibility: h('select', {},
      h('option', { value: 'public', selected: (r.visibility || 'public') === 'public' }, '🌎 Public: everyone can find it'),
      h('option', { value: 'unlisted', selected: r.visibility === 'unlisted' }, '🔗 Unlisted: only people with the link'),
      h('option', { value: 'private', selected: r.visibility === 'private' }, '🔒 Private: only you')),
  };
  const preview = h('div', { class: 'photo-preview' });
  const drawPreview = () => preview.replaceChildren(image ? h('img', { src: image, alt: '' }) : 'No photo');
  drawPreview();
  const msg = h('div');
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, id ? 'Save changes' : 'Publish recipe');

  let overrideNext = false;
  const onsubmit = async (e) => {
    e.preventDefault(); msg.replaceChildren(); saveBtn.disabled = true;
    const body = { title: f.title.value, description: f.description.value, category: f.category.value, prepTime: f.prepTime.value, servings: f.servings.value, ingredients: f.ingredients.value, steps: f.steps.value, image, aiAssisted: Boolean(fromAI), autoFix: f.autoFix.checked, visibility: f.visibility.value };
    if (overrideNext) body.bypassModeration = true;
    if (canVerify()) body.verified = f.verified.checked;
    try {
      saveBtn.textContent = f.autoFix.checked ? 'Checking spelling…' : 'Saving…';
      const { recipe, fixes } = await api(id ? 'PUT' : 'POST', id ? `/api/recipes/${id}` : '/api/recipes', body);
      if (fixes) setTimeout(() => toast(`✨ Fixed ${fixes} spelling or grammar thing${fixes === 1 ? '' : 's'}`), 2700);
      if (fromAI) state.aiDraft = null;
      toast(recipe.status === 'pending' ? 'Sent to review before it goes public' : 'Recipe published!');
      go(`#/r/${recipe.id}`);
    } catch (err) {
      overrideNext = false;
      msg.replaceChildren(errorBox(err),
        err.data && err.data.canOverride ? h('div', { class: 'notice warn' }, h('strong', {}, 'Admin: '), 'you can publish it anyway if auto moderation got it wrong. The reasons stay on record.',
          h('div', { class: 'actions', style: 'margin:8px 0 0' }, h('button', { class: 'btn danger small', type: 'button', onclick: () => { overrideNext = true; saveBtn.click(); } }, 'Publish anyway (admin)'))) : null);
      msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally { saveBtn.disabled = false; saveBtn.textContent = id ? 'Save changes' : 'Publish recipe'; }
  };

  app.replaceChildren(h('div', { class: 'form-page' },
    h('h1', {}, id ? 'Edit recipe' : fromAI ? 'Check your AI recipe' : 'Share a recipe'),
    fromAI ? h('div', { class: 'notice warn' }, '✨ This recipe was written by AI. Read every line and fix anything that’s wrong before you publish. It will show a “Made with AI help” tag.') : null,
    !id && !fromAI && state.ai ? h('p', {}, h('a', { href: '#/ai' }, '✨ Or let AI write a first draft for you')) : null,
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
      !id || r.isOwner ? [h('label', {}, 'Who can see it'), f.visibility,
        h('div', { class: 'hint', style: 'margin-top:4px' }, 'Unlisted recipes don’t show in lists or search. Private recipes are only for you and people you share them with (Jace Recipes admins can still see them to keep the site safe).')]
        : h('p', { class: 'hint' }, `You’re editing ${r.author.displayName}’s recipe together. Only they can change who can see it.`),
      h('label', { class: 'check' }, f.autoFix, '✨ Fix my spelling and grammar automatically', h('span', { class: 'hint' }, ' (amounts never change)')),
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
  const allergyBoxes = state.allergens.map((a) => h('input', { type: 'checkbox', value: a, checked: (me.allergies || []).includes(a) }));
  let custom = [...(me.customAllergies || [])];
  const customList = h('div', { class: 'chips', style: 'flex-wrap:wrap;overflow:visible;margin-top:8px' });
  const drawCustom = () => customList.replaceChildren(...custom.map((t) => h('span', { class: 'chip on custom-allergy' }, t,
    h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${t}`, onclick: () => { custom = custom.filter((x) => x !== t); drawCustom(); } }, '×'))));
  drawCustom();
  const customInput = h('input', { type: 'text', maxlength: 40, placeholder: 'e.g. strawberries, mustard, kiwi' });
  const addCustom = () => {
    const t = customInput.value.trim().toLowerCase();
    if (t.length < 2) return;
    if (!custom.includes(t)) custom.push(t);
    customInput.value = ''; drawCustom(); customInput.focus();
  };
  customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
  const emailBoxes = Object.entries(state.emailTypes || {})
    .filter(([k]) => k !== 'admin_review' || isAdmin())
    .map(([k, label]) => [k, label, h('input', { type: 'checkbox', checked: (me.emailPrefs || {})[k] !== false })]);

  app.replaceChildren(h('div', { class: 'form-page' },
    h('h1', {}, 'Your Jace Recipes profile'),
    h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault(); msg.replaceChildren();
      try {
        state.me = (await api('PATCH', '/api/me', { displayName: name.value, bio: bio.value, avatar: avatarData, allergies: allergyBoxes.filter((b) => b.checked).map((b) => b.value), customAllergies: custom, emailPrefs: Object.fromEntries(emailBoxes.map(([k, , b]) => [k, b.checked])) })).user;
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
      h('label', {}, '⚠️ Allergies in your family'),
      h('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Recipes with these get a warning just for you. Only you can see this list.'),
      h('div', { class: 'allergy-grid' }, allergyBoxes.map((b) => h('label', { class: 'check', style: 'margin:0' }, b, ALLERGEN_LABELS[b.value].replace('-free', '')))),
      h('label', {}, 'Other allergies ', h('span', { class: 'hint' }, '(type your own)')),
      h('div', { class: 'add-row', style: 'margin:0' }, customInput, h('button', { class: 'btn', type: 'button', onclick: addCustom }, 'Add')),
      customList,
      h('label', {}, '✉️ Emails'),
      h('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Sent by Jace to the email on your Jace account. You can also turn off all app emails on Jace (Manage account → Emails).'),
      h('div', { class: 'email-prefs' }, emailBoxes.map(([, label, b]) => h('label', { class: 'check', style: 'margin:0' }, b, label))),
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
  const tabs = [['queue', `Review queue (${data.pending.length})`], ['verified', `Verified recipes (${data.verified.length})`], ['people', 'People & verifiers'], ['removed', `Taken down (${data.removed.length})`], ['comments', `Comments to check (${data.pendingComments.length})`], ['blocked', `Blocked by auto moderation (${data.blocked.length})`]];
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
  } else if (tab === 'blocked') {
    body = [h('p', { class: 'muted' }, 'Recipes auto moderation stopped. If it got one wrong, publish it anyway; the reasons stay on record.'),
      data.blocked.length ? data.blocked.map((b) => h('div', { class: 'item', style: 'align-items:flex-start' },
        avatar(b.author, 'md'),
        h('div', { class: 'grow' },
          h('div', { style: 'font-weight:800' }, b.recipe.title || '(no title)', h('span', { class: 'muted', style: 'font-weight:400' }, ` by @${b.author.username} · ${timeAgo(b.createdAt)}${b.recipeId ? ' · an edit' : ''}`)),
          h('div', { style: 'color:var(--danger);font-size:.9rem;margin:4px 0' }, '⛔ ', (b.reasons || []).join(' ')),
          h('details', {}, h('summary', { class: 'hint', style: 'cursor:pointer' }, 'See the recipe'),
            h('div', { class: 'hint' }, 'Ingredients:'), h('ul', {}, (b.recipe.ingredients || []).map((i) => h('li', {}, i))),
            h('div', { class: 'hint' }, 'Steps:'), h('ol', {}, (b.recipe.steps || []).map((x) => h('li', {}, x))))),
        [act('Publish anyway', 'danger', () => api('POST', `/api/admin/blocked/${b.id}`, { action: 'publish' })), act('Dismiss', '', () => api('POST', `/api/admin/blocked/${b.id}`, { action: 'dismiss' }))]))
        : h('div', { class: 'empty' }, 'Nothing blocked. 🎉')];
  } else if (tab === 'comments') {
    body = data.pendingComments.length ? data.pendingComments.map((c) => h('div', { class: 'item' },
      avatar(c.author, 'md'),
      h('div', { class: 'grow' }, h('div', { style: 'font-weight:800' }, `@${c.author.username}`), h('div', {}, c.body),
        h('div', { class: 'hint' }, `⚠️ ${(c.modReasons || []).join(' ')} · `, h('a', { href: `#/r/${c.recipeId}` }, 'See recipe'))),
      [act('Approve', 'primary', () => api('POST', `/api/comments/${c.id}/approve`, {})), act('Delete', 'danger', () => api('DELETE', `/api/comments/${c.id}`, {}))]))
      : h('div', { class: 'empty' }, 'No comments waiting. 🎉');
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
  if (parts[0] !== 'inbox') refreshUnread();
  try {
    switch (parts[0]) {
      case undefined: await pageHome(params); break;
      case 'browse': await pageBrowse(params); break;
      case 'ai': await pageAI(); break;
      case 'r': await pageRecipe(parts[1]); break;
      case 'new': await pageEditor(undefined, params); break;
      case 'edit': await pageEditor(parts[1]); break;
      case 'u': await pageProfile(parts[1]); break;
      case 'settings': await pageSettings(); break;
      case 'inbox': await pageInbox(); break;
      case 'rules': pageRules(); break;
      case 'signin': case 'login': case 'register': pageSignIn(params); break;
      case 'signin-error': pageSignIn(params); break;
      case 'admin': await pageAdmin(parts[1]); break;
      default: app.replaceChildren(h('div', { class: 'empty' }, 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
    }
  } catch (err) {
    app.replaceChildren(h('div', { class: 'form-page' }, errorBox(err), h('a', { class: 'btn', href: '#/' }, 'Back to recipes')));
  }
}

// "By using this site you agree…" note in the corner, fades out after 5 seconds.
(function legalNotice() {
  const el = document.getElementById('legal-notice');
  if (!el) return;
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 700); }, 5000);
})();

(async function start() {
  const [meta, me] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/me')]);
  state.categories = meta.categories; state.admin = meta.admin; state.me = me.user; state.ai = meta.ai; state.allergens = meta.allergens || []; state.emailTypes = meta.emailTypes || {};
  if (state.me) { try { state.unread = (await api('GET', '/api/inbox?count=1')).unread; } catch { state.unread = 0; } }
  renderNav();
  setInterval(refreshUnread, 60_000);
  window.addEventListener('hashchange', route);
  route();
})();
