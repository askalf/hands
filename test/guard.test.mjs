// Tests for src/util/guard.ts — the decision engine behind `hands run
// --guard`. The pure helpers (classifyToolUse, previewToolUse,
// parseGuardAnswer) are tested directly; GuardController.decide is driven
// with a scripted answer queue so the prompt loop is exercised without a
// real terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyToolUse,
  previewToolUse,
  parseGuardAnswer,
  GuardController,
} from '../dist/util/guard.js';

// ── classifyToolUse ─────────────────────────────────────────────────

test('classifyToolUse — passive computer actions are read-only', () => {
  for (const action of ['screenshot', 'zoom', 'mouse_move', 'wait', 'cursor_position']) {
    assert.equal(classifyToolUse('computer', { action }), 'read-only', `${action} should be read-only`);
  }
});

test('classifyToolUse — acting computer actions are state-changing', () => {
  for (const action of ['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'scroll', 'left_click_drag', 'hold_key']) {
    assert.equal(classifyToolUse('computer', { action }), 'state-changing', `${action} should be state-changing`);
  }
});

test('classifyToolUse — text editor view is read-only, mutations are not', () => {
  assert.equal(classifyToolUse('str_replace_based_edit_tool', { command: 'view' }), 'read-only');
  for (const command of ['create', 'str_replace', 'insert']) {
    assert.equal(classifyToolUse('str_replace_based_edit_tool', { command }), 'state-changing');
  }
});

test('classifyToolUse — read_page / find_files are read-only; bash + unknown are state-changing', () => {
  assert.equal(classifyToolUse('read_page', { url: 'https://x' }), 'read-only');
  assert.equal(classifyToolUse('find_files', { path: '.' }), 'read-only');
  assert.equal(classifyToolUse('bash', { command: 'ls' }), 'state-changing');
  assert.equal(classifyToolUse('something_new', {}), 'state-changing');
});

test('classifyToolUse — ui_tree is read-only; click_element is state-changing', () => {
  assert.equal(classifyToolUse('ui_tree', { filter: 'save' }), 'read-only');
  assert.equal(classifyToolUse('click_element', { name: 'Save' }), 'state-changing');
});

// ── previewToolUse ──────────────────────────────────────────────────

test('previewToolUse — renders a readable one-liner per tool', () => {
  assert.match(previewToolUse('bash', { command: 'Remove-Item ./tmp -Recurse' }), /^bash: Remove-Item/);
  assert.match(previewToolUse('computer', { action: 'type', text: 'hello world' }), /computer type: hello world/);
  assert.match(previewToolUse('computer', { action: 'left_click', coordinate: [100, 200] }), /computer left_click @ \(100, 200\)/);
  assert.match(previewToolUse('str_replace_based_edit_tool', { command: 'create', path: '/tmp/x' }), /edit create: \/tmp\/x/);
  assert.equal(previewToolUse('click_element', { name: 'Save', role: 'Button' }), 'click element: "Save" [Button]');
  assert.equal(previewToolUse('click_element', { name: 'File' }), 'click element: "File"');
});

test('previewToolUse — collapses whitespace and truncates long commands', () => {
  const long = 'echo ' + 'a'.repeat(300);
  const p = previewToolUse('bash', { command: long });
  assert.ok(p.length < long.length, 'should be truncated');
  assert.match(p, /…$/);
});

// ── parseGuardAnswer ────────────────────────────────────────────────

test('parseGuardAnswer — A is always, a is allow once (case-sensitive)', () => {
  assert.equal(parseGuardAnswer('A'), 'always');
  assert.equal(parseGuardAnswer('a'), 'allow');
});

test('parseGuardAnswer — synonyms map correctly', () => {
  assert.equal(parseGuardAnswer('y'), 'allow');
  assert.equal(parseGuardAnswer('yes'), 'allow');
  assert.equal(parseGuardAnswer('allow'), 'allow');
  assert.equal(parseGuardAnswer('d'), 'deny');
  assert.equal(parseGuardAnswer('n'), 'deny');
  assert.equal(parseGuardAnswer('no'), 'deny');
  assert.equal(parseGuardAnswer('e'), 'edit');
  assert.equal(parseGuardAnswer('edit'), 'edit');
  assert.equal(parseGuardAnswer('q'), 'abort');
  assert.equal(parseGuardAnswer('quit'), 'abort');
  assert.equal(parseGuardAnswer('always'), 'always');
});

test('parseGuardAnswer — bare Enter and gibberish are unknown (no accidental fire)', () => {
  assert.equal(parseGuardAnswer(''), 'unknown');
  assert.equal(parseGuardAnswer('   '), 'unknown');
  assert.equal(parseGuardAnswer('huh'), 'unknown');
});

// ── GuardController.decide ──────────────────────────────────────────

function makeIo(answers) {
  const state = { asked: [], outs: [], i: 0 };
  return {
    ask: async (prompt) => { state.asked.push(prompt); return answers[state.i++] ?? ''; },
    out: (m) => state.outs.push(m),
    state,
  };
}

const call = (over = {}) => ({ tool: 'bash', action: undefined, input: { command: 'ls' }, preview: 'bash: ls', ...over });

test('decide — allow once increments allowed and returns allow', async () => {
  const io = makeIo(['a']);
  const g = new GuardController(io);
  const d = await g.decide(call());
  assert.deepEqual(d, { kind: 'allow' });
  assert.equal(g.allowed, 1);
  assert.equal(g.denied, 0);
});

test('decide — deny increments denied', async () => {
  const io = makeIo(['d']);
  const g = new GuardController(io);
  const d = await g.decide(call());
  assert.equal(d.kind, 'deny');
  assert.equal(g.denied, 1);
});

test('decide — abort returns abort', async () => {
  const io = makeIo(['q']);
  const g = new GuardController(io);
  assert.equal((await g.decide(call())).kind, 'abort');
});

test('decide — Always allow suppresses later prompts for the same tool', async () => {
  const io = makeIo(['A']); // only one answer; the second call must not prompt
  const g = new GuardController(io);
  assert.equal((await g.decide(call({ input: { command: 'ls' }, preview: 'bash: ls' }))).kind, 'allow');
  assert.equal((await g.decide(call({ input: { command: 'pwd' }, preview: 'bash: pwd' }))).kind, 'allow');
  assert.equal(io.state.asked.length, 1, 'second bash call should be auto-allowed without a prompt');
  assert.equal(g.allowed, 2);
});

test('decide — Always is per-action for the computer tool', async () => {
  const io = makeIo(['A', 'd']); // always-allow left_click, then deny right_click
  const g = new GuardController(io);
  assert.equal((await g.decide(call({ tool: 'computer', action: 'left_click', input: { action: 'left_click' }, preview: 'c' }))).kind, 'allow');
  assert.equal((await g.decide(call({ tool: 'computer', action: 'left_click', input: { action: 'left_click' }, preview: 'c' }))).kind, 'allow');
  assert.equal((await g.decide(call({ tool: 'computer', action: 'right_click', input: { action: 'right_click' }, preview: 'c' }))).kind, 'deny');
  assert.equal(io.state.asked.length, 2, 'left_click prompted once, right_click prompted once');
});

test('decide — edit a bash command returns allow with the revised input', async () => {
  const io = makeIo(['e', 'rm ./tmp/cache']);
  const g = new GuardController(io);
  const d = await g.decide(call({ input: { command: 'rm -rf ./tmp' }, preview: 'bash: rm -rf ./tmp' }));
  assert.equal(d.kind, 'allow');
  assert.equal(d.input.command, 'rm ./tmp/cache');
  assert.equal(g.allowed, 1);
});

test('decide — empty edit keeps the original command', async () => {
  const io = makeIo(['e', '']);
  const g = new GuardController(io);
  const d = await g.decide(call({ input: { command: 'ls -la' }, preview: 'bash: ls -la' }));
  assert.equal(d.kind, 'allow');
  assert.equal(d.input.command, 'ls -la');
});

test('decide — edit a click_element retargets the click by name', async () => {
  const io = makeIo(['e', 'Save As']);
  const g = new GuardController(io);
  const d = await g.decide(call({ tool: 'click_element', action: undefined, input: { name: 'Save', role: 'Button' }, preview: 'click element: "Save" [Button]' }));
  assert.equal(d.kind, 'allow');
  assert.equal(d.input.name, 'Save As');
  assert.equal(d.input.role, 'Button', 'role rides along untouched');
});

test('decide — empty click_element edit keeps the original target', async () => {
  const io = makeIo(['e', '']);
  const g = new GuardController(io);
  const d = await g.decide(call({ tool: 'click_element', action: undefined, input: { name: 'Save' }, preview: 'click element: "Save"' }));
  assert.equal(d.kind, 'allow');
  assert.equal(d.input.name, 'Save');
});

test('decide — edit on a non-editable action re-prompts, then honors the next choice', async () => {
  const io = makeIo(['e', 'a']);
  const g = new GuardController(io);
  const d = await g.decide(call({ tool: 'computer', action: 'left_click', input: { action: 'left_click', coordinate: [1, 2] }, preview: 'c' }));
  assert.equal(d.kind, 'allow');
  assert.ok(io.state.outs.some((m) => /only supported/.test(m)), 'should explain edit is unsupported here');
  assert.equal(io.state.asked.length, 2);
});

test('decide — unknown input re-prompts until a real choice', async () => {
  const io = makeIo(['', 'huh', 'd']);
  const g = new GuardController(io);
  assert.equal((await g.decide(call())).kind, 'deny');
  assert.equal(io.state.asked.length, 3);
});

test('summary — reports the allow/deny tally', async () => {
  const io = makeIo(['a', 'd']);
  const g = new GuardController(io);
  await g.decide(call());
  await g.decide(call());
  assert.equal(g.summary(), 'guard: 1 allowed, 1 denied');
});
