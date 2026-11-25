// "Make a recipe with AI". Uses OpenRouter's free models (ids ending in
// ":free") through its OpenAI-compatible chat completions API, trying each
// model in turn. Needs OPENROUTER_API_KEY. Never log prompt or answer text here.

const PROVIDERS = [
  { name: 'mock', base: process.env.MOCK_AI_URL, key: () => process.env.MOCK_AI_URL && 'mock', models: ['mock-chef'] },
  { name: 'openrouter', base: 'https://openrouter.ai/api/v1', key: () => process.env.OPENROUTER_API_KEY, modelEnv: 'OPENROUTER_MODEL', models: ['openai/gpt-oss-120b:free', 'meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free'] },
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

async function callModel(p, model, messages) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key()}`, ...(p.name === 'openrouter' ? { 'HTTP-Referer': 'https://jace-recipes.vercel.app', 'X-Title': 'Jace Recipes' } : {}) },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 2000 }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`${p.name}/${model} answered ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Asks the AI for a recipe draft.
 * @returns {Promise<{title, description, category, prepTime, servings, ingredients, steps}>}
 */
export async function generateRecipe({ prompt, category, categories }) {
  const providers = PROVIDERS.filter((p) => p.base && p.key());
  if (!providers.length) throw new AIError(503, 'The AI recipe maker isn’t set up on this site yet.');
  const messages = [
    { role: 'system', content: SYSTEM.replace('CATEGORIES', categories.map((c) => JSON.stringify(c)).join(', ')) },
    { role: 'user', content: `${category ? `Category: ${category}\n` : ''}Request: ${prompt}` },
  ];
  const started = Date.now();
  for (const p of providers) {
    const pinned = (process.env[p.modelEnv] || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Only free models: anything pinned without ":free" is skipped so it can never cost money.
    const models = (pinned.length ? pinned : p.models).filter((m) => p.name !== 'openrouter' || m.endsWith(':free'));
    for (const model of models) {
      if (Date.now() - started > 50_000) break; // stay inside the function's time limit
      try {
        const out = parseJson(await callModel(p, model, messages));
        if (!out) continue;
        if (typeof out.error === 'string') throw new AIError(422, out.error.slice(0, 300));
        if (typeof out.title !== 'string' || !Array.isArray(out.ingredients) || !Array.isArray(out.steps)) continue;
        return {
          title: out.title,
          description: typeof out.description === 'string' ? out.description : '',
          category: categories.includes(out.category) ? out.category : (categories.includes(category) ? category : 'Dinner'),
          prepTime: Number(out.prepTime) || 0,
          servings: Number(out.servings) || 4,
          ingredients: out.ingredients.map(String),
          steps: out.steps.map((s) => String(s).replace(/^\s*\d+[.)]\s*/, '')),
        };
      } catch (e) {
        if (e instanceof AIError) throw e;
        console.warn(`[ai] ${e.message}`); // no prompt text
      }
    }
  }
  throw new AIError(503, 'The AI is busy right now. Please try again in a minute.');
}
