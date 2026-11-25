// Auto spelling and grammar fixes for recipes.
//
// 1. The AI (free OpenRouter models, see lib/ai.js) proofreads the recipe. It
//    may only fix spelling, grammar, capitals and punctuation. Any line where
//    an amount or number changed, or where the line count changed, is thrown
//    away and the original is kept, so the AI can never change a recipe.
// 2. Without the AI (no key, busy, or too slow), a built-in fixer corrects
//    common kitchen misspellings, capitals and full stops.
import { askJSON } from './ai.js';

// Common misspellings in recipes. Keys are lowercase.
const TYPOS = {
  teh: 'the', adn: 'and', nad: 'and', wiht: 'with', iwth: 'with', taht: 'that', thier: 'their', untill: 'until', unitl: 'until',
  recipie: 'recipe', receipe: 'recipe', recepie: 'recipe', reciepe: 'recipe', seperate: 'separate', seperately: 'separately',
  tommorow: 'tomorrow', occassion: 'occasion', definately: 'definitely', alot: 'a lot', untilt: 'until', boiling: 'boiling',
  choclate: 'chocolate', chocolat: 'chocolate', chocalate: 'chocolate', chocolote: 'chocolate', brocoli: 'broccoli', brocolli: 'broccoli',
  broccolli: 'broccoli', tomatoe: 'tomato', tomatos: 'tomatoes', potatoe: 'potato', potatos: 'potatoes', bananna: 'banana', banna: 'banana',
  bannana: 'banana', cinammon: 'cinnamon', cinnamin: 'cinnamon', cinamon: 'cinnamon', vanila: 'vanilla', vanillia: 'vanilla',
  spagetti: 'spaghetti', spaghettii: 'spaghetti', spagehtti: 'spaghetti', lettuse: 'lettuce', letuce: 'lettuce', cucmber: 'cucumber',
  cucumbor: 'cucumber', zuchini: 'zucchini', zucchinni: 'zucchini', zuccini: 'zucchini', avacado: 'avocado', avocato: 'avocado',
  brocolini: 'broccolini', parmesean: 'parmesan', parmasan: 'parmesan', mozarella: 'mozzarella', mozzarela: 'mozzarella', mozerella: 'mozzarella',
  chedder: 'cheddar', chedar: 'cheddar', yoghurt: 'yogurt', yogart: 'yogurt', yougurt: 'yogurt', buiscuit: 'biscuit', biscut: 'biscuit',
  brocoly: 'broccoli', sandwhich: 'sandwich', sanwich: 'sandwich', sandwitch: 'sandwich', breakfest: 'breakfast', brekfast: 'breakfast',
  deserts: 'desserts', desert: 'dessert', suger: 'sugar', sugr: 'sugar', buter: 'butter', buttter: 'butter', eggz: 'eggs',
  egs: 'eggs', mik: 'milk', milke: 'milk', chiken: 'chicken', chikken: 'chicken', chicekn: 'chicken', chickin: 'chicken', beaf: 'beef',
  onoin: 'onion', onian: 'onion', garlick: 'garlic', galic: 'garlic', peper: 'pepper', pepperoni: 'pepperoni', ketchap: 'ketchup',
  mayonaise: 'mayonnaise', mayonase: 'mayonnaise', oatmeel: 'oatmeal', pancaks: 'pancakes', pankakes: 'pancakes', waffels: 'waffles',
  cereals: 'cereals', strawbery: 'strawberry', strawberrys: 'strawberries', blueberrys: 'blueberries', bluberries: 'blueberries',
  rasberry: 'raspberry', rasberries: 'raspberries', pinapple: 'pineapple', pinaple: 'pineapple', lemmon: 'lemon', lemonaid: 'lemonade',
  tablespon: 'tablespoon', tablespoom: 'tablespoon', teaspon: 'teaspoon', teespoon: 'teaspoon', ounze: 'ounce', ounse: 'ounce',
  preheat: 'preheat', pre_heat: 'preheat', tempature: 'temperature', temprature: 'temperature', temperture: 'temperature',
  minuets: 'minutes', minites: 'minutes', mintues: 'minutes', minuts: 'minutes', secounds: 'seconds', untill_golden: 'until golden',
  stirr: 'stir', whisk: 'whisk', wisk: 'whisk', bowel: 'bowl', boel: 'bowl', pann: 'pan', ovan: 'oven', oven: 'oven', fridge: 'fridge',
  refridgerator: 'refrigerator', refrigerater: 'refrigerator', freezor: 'freezer', microwavve: 'microwave', microwve: 'microwave',
  delicous: 'delicious', delicios: 'delicious', delishus: 'delicious', yummmy: 'yummy', favorit: 'favorite', favourit: 'favourite',
  childen: 'children', childern: 'children', kidz: 'kids', familly: 'family', famly: 'family', healty: 'healthy', helthy: 'healthy',
  luv: 'love', luvs: 'loves', yumm: 'yum', im: "I'm", dont: "don't", doesnt: "doesn't", cant: "can't", wont: "won't", isnt: "isn't", didnt: "didn't", youre: "you're", thats: "that's",
  i: 'I',
};

function matchCase(original, fixed) {
  if (original === original.toUpperCase() && original.length > 1 && fixed !== 'I') return fixed.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1);
  return fixed;
}

function fixWords(text) {
  return text.replace(/[A-Za-z]+/g, (w) => {
    const fix = TYPOS[w.toLowerCase()];
    return fix && fix !== w.toLowerCase() ? matchCase(w, fix) : w;
  });
}

const tidy = (t) => String(t || '').replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/([,.!?;:])(?=[A-Za-z])/g, '$1 ').trim();
const capitalize = (t) => t.replace(/^([^A-Za-z]*)([a-z])/, (_, a, b) => a + b.toUpperCase());
const sentenceCase = (t) => capitalize(t).replace(/([.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase());
const endSentence = (t) => (t && !/[.!?)…:]$/.test(t) ? `${t}.` : t);
// Fixes "1/2 cup" style lines without touching amounts; "2 nuts" stays "2 nuts".
const fixLine = (t) => tidy(fixWords(t));

/** Built-in fixer: misspellings, spacing, capitals and full stops. */
export function localPolish(r) {
  return {
    ...r,
    title: capitalize(fixLine(r.title)),
    description: r.description ? endSentence(sentenceCase(fixLine(r.description))) : '',
    ingredients: r.ingredients.map((x) => fixLine(x)),
    steps: r.steps.map((x) => endSentence(sentenceCase(fixLine(x)))),
  };
}

// Numbers and fractions in a line ("1 1/2", "350", "½") must be identical after fixing.
const numbersOf = (t) => (String(t).match(/\d+(?:[./]\d+)?|[¼½¾⅓⅔⅛]/g) || []).join(' ');
const safeLine = (before, after) => typeof after === 'string' && after.trim() && numbersOf(before) === numbersOf(after)
  && after.length <= Math.max(before.length * 1.6, before.length + 40) ? after.trim() : before;

const PROOFREAD = `You are a careful proofreader for a family recipe site. Fix spelling, grammar, capital letters and punctuation in the recipe you're given.
Rules:
- Do NOT change meaning, amounts, numbers, units, ingredients, cooking times or temperatures. Do not add or remove ingredients or steps, and do not add advice.
- Keep the same number of ingredients and steps, in the same order. Keep it short and in the author's voice.
- Title in Title Case. Steps and description as full sentences ending with a full stop. Ingredient lines stay short (no full stop).
Answer with ONLY JSON: {"title": string, "description": string, "ingredients": [string], "steps": [string]}`;

/**
 * Returns { recipe, fixes, by } where fixes is how many fields changed and by is "ai" or "basic".
 */
export async function polishRecipe(r) {
  const base = localPolish(r);
  let out = base;
  let by = 'basic';
  try {
    const ai = await askJSON([
      { role: 'system', content: PROOFREAD },
      { role: 'user', content: JSON.stringify({ title: base.title, description: base.description, ingredients: base.ingredients, steps: base.steps }) },
    ], { timeoutMs: 9_000, budgetMs: 10_000, temperature: 0.1, maxTokens: 1500 });
    if (ai && Array.isArray(ai.ingredients) && Array.isArray(ai.steps) && ai.ingredients.length === base.ingredients.length && ai.steps.length === base.steps.length) {
      out = {
        ...base,
        title: safeLine(base.title, ai.title).slice(0, 100),
        description: base.description ? safeLine(base.description, ai.description).slice(0, 1000) : '',
        ingredients: base.ingredients.map((x, i) => safeLine(x, ai.ingredients[i]).slice(0, 300)),
        steps: base.steps.map((x, i) => safeLine(x, ai.steps[i]).slice(0, 300)),
      };
      by = 'ai';
    }
  } catch { /* AI not set up or busy: the basic fixes still apply */ }
  const fields = (x) => [x.title, x.description, ...x.ingredients, ...x.steps];
  const before = fields(r);
  const fixes = fields(out).filter((v, i) => v !== before[i]).length;
  return { recipe: out, fixes, by };
}
