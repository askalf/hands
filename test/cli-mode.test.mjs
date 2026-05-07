// Unit tests for the CLI-mode prompt composer. Pure function — no
// child_process spawn, no Claude CLI dependency. Exercises the
// persona-vs-default branching and session-context preservation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeCliAppendPrompt } from '../dist/cli-mode.js';

const NO_PERSONA = undefined;
const SAMPLE_PERSONA = {
  prompt: 'You are a terse computer agent. No preamble.',
  source: 'bundled',
  label: 'concise',
};
const SESSION_CTX = '## Session History\n- Task: "open notepad" → SUCCESS (3 turns)';

test('composeCliAppendPrompt — no persona, no session context: full default prompt', () => {
  const r = composeCliAppendPrompt('linux', '', NO_PERSONA);
  // Default prompt mentions OS label, self-correction, anti-patterns
  assert.match(r, /Linux machine/);
  assert.match(r, /Self-Correction/);
  assert.match(r, /Anti-patterns/);
});

test('composeCliAppendPrompt — no persona, with session context: default + context', () => {
  const r = composeCliAppendPrompt('darwin', SESSION_CTX, NO_PERSONA);
  assert.match(r, /macOS machine/);
  assert.match(r, /Session History/);
  assert.match(r, /open notepad/);
});

test('composeCliAppendPrompt — persona set, no session context: just persona', () => {
  const r = composeCliAppendPrompt('linux', '', SAMPLE_PERSONA);
  assert.equal(r, SAMPLE_PERSONA.prompt);
});

test('composeCliAppendPrompt — persona set with session context: persona + context', () => {
  const r = composeCliAppendPrompt('linux', SESSION_CTX, SAMPLE_PERSONA);
  assert.match(r, /terse computer agent/);
  assert.match(r, /Session History/);
  // OS-aware default should NOT appear when persona overrides it
  assert.doesNotMatch(r, /Linux machine/);
  assert.doesNotMatch(r, /Self-Correction/);
});

test('composeCliAppendPrompt — persona drops OS-aware default on every platform', () => {
  for (const plat of ['win32', 'darwin', 'linux']) {
    const r = composeCliAppendPrompt(plat, '', SAMPLE_PERSONA);
    assert.doesNotMatch(r, /Windows machine/);
    assert.doesNotMatch(r, /macOS machine/);
    assert.doesNotMatch(r, /Linux machine/);
  }
});

test('composeCliAppendPrompt — persona ordering: persona first, context second', () => {
  const r = composeCliAppendPrompt('linux', SESSION_CTX, SAMPLE_PERSONA);
  const personaIdx = r.indexOf('terse');
  const contextIdx = r.indexOf('Session History');
  assert.ok(personaIdx >= 0 && contextIdx >= 0);
  assert.ok(personaIdx < contextIdx, 'persona prompt should come before session context');
});
