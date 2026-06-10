import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSdkCredentials } from '../dist/run.js';

test('stored config key counts as a credential', () => {
  assert.equal(hasSdkCredentials('sk-ant-xxx', {}), true);
});

test('ANTHROPIC_API_KEY env counts as a credential (dario flow)', () => {
  assert.equal(hasSdkCredentials(undefined, { ANTHROPIC_API_KEY: 'dario' }), true);
});

test('ANTHROPIC_AUTH_TOKEN env counts as a credential', () => {
  assert.equal(hasSdkCredentials(undefined, { ANTHROPIC_AUTH_TOKEN: 'tok' }), true);
});

test('nothing stored and nothing in env → no credential', () => {
  assert.equal(hasSdkCredentials(undefined, {}), false);
  assert.equal(hasSdkCredentials(undefined, { ANTHROPIC_API_KEY: '' }), false);
});
