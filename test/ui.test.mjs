// Tests for src/ui.ts — semantic UI targeting. Pure parsing/matching is
// tested directly; the real UIAutomation enumeration is exercised on
// Windows (and asserted to reject elsewhere).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUiElements, findElements, elementCenter, describeElement,
  buildUiInstruction, buildUiTreeTool, buildClickElementTool, enumerateUiElements,
} from '../dist/ui.js';

// ── parseUiElements ─────────────────────────────────────────────────

test('parseUiElements — array, single object, empty, malformed, nameless', () => {
  const arr = parseUiElements('[{"name":"Save","role":"Button","x":10,"y":20,"w":80,"h":30,"enabled":true}]');
  assert.equal(arr.length, 1);
  assert.equal(arr[0].name, 'Save');
  assert.equal(arr[0].role, 'Button');
  // PowerShell sometimes unwraps a single-element array to a bare object.
  assert.equal(parseUiElements('{"name":"OK","role":"Button","x":0,"y":0,"w":10,"h":10,"enabled":true}').length, 1);
  assert.deepEqual(parseUiElements(''), []);
  assert.deepEqual(parseUiElements('not json'), []);
  assert.equal(parseUiElements('[{"role":"Pane"}]').length, 0, 'entries without a name are dropped');
});

// ── findElements ────────────────────────────────────────────────────

const ELS = [
  { name: 'Save As', role: 'MenuItem', x: 0, y: 0, w: 50, h: 20, enabled: true },
  { name: 'Save', role: 'Button', x: 0, y: 0, w: 50, h: 20, enabled: true },
  { name: 'Save', role: 'Button', x: 0, y: 0, w: 50, h: 20, enabled: false },
];

test('findElements — substring match, exact-name ranking, disabled last', () => {
  const m = findElements(ELS, { name: 'save' });
  assert.equal(m.length, 3);
  assert.equal(m[0].name, 'Save', 'exact name ranks above "Save As"');
  assert.equal(m[0].enabled, true, 'enabled exact match before disabled exact match');
});

test('findElements — role filter and no-match', () => {
  assert.deepEqual(findElements(ELS, { name: 'save', role: 'menu' }).map((e) => e.role), ['MenuItem']);
  assert.deepEqual(findElements(ELS, { name: 'cancel' }), []);
});

// ── helpers ─────────────────────────────────────────────────────────

test('elementCenter — center point', () => {
  assert.deepEqual(elementCenter({ name: 'x', role: 'B', x: 100, y: 200, w: 80, h: 40, enabled: true }), { x: 140, y: 220 });
});

test('describeElement — readable line, marks disabled', () => {
  assert.match(describeElement({ name: 'Save', role: 'Button', x: 1, y: 2, w: 3, h: 4, enabled: true }), /Button "Save" @ \(1, 2\)/);
  assert.match(describeElement({ name: 'Old', role: 'Button', x: 0, y: 0, w: 1, h: 1, enabled: false }), /disabled/);
});

test('tool + prompt builders — shapes', () => {
  assert.equal(buildUiTreeTool().name, 'ui_tree');
  const click = buildClickElementTool();
  assert.equal(click.name, 'click_element');
  assert.deepEqual(click.input_schema.required, ['name']);
  assert.match(buildUiInstruction(), /accessibility tree/i);
});

// ── real enumeration ────────────────────────────────────────────────

test('enumerateUiElements — returns a well-shaped array on Windows', { skip: process.platform !== 'win32' }, async () => {
  const els = await enumerateUiElements();
  assert.ok(Array.isArray(els), 'returns an array');
  for (const e of els.slice(0, 5)) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.x, 'number');
    assert.equal(typeof e.role, 'string');
  }
});

test('enumerateUiElements — rejects off-Windows with a clear message', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(() => enumerateUiElements(), /Windows-only/);
});
