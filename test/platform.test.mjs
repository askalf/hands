// Tests for src/platform/index.ts's pure helpers. The ydotoold daemon probe
// is exercised via injection — no live daemon, no input synthesis — mirroring
// how doctor.test.mjs pins classification logic without touching the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveYdotoolSocket, isYdotooldRunning } from '../dist/platform/index.js';

// ── resolveYdotoolSocket ────────────────────────────────────────────

test('resolveYdotoolSocket — explicit YDOTOOL_SOCKET wins', () => {
  assert.equal(
    resolveYdotoolSocket({ YDOTOOL_SOCKET: '/custom/ydo.sock', XDG_RUNTIME_DIR: '/run/user/1000' }),
    '/custom/ydo.sock',
  );
});

test('resolveYdotoolSocket — falls back to $XDG_RUNTIME_DIR/.ydotool_socket', () => {
  assert.equal(
    resolveYdotoolSocket({ XDG_RUNTIME_DIR: '/run/user/1000' }),
    join('/run/user/1000', '.ydotool_socket'),
  );
});

test('resolveYdotoolSocket — /tmp default when neither is set', () => {
  const s = resolveYdotoolSocket({});
  assert.match(s, /[/\\]tmp[/\\]\.ydotool_socket$/);
});

test('resolveYdotoolSocket — blank env values are ignored', () => {
  assert.match(resolveYdotoolSocket({ YDOTOOL_SOCKET: '   ', XDG_RUNTIME_DIR: '' }), /\.ydotool_socket$/);
});

// ── isYdotooldRunning ───────────────────────────────────────────────

test('isYdotooldRunning — reachable when the socket exists', async () => {
  const reachable = async () => {};                       // access resolves
  assert.equal(await isYdotooldRunning('/run/user/1000/.ydotool_socket', reachable), true);
});

test('isYdotooldRunning — down when the socket is absent', async () => {
  const absent = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.equal(await isYdotooldRunning('/run/user/1000/.ydotool_socket', absent), false);
});
