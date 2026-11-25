import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moderateRecipe, moderateName } from '../lib/moderation.js';

const base = { title: 'Simple Rice Bowl', description: '', category: 'Dinner', ingredients: ['1 cup rice', '2 cups water'], steps: ['Rinse the rice and add it to a pot with the water.', 'Simmer covered for 18 minutes, then fluff with a fork.'] };

test('allows a normal recipe', () => {
  assert.equal(moderateRecipe(base).decision, 'allow');
});

test('blocks dangerous non-food items, even in leetspeak', () => {
  assert.equal(moderateRecipe({ ...base, ingredients: ['1 cup bleach'] }).decision, 'block');
  assert.equal(moderateRecipe({ ...base, ingredients: ['1 cup b1e@ch'] }).decision, 'block');
  assert.equal(moderateRecipe({ ...base, steps: ['Add a tide pod'] }).decision, 'block');
});

test('blocks drugs and bad language', () => {
  assert.equal(moderateRecipe({ ...base, title: 'Pot brownie' }).decision, 'block');
  assert.equal(moderateRecipe({ ...base, description: 'this is shit' }).decision, 'block');
});

test('blocks terms from Jace auto moderation', () => {
  assert.equal(moderateRecipe({ ...base, description: 'mockbadword' }, ['mockbadword']).decision, 'block');
});

test('holds things a person should check', () => {
  assert.equal(moderateRecipe({ ...base, ingredients: ['food grade lye'] }).decision, 'review');
  assert.equal(moderateRecipe({ ...base, description: 'see https://example.com' }).decision, 'review');
});

test('no false positives on ginger, skillet, method, buttermilk', () => {
  const r = moderateRecipe({ ...base, ingredients: ['ginger', '1 cup buttermilk'], steps: ['Heat a skillet over medium heat.', 'Use this method to toast the ginger.'] });
  assert.equal(r.decision, 'allow');
});

test('adds safety notes', () => {
  const r = moderateRecipe({ ...base, category: 'Baby & Toddler', ingredients: ['1 lb chicken', '1 tbsp honey', 'grapes', '2 tbsp peanut butter'] });
  const notes = r.safetyNotes.join(' ');
  assert.match(notes, /165°F/);
  assert.match(notes, /12 months/);
  assert.match(notes, /Choking/);
  assert.match(notes, /peanut/);
  assert.doesNotMatch(notes, /milk/); // peanut butter isn't dairy
});

test('no alcohol in baby recipes, wine vinegar is fine', () => {
  assert.equal(moderateRecipe({ ...base, category: 'Baby & Toddler', ingredients: ['1 tbsp rum'] }).decision, 'block');
  assert.equal(moderateRecipe({ ...base, ingredients: ['red wine vinegar'] }).safetyNotes.some((n) => /alcohol/.test(n)), false);
});

test('names must be family friendly', () => {
  assert.equal(moderateName('Super Mom'), null);
  assert.ok(moderateName('sh1t cook'));
});

test('vague or low-effort recipes wait for review', () => {
  const r = moderateRecipe({ title: 'eat', category: 'Breakfast', ingredients: ['2 nuts', '3 chocolate chips'], steps: ['put 2 nuts in', 'put 3 chocolate chips in'] });
  assert.equal(r.decision, 'review');
  assert.ok(r.reasons.some((x) => /title/.test(x)));
  assert.ok(r.reasons.some((x) => /steps/.test(x)));
  assert.deepEqual(r.allergens, ['tree nuts']);
  assert.ok(r.safetyNotes.some((n) => /choking/i.test(n)));
  assert.ok(r.safetyNotes.some((n) => /Chocolate/.test(n)));
});

test('"nut" does not match nutmeg, coconut or donuts', () => {
  assert.deepEqual(moderateRecipe({ ...base, ingredients: ['1 tsp nutmeg', 'coconut', '2 donuts'] }).allergens, []);
});

test('comments are moderated', async () => {
  const { moderateComment } = await import('../lib/moderation.js');
  assert.equal(moderateComment('My kids loved this, thank you!').decision, 'allow');
  assert.equal(moderateComment('this is sh1t').decision, 'block');
  assert.equal(moderateComment('see www.example.com').decision, 'review');
  assert.equal(moderateComment('you are an idiot').decision, 'review');
});

test('spelling fixes never change amounts', async () => {
  const { localPolish } = await import('../lib/polish.js');
  const r = localPolish({ title: 'choclate milk', description: 'my kids luv it', ingredients: ['1/2 cup suger', '2 cups mik'], steps: ['stir teh milk  ,then serve'] });
  assert.equal(r.title, 'Chocolate milk');
  assert.equal(r.description, 'My kids love it.');
  assert.deepEqual(r.ingredients, ['1/2 cup sugar', '2 cups milk']);
  assert.deepEqual(r.steps, ['Stir the milk, then serve.']);
});
