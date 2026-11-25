// "Make a recipe with AI". Uses OpenRouter's free models (ids ending in
// ":free") through its OpenAI-compatible chat completions API, trying each
// model in turn. Needs OPENROUTER_API_KEY. Never log prompt or answer text here.

const PROVIDERS = [
  { name: 'mock', base: process.env.MOCK_AI_URL, key: () => process.env.MOCK_AI_URL && 'mock', models: ['mock-chef'] },
  { name: 'openrouter', base: 'https://openrouter.ai/api/v1', key: () => process.env.OPENROUTER_API_KEY, modelEnv: 'OPENROUTER_MODEL', models: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-26b-a4b-it:free'] }, // fallback if the model list can't be read
];

export const aiConfigured = () => PROVIDERS.some((p) => p.key());

const SYSTEM = `You are the recipe helper for Jace Recipes, a family recipe site where parents share recipes.
Write ONE real, safe, family-friendly recipe for what the parent asks for.

Safety rules (always follow them):
- Only real food and normal kitchen ingredients. Never anything that isn't food or isn't safe to eat (cleaning products, chemicals, non-food items, wild/foraged mushrooms, raw kidney beans, apricot kernels, raw milk).
- No drugs, no cannabis, no supplements or medicine. No diet pills, detox or extreme diets.
- Follow food safety: say safe inside temperatures for meat (chicken/turkey 165°F/74°C, ground meat 160°F/71°C, pork 145°F/63°C), never raw flour or raw eggs unless pasteurized or heat-treated, and keep cold food cold.
- For "Baby & Toddler" recipes: no honey (under 12 months), no added salt or sugar, no alcohol, no whole nuts, whole grapes, popcorn, hard candy or other choking hazards; give soft textures and cut sizes.
- No alcohol unless the parent clearly asks for an adult recipe; never in kids' recipes.
- Keep the language kind and simple. No links, brand promotions or personal information.
- If the request is not about food, or asks for something unsafe, do not write a recipe. Instead answer {"error": "<a short, friendly reason>"}.

Answer with ONLY a JSON object, no Markdown, in exactly this shape:
{"title": string (max 80 chars), "description": string (1-2 sentences), "category": one of CATEGORIES, "prepTime": number (total minutes), "servings": number, "ingredients": [string, ...] (each with amount), "steps": [string, ...] (short, clear, numbered by order; include any safety step such as cooking temperature)}`;

class AIError extends Error { constructor(status, message) { super(message); this.status = status; } }

function parseJson(text) {
  const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function callModel(p, model, messages, { timeoutMs = 25_000, temperature = 0.7, maxTokens = 1200, signal } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key()}`, ...(p.name === 'openrouter' ? { 'HTTP-Referer': 'https://jace-recipes.vercel.app', 'X-Title': 'Jace Recipes' } : {}) },
    body: JSON.stringify({
      model, messages, temperature, max_tokens: maxTokens,
      // OpenRouter: send it to whichever server is fastest right now, and skip slow "thinking".
      ...(p.name === 'openrouter' ? { provider: { sort: 'throughput' }, reasoning: { effort: 'low', exclude: true } } : {}),
    }),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) forgetModel(model); // gone or renamed: pick again next time
    if (res.status === 429 || res.status >= 500) {
      // Busy: leave it alone for a while (as long as OpenRouter asks, 1 to 5 minutes).
      const wait = Math.min(300, Math.max(60, parseInt(res.headers.get('retry-after'), 10) || 60));
      coolDown(model, wait * 1000);
    }
    throw new Error(`${p.name}/${model} answered ${res.status}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ---- Busy models and the last one that worked (kept while the server instance is warm).
const health = (globalThis.__jaceRecipesModelHealth ||= { coolUntil: new Map(), lastGood: null });
const coolDown = (model, ms) => health.coolUntil.set(model, Date.now() + ms);
const isCooling = (model) => (health.coolUntil.get(model) || 0) > Date.now();
/** Last model that worked first, then the rest; busy ones go to the back instead of being skipped. */
function order(models) {
  const list = [...models].sort((a, b) => (b === health.lastGood) - (a === health.lastGood));
  return [...list.filter((m) => !isCooling(m)), ...list.filter(isCooling)];
}

// ---- Which free models to use.
// OpenRouter's free models come and go, so ask it which exist (cached for 6 hours)
// instead of hard-coding names. Only ids ending in ":free" are ever used.
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
const cache = (globalThis.__jaceRecipesModels ||= { models: null, at: 0 });
const SKIP = /(vl\b|-vl|vision|omni|audio|image|embed|guard|moderation|ocr|tts|speech|nano|lightning|preview)/i;
// Fast models first (small "active" mixture models answer quickly), huge slow ones last.
const PREFERRED = [/gemma-4-26b-a4b/i, /ling-.*flash/i, /gemma-4-31b/i, /gpt-oss-120b/i, /llama-3\.3-70b/i, /ernie.*flash/i, /nemotron-3-ultra/i];

function sizeInBillions(id) {
  let best = null;
  for (const m of id.toLowerCase().matchAll(/(?:^|[-_/:.])(?:a)?(\d+(?:\.\d+)?)b(?=$|[-_:.])/g)) {
    const n = parseFloat(m[1]);
    if (best === null || n > best) best = n;
  }
  return best;
}

export function pickFreeModels(list) {
  const ok = list.filter((m) => {
    const id = String(m.id || '');
    if (!id.endsWith(':free') || SKIP.test(id)) return false;
    const out = m.architecture?.output_modalities;
    if (Array.isArray(out) && (out.length !== 1 || out[0] !== 'text')) return false;
    const size = sizeInBillions(id);
    return size === null || size >= 8; // tiny models write poor recipes
  }).map((m) => m.id);
  const chosen = [];
  for (const re of PREFERRED) for (const id of ok) if (re.test(id) && !chosen.includes(id)) chosen.push(id);
  return [...chosen, ...ok.filter((id) => !chosen.includes(id))].slice(0, 5);
}

function forgetModel(model) {
  if (cache.models) cache.models = cache.models.filter((m) => m !== model);
}

async function modelsFor(p) {
  if (p.name !== 'openrouter') return p.models;
  const pinned = (process.env[p.modelEnv] || '').split(',').map((s) => s.trim()).filter((m) => m.endsWith(':free'));
  if (pinned.length) return pinned;
  if (cache.models?.length && Date.now() - cache.at < MODEL_CACHE_MS) return cache.models;
  try {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key()}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const models = pickFreeModels((await res.json())?.data || []);
    if (!models.length) throw new Error('no free models');
    Object.assign(cache, { models, at: Date.now() });
    console.log(`[ai] free models: ${models.join(', ')}`);
    return models;
  } catch (e) {
    console.warn(`[ai] couldn't list models (${e.message}); using fallback`);
    return p.models;
  }
}

/**
 * Sends messages to free models and returns the first good JSON answer (or null).
 * To be fast it asks two models at once and uses whichever answers first, stopping the other.
 */
export async function askJSON(messages, { timeoutMs = 25_000, budgetMs = 50_000, temperature = 0.7, maxTokens = 1200, accept = () => true, parallel = 2 } = {}) {
  const started = Date.now();
  for (const p of PROVIDERS.filter((x) => x.base && x.key())) {
    const queue = order(await modelsFor(p));
    while (queue.length) {
      const left = budgetMs - (Date.now() - started);
      if (left < 3000) return null;
      const batch = queue.splice(0, parallel);
      const stop = new AbortController();
      const tries = batch.map(async (model) => {
        const t0 = Date.now();
        try {
          const out = parseJson(await callModel(p, model, messages, { timeoutMs: Math.min(timeoutMs, left), temperature, maxTokens, signal: stop.signal }));
          if (out && accept(out)) {
            health.lastGood = model;
            console.log(`[ai] ${model} answered in ${Date.now() - t0} ms`);
            return out;
          }
          throw new Error('no usable answer');
        } catch (e) {
          if (!stop.signal.aborted) {
            if (e.name === 'TimeoutError') coolDown(model, 120_000); // too slow right now
            console.warn(`[ai] ${model}: ${e.message}`); // no prompt text
          }
          throw e;
        }
      });
      try {
        const out = await Promise.any(tries);
        stop.abort(); // the other model doesn't need to finish
        return out;
      } catch { /* every model in this batch failed: try the next ones */ }
    }
  }
  return null;
}

/**
 * Asks the AI for a recipe draft.
 * @returns {Promise<{title, description, category, prepTime, servings, ingredients, steps}>}
 */
export async function generateRecipe({ prompt, category, categories }) {
  if (!aiConfigured()) throw new AIError(503, 'The AI recipe maker isn’t set up on this site yet.');
  const out = await askJSON([
    { role: 'system', content: SYSTEM.replace('CATEGORIES', categories.map((c) => JSON.stringify(c)).join(', ')) },
    { role: 'user', content: `${category ? `Category: ${category}\n` : ''}Request: ${prompt}` },
  ], { timeoutMs: 30_000, budgetMs: 52_000, maxTokens: 1400, accept: (o) => typeof o.error === 'string' || (typeof o.title === 'string' && Array.isArray(o.ingredients) && Array.isArray(o.steps)) });
  if (!out) throw new AIError(503, 'The AI is busy right now. Please try again in a minute.');
  if (typeof out.error === 'string') throw new AIError(422, out.error.slice(0, 300));
  return {
    title: out.title,
    description: typeof out.description === 'string' ? out.description : '',
    category: categories.includes(out.category) ? out.category : (categories.includes(category) ? category : 'Dinner'),
    prepTime: Number(out.prepTime) || 0,
    servings: Number(out.servings) || 4,
    ingredients: out.ingredients.map(String),
    steps: out.steps.map((s) => String(s).replace(/^\s*\d+[.)]\s*/, '')),
  };
}
