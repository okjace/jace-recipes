// "Use your own AI": Jace Recipes writes a prompt people paste into any AI
// (ChatGPT, Claude, Gemini, Copilot…), then reads the answer they paste back.
// No API keys involved. The answer goes through auto moderation like any recipe.

/** The text people copy into their AI. Same safety rules the built-in AI gets. */
export function ownAiPrompt({ request, category, categories }) {
  return `You're helping me write a recipe for Jace Recipes, a family recipe site where parents share recipes.

What I want: ${request}${category ? `\nCategory: ${category}` : ''}

Please write ONE real, safe, family-friendly recipe and follow these rules:
- Only real food and normal kitchen ingredients. Nothing that isn't food or isn't safe to eat, no wild/foraged mushrooms, raw kidney beans, apricot kernels or raw milk.
- No drugs, cannabis, supplements, medicine, diet pills or "detox" recipes.
- Food safety: give safe inside temperatures for meat (chicken/turkey 165°F/74°C, ground meat 160°F/71°C, pork 145°F/63°C). No raw flour or raw eggs unless heat-treated or pasteurized.
- For babies and toddlers: no honey under 12 months, no added salt or sugar, no alcohol, and no choking hazards (whole nuts, whole grapes, popcorn, hard candy). Say how to cut things small.
- No alcohol unless I clearly asked for an adult recipe.
- Simple, kind language. No links or brand names.

Reply with ONLY this JSON (no other text), so I can paste it into Jace Recipes:
{
  "title": "short recipe name",
  "description": "1-2 sentences about it",
  "category": "one of: ${categories.join(', ')}",
  "prepTime": total minutes as a number,
  "servings": number,
  "ingredients": ["each ingredient with its amount"],
  "steps": ["each step in order"]
}`;
}

const strip = (t) => String(t).replace(/^\s*(?:[-*•–]|\d+[.)]|\[\s?\]|☐)\s*/, '').replace(/\*\*|__|`/g, '').trim();

/**
 * Reads an AI's answer: the JSON we asked for, or a normal written recipe
 * ("Ingredients:" and "Steps:/Instructions:" sections, Markdown or not).
 * @returns {null | {title, description, category, prepTime, servings, ingredients, steps}}
 */
export function readPastedRecipe(text, categories) {
  const raw = String(text || '').slice(0, 20_000);
  // 1. JSON (possibly inside ``` fences or with chatter around it)
  const cleaned = raw.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const o = JSON.parse(cleaned.slice(start, end + 1));
      if (o && typeof o.title === 'string' && Array.isArray(o.ingredients) && Array.isArray(o.steps)) {
        return {
          title: o.title,
          description: typeof o.description === 'string' ? o.description : '',
          category: categories.find((c) => c.toLowerCase() === String(o.category || '').toLowerCase()) || null,
          prepTime: parseInt(o.prepTime, 10) || 0,
          servings: parseInt(o.servings, 10) || 4,
          ingredients: o.ingredients.map((x) => strip(String(x))).filter(Boolean),
          steps: o.steps.map((x) => strip(String(x))).filter(Boolean),
        };
      }
    } catch { /* not JSON; try plain text */ }
  }
  // 2. Plain written recipe
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  let section = 'top';
  let title = '';
  const top = []; const ingredients = []; const steps = [];
  let prepTime = 0; let servings = 0;
  for (const line of lines) {
    if (!line) continue;
    const heading = line.replace(/^#+\s*/, '').replace(/[:*_]+$/g, '').replace(/^\*\*|\*\*$/g, '').trim().toLowerCase();
    if (/^(ingredients?|what you('|’)ll need|you('|’)ll need)\b/.test(heading) && heading.length < 40) { section = 'ing'; continue; }
    if (/^(instructions?|directions?|steps?|method|how to make( it)?|preparation)\b/.test(heading) && heading.length < 40) { section = 'steps'; continue; }
    if (/^(notes?|tips?|nutrition|serving suggestions?|variations?)\b/.test(heading) && heading.length < 40) { section = 'skip'; continue; }
    const time = /(?:total|prep|cook)?\s*time[^0-9]{0,15}(\d+)\s*(min|hour|hr)/i.exec(line);
    if (time && section === 'top') { prepTime = parseInt(time[1], 10) * (/h/i.test(time[2]) ? 60 : 1); continue; }
    const serves = /(?:serves|servings|makes|yield)[^0-9]{0,10}(\d+)/i.exec(line);
    if (serves && section === 'top') { servings = parseInt(serves[1], 10); continue; }
    if (section === 'top') {
      if (!title && !/^(sure|here('|’)s|okay|of course|absolutely)\b/i.test(line)) title = strip(line.replace(/^#+\s*/, '').replace(/^(recipe|title)\s*:\s*/i, ''));
      else if (title) top.push(strip(line));
    } else if (section === 'ing') ingredients.push(strip(line));
    else if (section === 'steps') steps.push(strip(line));
  }
  if (!title || !ingredients.length || !steps.length) return null;
  return {
    title: title.slice(0, 100),
    description: top.join(' ').slice(0, 1000),
    category: null,
    prepTime, servings: servings || 4,
    ingredients: ingredients.filter(Boolean), steps: steps.filter(Boolean),
  };
}
