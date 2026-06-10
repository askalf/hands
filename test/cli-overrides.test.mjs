import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverrides } from '../dist/util/cli-overrides.js';

test('empty input → ok with no overrides', () => {
  const r = parseOverrides({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.overrides, {});
  assert.deepEqual(r.errors, []);
});

test('valid model/budget/turns map to config field names', () => {
  const r = parseOverrides({ model: 'claude-opus-4-6', budget: '10.50', turns: '100' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.overrides, { model: 'claude-opus-4-6', maxBudgetUsd: 10.5, maxTurns: 100 });
});

test('non-numeric budget is rejected, not NaN', () => {
  const r = parseOverrides({ budget: 'abc' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /--budget/);
  assert.equal('maxBudgetUsd' in r.overrides, false);
});

test('zero and negative budget are rejected', () => {
  assert.equal(parseOverrides({ budget: '0' }).ok, false);
  assert.equal(parseOverrides({ budget: '-5' }).ok, false);
});

test('non-integer and non-numeric turns are rejected', () => {
  assert.equal(parseOverrides({ turns: '2.5' }).ok, false);
  assert.equal(parseOverrides({ turns: 'abc' }).ok, false);
  assert.equal(parseOverrides({ turns: '0' }).ok, false);
});

test('all errors are collected in one pass', () => {
  const r = parseOverrides({ budget: 'x', turns: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

test('valid fields survive alongside invalid ones', () => {
  const r = parseOverrides({ model: 'claude-sonnet-4-6', budget: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.overrides.model, 'claude-sonnet-4-6');
});
