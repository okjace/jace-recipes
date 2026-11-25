// Jace Recipes auto-moderation.
//
// Every recipe (and every username / display name) passes through here.
// The result is one of three decisions:
//   allow  - published right away
//   review - held in the moderation queue until @okjace approves it
//   block  - rejected, the author sees the reasons and can fix the recipe
// Recipes can also pick up automatic "safety notes" (food-safety tips) that
// are shown on the recipe page.
//
// Lists are intentionally easy to extend: add a word to the right list below.

// Turn leetspeak and separators into plain letters so "b1e@ch" still matches.
function normalize(text) {
  const base = String(text || '').toLowerCase();
  // "1" and "|" can stand for "i" or "l", so check both readings.
  const read = (one) => base
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, one)
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const i = read('i');
  const l = read('l');
  return i === l ? i : `${i} \n ${l}`;
}

function has(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(^|[^a-z])${escaped}(s|es)?([^a-z]|$)`).test(text);
}

// Not food. Never allowed in a recipe.
const DANGEROUS = [
  'bleach', 'ammonia', 'antifreeze', 'ethylene glycol', 'gasoline', 'kerosene',
  'lighter fluid', 'drain cleaner', 'oven cleaner', 'laundry detergent',
  'laundry pod', 'tide pod', 'detergent pod', 'dishwasher detergent',
  'rubbing alcohol', 'isopropyl', 'methanol', 'wood alcohol', 'mercury',
  'arsenic', 'cyanide', 'rat poison', 'pesticide', 'insecticide', 'weed killer',
  'paint thinner', 'turpentine', 'acetone', 'nail polish remover', 'motor oil',
  'windshield washer', 'mothball', 'hand sanitizer', 'sanitizer', 'lead paint',
  'death cap', 'amanita', 'oleander', 'foxglove', 'hemlock', 'nightshade berries',
  'silica gel', 'battery acid', 'glue', 'superglue', 'chlorine',
];

// Drugs - not appropriate on a family recipe site.
const DRUGS = [
  'cannabis', 'marijuana', 'thc', 'weed brownie', 'pot brownie', 'edible gummies',
  'magic mushroom', 'psilocybin', 'shrooms', 'cocaine', 'meth', 'lsd', 'kratom',
  'sleeping pill', 'melatonin gummies', 'cough syrup', 'ambien', 'xanax',
];

// Keep it family friendly. Extend as needed.
const PROFANITY = [
  'fuck', 'fucking', 'fucker', 'shit', 'shitty', 'bitch', 'bastard', 'asshole',
  'dick', 'cunt', 'piss', 'slut', 'whore', 'porn', 'nude', 'nudes', 'sex',
  'motherfucker', 'bullshit', 'wtf', 'stfu', 'dumbass', 'jackass', 'retard',
];

// Words that might be fine in context but need a human to look.
const NEEDS_REVIEW = [
  'lye', 'borax', 'hydrogen peroxide', 'raw kidney beans', 'apricot kernel',
  'bitter almond', 'wild mushroom', 'foraged mushroom', 'pufferfish', 'fugu',
  'raw milk', 'poison', 'poisonous', 'toxic', 'kill', 'suicide', 'self harm',
  'weapon', 'gun', 'knife fight', 'diet pill', 'laxative', 'detox tea',
];

const ALCOHOL = [
  'vodka', 'rum', 'whiskey', 'whisky', 'bourbon', 'tequila', 'gin', 'brandy',
  'cognac', 'liqueur', 'schnapps', 'beer', 'wine', 'champagne', 'prosecco',
  'sake', 'cider vinegar', // filtered out below, vinegar is fine
];

function scanList(text, list) {
  return list.filter((term) => has(text, term));
}

/**
 * Moderate a recipe.
 * @param {object} r  { title, description, ingredients[], steps[], category }
 * @param {string[]} jaceBlockedTerms  extra terms from Jace's own auto moderation (Manage account → Moderation)
 * @returns {{decision:'allow'|'review'|'block', reasons:string[], safetyNotes:string[]}}
 */
function moderateRecipe(r, jaceBlockedTerms = []) {
  const ingredients = (r.ingredients || []).join(' \n ');
  const all = normalize([r.title, r.description, ingredients, (r.steps || []).join(' \n ')].join(' \n '));
  const ing = normalize(ingredients);
  const reasons = [];
  const review = [];
  const safetyNotes = [];

  const danger = scanList(all, DANGEROUS);
  if (danger.length) reasons.push(`Contains something that isn't food and isn't safe to eat: ${danger.join(', ')}.`);

  const drugs = scanList(all, DRUGS);
  if (drugs.length) reasons.push(`Drug-related content isn't allowed on Jace Recipes: ${drugs.join(', ')}.`);

  const jaceHits = scanList(all, jaceBlockedTerms.map((t) => normalize(t)).filter(Boolean));
  if (jaceHits.length) reasons.push('Contains words blocked by Jace auto moderation.');

  const swears = scanList(all, PROFANITY);
  if (swears.length) reasons.push('Please keep recipes family friendly (no bad language).');

  const raw = String([r.title, r.description, ingredients, (r.steps || []).join(' ')].join(' '));
  const links = (raw.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 2) reasons.push('Too many links. Recipes should not be ads or spam.');
  else if (links > 0) review.push('Contains a link.');

  if (/(.)\1{9,}/.test(raw)) reasons.push('Looks like spam (repeated characters).');

  const letters = raw.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) {
    review.push('Mostly written in capital letters.');
  }

  const flagged = scanList(all, NEEDS_REVIEW);
  if (flagged.length) review.push(`Mentions something a moderator should double-check: ${flagged.join(', ')}.`);

  if (!(r.ingredients || []).length) reasons.push('Add at least one ingredient.');
  if (!(r.steps || []).length) reasons.push('Add at least one step.');

  // Low-effort or vague recipes: a person should check they're real recipes.
  const titleWords = normalize(r.title).split(/\s+/).filter(Boolean);
  if (VAGUE_TITLES.includes(normalize(r.title).replace(/\n.*$/, '').trim()) || (titleWords.length === 1 && titleWords[0].length <= 4)) {
    review.push(`The title “${String(r.title).slice(0, 40)}” doesn't say what the dish is.`);
  }
  const stepText = (r.steps || []).join(' ').trim();
  if ((r.steps || []).length && stepText.length < 40) review.push('The steps are too short for someone else to follow.');
  if ((r.ingredients || []).length === 1 && (r.steps || []).length === 1) review.push('Only one ingredient and one step.');

  // ---- Automatic safety notes (not blocking) ----
  const booze = scanList(ing, ALCOHOL).filter((t) => t !== 'cider vinegar' && !has(ing, `${t} vinegar`));
  if (booze.length) {
    safetyNotes.push('Contains alcohol. Not for kids, and alcohol does not fully cook off.');
    if (r.category === 'Baby & Toddler') reasons.push('Baby & Toddler recipes cannot contain alcohol.');
  }
  if (has(ing, 'chicken') || has(ing, 'turkey')) safetyNotes.push('Cook chicken and turkey to 165°F (74°C) inside.');
  if (has(ing, 'ground beef') || has(ing, 'hamburger') || has(ing, 'ground pork')) safetyNotes.push('Cook ground meat to 160°F (71°C) inside.');
  if (has(ing, 'pork')) safetyNotes.push('Cook whole cuts of pork to 145°F (63°C) and let rest 3 minutes.');
  if (has(ing, 'egg') && /no bake|no-bake|raw|uncooked|cookie dough|mousse|eggnog/.test(all)) {
    safetyNotes.push('Raw eggs can carry salmonella. Use pasteurized eggs, especially for kids.');
  }
  if (has(ing, 'flour') && /edible cookie dough|raw dough|no bake|no-bake/.test(all)) {
    safetyNotes.push('Raw flour is not safe to eat. Heat-treat it to 165°F first.');
  }
  if (has(ing, 'honey')) {
    if (r.category === 'Baby & Toddler') safetyNotes.push('Never give honey to babies under 12 months (botulism risk).');
    else safetyNotes.push('Not for babies under 12 months: contains honey.');
  }
  if (r.category === 'Baby & Toddler') {
    const choking = ['whole grape', 'grapes', 'popcorn', 'whole nut', 'peanuts', 'hot dog', 'marshmallow', 'hard candy', 'cherry tomato', 'cherry tomatoes'];
    const hits = choking.filter((t) => has(ing, t));
    if (hits.length) safetyNotes.push(`Choking hazard for little ones (${hits.join(', ')}): cut small or quarter lengthwise.`);
  }
  const allergens = [
    ['peanut', 'peanut'], ['tree nuts', 'almond'], ['tree nuts', 'walnut'], ['tree nuts', 'cashew'], ['tree nuts', 'pecan'],
    ['tree nuts', 'nut'], ['tree nuts', 'hazelnut'], ['tree nuts', 'pistachio'], ['tree nuts', 'macadamia'], ['tree nuts', 'mixed nuts'], ['tree nuts', 'nutella'],
    ['milk', 'milk'], ['milk', 'butter'], ['milk', 'cheese'], ['milk', 'cheddar'], ['milk', 'mozzarella'], ['milk', 'parmesan'], ['milk', 'yogurt'], ['milk', 'cream'], ['eggs', 'egg'], ['wheat', 'flour'], ['wheat', 'bread'], ['wheat', 'pasta'], ['wheat', 'tortilla'],
    ['soy', 'soy'], ['fish', 'salmon'], ['fish', 'tuna'], ['shellfish', 'shrimp'], ['sesame', 'sesame'],
  ];
  const ingNoNutButters = ing.replace(/(peanut|almond|apple|cashew|sunflower|cocoa|shea) butter/g, '$1');
  const found = [...new Set(allergens.filter(([, w]) => has(w === 'butter' ? ingNoNutButters : ing, w)).map(([a]) => a))];
  if (found.length) safetyNotes.push(`Allergens: ${found.join(', ')}.`);
  if (/deep fr|hot oil|frying oil/.test(all)) safetyNotes.push('Hot oil: adults only at the stove.');
  if (r.category !== 'Baby & Toddler' && WHOLE_NUTS.some((t) => has(ing, t)) && !/(chopped|ground|crushed|butter|flour|milk|meal)/.test(ing)) {
    safetyNotes.push('Whole nuts are a choking hazard for children under 4. Chop them or leave them out for little ones.');
  }
  if (has(ing, 'chocolate') || has(ing, 'chocolate chip')) safetyNotes.push('Chocolate often contains milk and soy, and may be made near nuts. Check the label for allergies.');

  const checks = [
    danger.length ? null : 'No unsafe or non-food ingredients',
    drugs.length || swears.length || jaceHits.length ? null : 'Family-friendly language',
    links ? null : 'No links or spam',
    found.length ? `Allergens found: ${found.join(', ')}` : 'No common allergens found in the ingredients',
  ].filter(Boolean);

  let decision = 'allow';
  if (reasons.length) decision = 'block';
  else if (review.length) decision = 'review';
  return { decision, reasons: decision === 'block' ? reasons : review, safetyNotes: [...new Set(safetyNotes)], allergens: found, checks };
}

const VAGUE_TITLES = ['eat', 'food', 'yum', 'yummy', 'test', 'testing', 'recipe', 'my recipe', 'stuff', 'thing', 'good', 'good food', 'snack', 'meal', 'dinner', 'lunch', 'breakfast', 'asdf', 'idk', 'untitled', 'new recipe', 'something'];
const WHOLE_NUTS = ['nut', 'peanut', 'almond', 'walnut', 'cashew', 'pecan', 'hazelnut', 'pistachio', 'macadamia', 'mixed nuts'];

/**
 * Moderates a comment. block = not posted; review = waits for @okjace.
 * @returns {{decision:'allow'|'review'|'block', reasons:string[]}}
 */
function moderateComment(text, jaceBlockedTerms = []) {
  const n = normalize(text);
  const raw = String(text || '');
  const reasons = [];
  const review = [];
  if (scanList(n, PROFANITY).length) reasons.push('Please keep comments family friendly (no bad language).');
  if (scanList(n, jaceBlockedTerms.map((t) => normalize(t)).filter(Boolean)).length) reasons.push('Contains words blocked by Jace auto moderation.');
  if (scanList(n, DRUGS).length) reasons.push('Drug-related content isn’t allowed on Jace Recipes.');
  const links = (raw.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 1) reasons.push('Too many links.');
  else if (links === 1) review.push('Contains a link.');
  if (/(.)\1{9,}/.test(raw)) reasons.push('Looks like spam (repeated characters).');
  const letters = raw.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) review.push('Mostly written in capital letters.');
  const danger = scanList(n, DANGEROUS);
  if (danger.length) review.push(`Mentions something that isn't food: ${danger.join(', ')}.`);
  if (scanList(n, ['kill', 'suicide', 'self harm', 'weapon', 'gun', 'hate you', 'stupid', 'idiot', 'ugly', 'loser', 'shut up']).length) review.push('Might be unkind.');
  const decision = reasons.length ? 'block' : review.length ? 'review' : 'allow';
  return { decision, reasons: decision === 'block' ? reasons : review };
}

function moderateName(name, jaceBlockedTerms = []) {
  const n = normalize(name);
  if (scanList(n, jaceBlockedTerms.map((t) => normalize(t)).filter(Boolean)).length) return 'Please pick a family-friendly name.';
  if (scanList(n, PROFANITY).length || scanList(n.replace(/\s/g, ''), PROFANITY).length) return 'Please pick a family-friendly name.';
  if (scanList(n, DRUGS).length) return 'Please pick a family-friendly name.';
  return null;
}

export { moderateRecipe, moderateName, moderateComment, normalize };
