// Tests for src/macros.ts — the crystallize model. Pure functions
// (validation, recordable filter, recorder, param substitution, the
// export-to-script compiler, step preview) are tested directly; the fs CRUD
// points at a throwaway HOME set BEFORE import (paths bake from homedir() at
// module load, same pattern as util/audit.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'hands-macros-test-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

const {
  isValidMacroName,
  isRecordable,
  MacroRecorder,
  applyMacroParams,
  macroToScript,
  previewStep,
  getMacrosDir,
  macroPath,
  saveMacro,
  loadMacro,
  deleteMacro,
  listMacroNames,
  listMacros,
} = await import('../dist/macros.js');

after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
});

// ── isValidMacroName ────────────────────────────────────────────────

test('isValidMacroName — accepts safe names, rejects traversal/junk', () => {
  for (const ok of ['morning', 'deploy-2', 'a_b', 'X']) assert.equal(isValidMacroName(ok), true, ok);
  for (const bad of ['', '../x', 'a/b', 'a.b', '-x', 'a'.repeat(65)]) assert.equal(isValidMacroName(bad), false, bad);
});

// ── isRecordable ────────────────────────────────────────────────────

test('isRecordable — captures effectful calls, skips reads', () => {
  assert.equal(isRecordable('bash', undefined, { command: 'ls' }), true);
  assert.equal(isRecordable('bash', undefined, { command: '' }), false, 'empty command not recordable');
  assert.equal(isRecordable('str_replace_based_edit_tool', undefined, { command: 'create' }), true);
  assert.equal(isRecordable('str_replace_based_edit_tool', undefined, { command: 'view' }), false, 'view is a read');
  assert.equal(isRecordable('computer', 'left_click', {}), true);
  assert.equal(isRecordable('computer', 'type', {}), true);
  assert.equal(isRecordable('computer', 'screenshot', {}), false);
  assert.equal(isRecordable('computer', 'mouse_move', {}), false);
  assert.equal(isRecordable('read_page', undefined, { url: 'x' }), false);
  assert.equal(isRecordable('find_files', undefined, {}), false);
});

test('isRecordable — semantic clicks record by name; ui_tree reads do not', () => {
  assert.equal(isRecordable('click_element', undefined, { name: 'Save', role: 'Button' }), true);
  assert.equal(isRecordable('click_element', undefined, { name: '' }), false, 'empty name not recordable');
  assert.equal(isRecordable('click_element', undefined, {}), false);
  assert.equal(isRecordable('ui_tree', undefined, { filter: 'save' }), false, 'tree read has no replay value');
});

// ── MacroRecorder ───────────────────────────────────────────────────

test('MacroRecorder — accumulates only effectful steps, in order', () => {
  const r = new MacroRecorder();
  r.record('computer', 'screenshot', {});            // skipped
  r.record('bash', undefined, { command: 'pull main' });
  r.record('read_page', undefined, { url: 'x' });    // skipped
  r.record('computer', 'left_click', { coordinate: [1, 2] });
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.steps.map((s) => s.tool), ['bash', 'computer']);
  assert.equal(r.steps[1].action, 'left_click');
});

// ── applyMacroParams ────────────────────────────────────────────────

test('applyMacroParams — substitutes across command/text/path fields; reports missing', () => {
  const macro = { name: 'm', steps: [
    { tool: 'bash', input: { command: 'deploy {{env}}' } },
    { tool: 'computer', action: 'type', input: { text: 'hi {{name=World}}' } },
  ] };
  const { macro: applied, missing } = applyMacroParams(macro, { name: 'Alf' });
  assert.equal(applied.steps[0].input.command, 'deploy {{env}}');
  assert.equal(applied.steps[1].input.text, 'hi Alf');
  assert.deepEqual(missing, ['env']);
});

test('applyMacroParams — substitutes a click_element target name', () => {
  const macro = { name: 'm', steps: [
    { tool: 'click_element', input: { name: '{{tab=General}}', role: 'TabItem' } },
  ] };
  const { macro: applied, missing } = applyMacroParams(macro, { tab: 'Privacy' });
  assert.equal(applied.steps[0].input.name, 'Privacy');
  assert.deepEqual(missing, []);
});

// ── macroToScript (the export compiler) ─────────────────────────────

test('macroToScript — POSIX: bash steps become commands, create becomes a heredoc', () => {
  const macro = { name: 'm', prompt: 'do x', steps: [
    { tool: 'bash', input: { command: 'mkdir -p ~/out' } },
    { tool: 'str_replace_based_edit_tool', input: { command: 'create', path: '/tmp/a.txt', file_text: 'hello' } },
  ] };
  const { language, script, scriptable, manual } = macroToScript(macro, 'linux');
  assert.equal(language, 'sh');
  assert.equal(scriptable, 2);
  assert.equal(manual, 0);
  assert.match(script, /#!\/usr\/bin\/env bash/);
  assert.match(script, /mkdir -p ~\/out/);
  assert.match(script, /cat > '\/tmp\/a\.txt' <<'HANDS_EOF'\nhello\nHANDS_EOF/);
});

test('macroToScript — win32 emits PowerShell; GUI steps become manual comments', () => {
  const macro = { name: 'm', steps: [
    { tool: 'bash', input: { command: 'Get-ChildItem' } },
    { tool: 'computer', action: 'left_click', input: { coordinate: [10, 20] } },
  ] };
  const { language, script, scriptable, manual } = macroToScript(macro, 'win32');
  assert.equal(language, 'powershell');
  assert.equal(scriptable, 1);
  assert.equal(manual, 1);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.match(script, /Get-ChildItem/);
  assert.match(script, /# \[manual\] computer:left_click/);
});

test('macroToScript — click_element becomes a manual comment naming the target', () => {
  const macro = { name: 'm', steps: [
    { tool: 'click_element', input: { name: 'Save', role: 'Button' } },
  ] };
  const { scriptable, manual, script } = macroToScript(macro, 'win32');
  assert.equal(scriptable, 0);
  assert.equal(manual, 1);
  assert.match(script, /# \[manual\] click_element "Save"/);
});

// ── previewStep ─────────────────────────────────────────────────────

test('previewStep — one-liners per tool', () => {
  assert.match(previewStep({ tool: 'bash', input: { command: 'npm test' } }), /^bash: npm test/);
  assert.match(previewStep({ tool: 'computer', action: 'left_click', input: { coordinate: [5, 6] } }), /left_click @ \(5, 6\)/);
  assert.match(previewStep({ tool: 'str_replace_based_edit_tool', input: { command: 'create', path: '/x' } }), /edit create: \/x/);
  assert.equal(previewStep({ tool: 'click_element', input: { name: 'Save', role: 'Button' } }), 'click element: "Save" [Button]');
});

// ── fs CRUD ─────────────────────────────────────────────────────────

test('getMacrosDir — under the redirected HOME', () => {
  assert.ok(getMacrosDir().startsWith(testHome));
});

test('saveMacro + loadMacro — round-trip with steps and metadata', async () => {
  const path = await saveMacro({ name: 'rt', prompt: 'do x', platform: 'linux', createdAt: 1234, steps: [{ tool: 'bash', input: { command: 'ls' } }] });
  assert.equal(path, macroPath('rt'));
  const loaded = await loadMacro('rt');
  assert.equal(loaded.prompt, 'do x');
  assert.equal(loaded.steps[0].input.command, 'ls');
});

test('saveMacro — refuses to clobber without force', async () => {
  await saveMacro({ name: 'clob', steps: [{ tool: 'bash', input: { command: 'a' } }] });
  await assert.rejects(() => saveMacro({ name: 'clob', steps: [{ tool: 'bash', input: { command: 'b' } }] }), /already exists/);
  await saveMacro({ name: 'clob', steps: [{ tool: 'bash', input: { command: 'b' } }] }, { force: true });
  assert.equal((await loadMacro('clob')).steps[0].input.command, 'b');
});

test('saveMacro / loadMacro — reject invalid names (no traversal)', async () => {
  await assert.rejects(() => saveMacro({ name: '../escape', steps: [{ tool: 'bash', input: { command: 'x' } }] }), /Invalid macro name/);
  await assert.rejects(() => loadMacro('../../etc/passwd'), /Invalid macro name/);
});

test('loadMacro — missing throws with a hint', async () => {
  await assert.rejects(() => loadMacro('nope'), /not found/);
});

test('listMacroNames / listMacros — sorted; deleteMacro removes', async () => {
  await saveMacro({ name: 'zeta', steps: [{ tool: 'bash', input: { command: 'z' } }] });
  await saveMacro({ name: 'alpha', steps: [{ tool: 'bash', input: { command: 'a' } }] });
  const names = await listMacroNames();
  assert.ok(names.includes('alpha') && names.includes('zeta'));
  assert.deepEqual([...names].sort(), names);
  assert.ok((await listMacros()).some((m) => m.name === 'alpha'));
  await deleteMacro('alpha');
  await assert.rejects(() => loadMacro('alpha'), /not found/);
  await assert.rejects(() => deleteMacro('alpha'), /not found/);
});
