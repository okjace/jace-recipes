import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moderateRecipe, moderateName } from '../lib/moderation.js';

const base = { title: 'Test', description: '', category: 'Dinner', ingredients: ['1 cup rice'], steps: ['Cook it.'] };

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
  const r = moderateRecipe({ ...base, ingredients: ['ginger', '1 cup buttermilk'], steps: ['Heat a skillet.', 'Use this method.'] });
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
