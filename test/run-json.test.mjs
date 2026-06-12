// Tests for the `hands run --json` output contract — the single JSON
// line scripts parse. Pure formatter, no agent loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRunJson, EXIT_TASK_FAILED } from '../dist/run.js';

const BASE = {
  text: 'Notepad is open.',
  inputTokens: 900,
  outputTokens: 120,
  costUsd: 0.012,
  turns: 3,
};

test('formatRunJson — one parseable line with the stable field set', () => {
  const line = formatRunJson({ ...BASE, sessionId: 'sess-1', ok: true }, 'cli');
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed, {
    ok: true,
    mode: 'cli',
    result: 'Notepad is open.',
    turns: 3,
    costUsd: 0.012,
    tokens: { input: 900, output: 120 },
    sessionId: 'sess-1',
  });
});

test('formatRunJson — ok defaults to true when the stream did not say otherwise', () => {
  const parsed = JSON.parse(formatRunJson(BASE, 'sdk'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, 'sdk');
  assert.equal('sessionId' in parsed, false);
});

test('formatRunJson — ok=false propagates (max-turns cutoff, error subtype)', () => {
  const parsed = JSON.parse(formatRunJson({ ...BASE, ok: false }, 'cli'));
  assert.equal(parsed.ok, false);
});

test('formatRunJson — dryRun flag appears only when set', () => {
  assert.equal(JSON.parse(formatRunJson(BASE, 'sdk', true)).dryRun, true);
  assert.equal('dryRun' in JSON.parse(formatRunJson(BASE, 'sdk', false)), false);
  assert.equal('dryRun' in JSON.parse(formatRunJson(BASE, 'sdk')), false);
});

test('EXIT_TASK_FAILED — pinned: 0 success, 1 setup error, 2 task failure', () => {
  assert.equal(EXIT_TASK_FAILED, 2);
});
