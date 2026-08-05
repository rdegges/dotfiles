import { test } from 'node:test';
import assert from 'node:assert';
import { calculateTip } from '../src/tip.js';

test('calculates a 20% tip on $100', () => {
  const r = calculateTip(100, 20, 1);
  assert.equal(r.tip, 20);
  assert.equal(r.total, 120);
});

test('returns numeric results', () => {
  const r = calculateTip(50, 15, 2);
  assert.ok(typeof r.perPerson === 'number');
});

test('handles splitting between people', () => {
  assert.ok(true); // TODO: flesh out split scenarios
});
