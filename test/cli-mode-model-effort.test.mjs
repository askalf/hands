// buildClaudeArgs must PIN model and effort on the spawned `claude` child.
//
// Regression cover for a silent cost bug: CLI mode never passed --model or
// --effort, so every unattended `hands run` inherited whatever the human had
// last selected interactively in ~/.claude/settings.json. Switching to a
// 1M-context Opus at xhigh for personal use silently re-priced every headless
// run on the box too — and `-m/--model`, which the CLI advertises, did nothing
// in Claude Login mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs } from '../dist/cli-mode.js';
import { parseOverrides } from '../dist/util/cli-overrides.js';

const BASE = {
  prefixArgs: [],
  prompt: 'do the thing',
  systemPrompt: 'sys',
  maxTurns: 50,
  mcpConfigPath: '/tmp/mcp.json',
};

/** Value that follows `flag` in an argv array, or undefined if absent. */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('pins model and effort onto the child argv', () => {
  const args = buildClaudeArgs({ ...BASE, model: 'claude-sonnet-5', effort: 'medium' });
  assert.equal(valueAfter(args, '--model'), 'claude-sonnet-5');
  assert.equal(valueAfter(args, '--effort'), 'medium');
});

test('omits both flags when unset rather than passing empty values', () => {
  // An empty '--model' with no value would shift argv and make claude parse
  // the next flag as the model name.
  const args = buildClaudeArgs(BASE);
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--effort'));
});

test('model and effort survive a --resume, like every other re-passed flag', () => {
  // The claude CLI does not persist these across resumes, so a continued
  // session would silently drop back to the interactive default.
  const args = buildClaudeArgs({
    ...BASE,
    model: 'claude-sonnet-5',
    effort: 'medium',
    resumeSessionId: 'sess-123',
  });
  assert.equal(valueAfter(args, '--resume'), 'sess-123');
  assert.equal(valueAfter(args, '--model'), 'claude-sonnet-5');
  assert.equal(valueAfter(args, '--effort'), 'medium');
});

test('accepts every effort level the claude CLI documents', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const parsed = parseOverrides({ effort: level });
    assert.equal(parsed.ok, true, `${level} should be accepted`);
    assert.equal(parsed.overrides.effort, level);
  }
});

test('rejects an unknown effort level instead of persisting it', () => {
  // A bad level makes the child exit before a single turn; persisting it
  // would break every later run the same way.
  const parsed = parseOverrides({ effort: 'ultra' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.overrides.effort, undefined);
  assert.match(parsed.errors[0], /--effort must be one of/);
});
