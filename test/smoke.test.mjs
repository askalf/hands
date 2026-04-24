// Smoke tests: every module imports cleanly and exposes the surface
// referenced elsewhere in the codebase. Runs against compiled `dist/` —
// `npm test` depends on `npm run build` having run first (CI enforces
// this via the pipeline order).
//
// These are the thin safety net for "someone accidentally deleted an
// exported function" regressions. Behavior-level tests for each module
// land in separate files as the code stabilises.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('util/config exposes loadConfig + saveConfig + path helpers', async () => {
  const mod = await import('../dist/util/config.js');
  assert.equal(typeof mod.loadConfig,    'function', 'loadConfig missing');
  assert.equal(typeof mod.saveConfig,    'function', 'saveConfig missing');
  assert.equal(typeof mod.getConfigDir,  'function', 'getConfigDir missing');
  assert.equal(typeof mod.getConfigPath, 'function', 'getConfigPath missing');
});

test('util/guardrails exposes checkCommand + GUARDRAIL_PROMPT', async () => {
  const mod = await import('../dist/util/guardrails.js');
  assert.equal(typeof mod.checkCommand,     'function', 'checkCommand missing');
  assert.equal(typeof mod.GUARDRAIL_PROMPT, 'string',   'GUARDRAIL_PROMPT missing');
});

test('platform/index exposes platform-abstraction entrypoints', async () => {
  const mod = await import('../dist/platform/index.js');
  // Smoke: at least one of the expected platform helpers should re-export.
  const keys = Object.keys(mod);
  assert.ok(keys.length > 0, `platform/index should re-export helpers, got 0 keys`);
});

test('platform/screen-info exposes getScreenSize', async () => {
  const mod = await import('../dist/platform/screen-info.js');
  assert.equal(typeof mod.getScreenSize, 'function', 'getScreenSize missing');
});

test('platform/screenshot exposes takeScreenshot', async () => {
  const mod = await import('../dist/platform/screenshot.js');
  assert.equal(typeof mod.takeScreenshot, 'function', 'takeScreenshot missing');
});

test('platform/mouse exposes click/move/doubleclick/scroll', async () => {
  const mod = await import('../dist/platform/mouse.js');
  assert.equal(typeof mod.mouseClick,       'function', 'mouseClick missing');
  assert.equal(typeof mod.mouseMove,        'function', 'mouseMove missing');
  assert.equal(typeof mod.mouseDoubleClick, 'function', 'mouseDoubleClick missing');
  assert.equal(typeof mod.mouseScroll,      'function', 'mouseScroll missing');
});

test('platform/keyboard exposes type + key', async () => {
  const mod = await import('../dist/platform/keyboard.js');
  assert.equal(typeof mod.keyboardType, 'function', 'keyboardType missing');
  assert.equal(typeof mod.keyboardKey,  'function', 'keyboardKey missing');
});

test('init exposes initInteractive', async () => {
  const mod = await import('../dist/init.js');
  assert.equal(typeof mod.initInteractive, 'function', 'initInteractive missing');
});
