import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_COMPUTER_ACTIONS, parseModifier, scaleZoomRegion } from '../dist/sdk-mode.js';

// The documented computer_20251124 action set (platform.claude.com
// computer-use docs, 2026-06): basic actions + 20250124 enhanced
// actions + zoom. If this list and SUPPORTED_COMPUTER_ACTIONS drift,
// the dispatcher is promising the model capabilities it can't deliver.
const DOCUMENTED_20251124_ACTIONS = [
  'screenshot', 'left_click', 'type', 'key', 'mouse_move',
  'scroll', 'left_click_drag', 'right_click', 'middle_click',
  'double_click', 'triple_click', 'left_mouse_down', 'left_mouse_up',
  'hold_key', 'wait',
  'zoom',
];

test('every documented computer_20251124 action is supported', () => {
  for (const action of DOCUMENTED_20251124_ACTIONS) {
    assert.ok(
      SUPPORTED_COMPUTER_ACTIONS.includes(action),
      `documented action "${action}" missing from SUPPORTED_COMPUTER_ACTIONS`,
    );
  }
});

test('no phantom actions beyond the documented set', () => {
  for (const action of SUPPORTED_COMPUTER_ACTIONS) {
    assert.ok(
      DOCUMENTED_20251124_ACTIONS.includes(action),
      `"${action}" is not in the documented computer_20251124 set`,
    );
  }
});

test('parseModifier accepts the documented modifiers and nothing else', () => {
  assert.equal(parseModifier('shift'), 'shift');
  assert.equal(parseModifier('ctrl'), 'ctrl');
  assert.equal(parseModifier('alt'), 'alt');
  assert.equal(parseModifier('super'), 'super');
  assert.equal(parseModifier('cmd'), undefined);
  assert.equal(parseModifier(''), undefined);
  assert.equal(parseModifier(undefined), undefined);
  assert.equal(parseModifier(3), undefined);
});

test('scaleZoomRegion maps screenshot-space corners to real-pixel capture rects', () => {
  // scaleFactor 0.5 → screenshot coords are half of real pixels
  assert.deepEqual(scaleZoomRegion([100, 200, 400, 350], 0.5), [200, 400, 600, 300]);
  // scaleFactor 1 → passthrough, corner pair becomes x/y/w/h
  assert.deepEqual(scaleZoomRegion([10, 20, 110, 70], 1), [10, 20, 100, 50]);
});

test('scaleZoomRegion rejects empty and inverted regions', () => {
  assert.equal(scaleZoomRegion([100, 100, 100, 200], 1), undefined); // zero width
  assert.equal(scaleZoomRegion([100, 100, 200, 100], 1), undefined); // zero height
  assert.equal(scaleZoomRegion([300, 300, 100, 100], 1), undefined); // inverted
});
