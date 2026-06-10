import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../dist/util/redact.js';

test('vendor token shapes are scrubbed', () => {
  assert.equal(redactSecrets('key is sk-ant-api03-AbCdEf123456789'), 'key is [REDACTED:anthropic-key]');
  assert.match(redactSecrets('ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7xC0qRsTuV'), /\[REDACTED:github-token\]/);
  assert.match(redactSecrets('github_pat_11AAAAAAA0aaaaaaaaaaaaaaaa'), /\[REDACTED:github-pat\]/);
  assert.match(redactSecrets('AKIAIOSFODNN7EXAMPLE'), /\[REDACTED:aws-key-id\]/);
  assert.match(redactSecrets('xoxb-1234567890-abcdefghij'), /\[REDACTED:slack-token\]/);
});

test('JWTs and bearer headers are scrubbed', () => {
  assert.match(
    redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'),
    /\[REDACTED:jwt\]/,
  );
  assert.equal(
    redactSecrets('Authorization: Bearer abcdef1234567890abcdef'),
    'Authorization: Bearer [REDACTED]',
  );
});

test('secret-named assignments are scrubbed, value name preserved', () => {
  assert.equal(redactSecrets('password=hunter2hunter2'), 'password=[REDACTED]');
  assert.equal(redactSecrets('export API_KEY="abc123def456"'), 'export API_KEY="[REDACTED]"');
  assert.equal(redactSecrets('token: supersecretvalue'), 'token: [REDACTED]');
});

test('ordinary text passes through untouched', () => {
  const benign = 'open notepad and type hello world, then run git status';
  assert.equal(redactSecrets(benign), benign);
  assert.equal(redactSecrets('the word token appears alone'), 'the word token appears alone');
});
