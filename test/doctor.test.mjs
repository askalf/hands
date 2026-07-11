// Tests for doctor.ts's pure helpers. The full runDoctor() pipeline
// hits the filesystem + child processes + network; pure-helper tests
// pin the text-rendering + classification logic without needing
// mock filesystems.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, platform } from 'node:os';
import {
  nodeMeetsMinimum,
  scrubPath,
  trimTrailingSlash,
  classifyFsError,
  classifyFetchError,
  renderDoctorText,
  renderDoctorJson,
  exitCodeFor,
  renderRecorderCheck,
} from '../dist/doctor.js';
import { expectedRecorder } from '../dist/voice/index.js';

test('nodeMeetsMinimum — 20.0.0 is the floor', () => {
  assert.equal(nodeMeetsMinimum('v20.0.0'),  true);
  assert.equal(nodeMeetsMinimum('v20.18.1'), true);
  assert.equal(nodeMeetsMinimum('v22.0.0'),  true);
  assert.equal(nodeMeetsMinimum('v24.3.0'),  true);
  assert.equal(nodeMeetsMinimum('v19.9.0'),  false);
  assert.equal(nodeMeetsMinimum('v18.20.0'), false);
});

test('nodeMeetsMinimum — accepts version without v prefix', () => {
  assert.equal(nodeMeetsMinimum('20.0.0'), true);
  assert.equal(nodeMeetsMinimum('22.1.0'), true);
});

test('scrubPath — rewrites $HOME to ~', () => {
  const home = homedir();
  const under = platform() === 'win32' ? home + '\\projects\\x' : home + '/projects/x';
  const expected = platform() === 'win32' ? '~\\projects\\x' : '~/projects/x';
  assert.equal(scrubPath(under), expected);
});

test('scrubPath — leaves non-home paths alone', () => {
  assert.equal(scrubPath('/etc/passwd'), '/etc/passwd');
  assert.equal(scrubPath('/tmp/x'),      '/tmp/x');
});

test('trimTrailingSlash — removes one or many', () => {
  assert.equal(trimTrailingSlash('http://x'),      'http://x');
  assert.equal(trimTrailingSlash('http://x/'),     'http://x');
  assert.equal(trimTrailingSlash('http://x//'),    'http://x');
  assert.equal(trimTrailingSlash('http://x////'),  'http://x');
  assert.equal(trimTrailingSlash('http://x/path'), 'http://x/path');
});

test('classifyFsError — maps common codes', () => {
  const enoent = Object.assign(new Error('whatever'), { code: 'ENOENT' });
  assert.equal(classifyFsError(enoent), 'not found');
  const eacces = Object.assign(new Error('nope'), { code: 'EACCES' });
  assert.equal(classifyFsError(eacces), 'permission denied');
  const other = Object.assign(new Error('boom'), { code: 'EMFILE' });
  assert.match(classifyFsError(other), /EMFILE/);
});

test('classifyFetchError — maps common shapes', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyFetchError(abort), 'timeout');
  const timeoutName = Object.assign(new Error('x'), { name: 'TimeoutError' });
  assert.equal(classifyFetchError(timeoutName), 'timeout');
  const refused = new Error('fetch failed: ECONNREFUSED 127.0.0.1:3456');
  assert.equal(classifyFetchError(refused), 'connection refused');
  const dns = new Error('ENOTFOUND foo.bar');
  assert.equal(classifyFetchError(dns), 'dns lookup failed');
});

test('renderDoctorText — aligns columns, formats summary', () => {
  const report = {
    version: '0.1.0',
    generatedAt: 0,
    checks: [
      { id: 'env.hands',    category: 'environment', status: 'info', label: 'hands', detail: '' },
      { id: 'env.node',     category: 'environment', status: 'ok',   label: 'Node',  detail: 'v22.0.0' },
      { id: 'platform.mouse', category: 'platform',  status: 'fail', label: 'mouse', detail: 'xdotool — not installed' },
    ],
    summary: { total: 3, ok: 1, warn: 0, fail: 1, info: 1 },
  };
  const out = renderDoctorText(report);
  // Version gets patched in.
  assert.match(out, /hands.*v0\.1\.0/);
  // Status icons are bracketed + fixed width.
  assert.match(out, /\[ OK \]/);
  assert.match(out, /\[FAIL\]/);
  assert.match(out, /\[INFO\]/);
  // Summary line present.
  assert.match(out, /summary: 1 ok · 0 warn · 1 fail · 1 info/);
});

test('renderDoctorJson — valid JSON that round-trips', () => {
  const report = {
    version: '0.1.0',
    generatedAt: 12345,
    checks: [{ id: 'a', category: 'x', status: 'ok', label: 'L', detail: 'D' }],
    summary: { total: 1, ok: 1, warn: 0, fail: 0, info: 0 },
  };
  const json = renderDoctorJson(report);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, report);
});

test('exitCodeFor — 1 on any fail, 0 otherwise', () => {
  assert.equal(exitCodeFor({ summary: { total: 0, ok: 0, warn: 0, fail: 0, info: 0 } }), 0);
  assert.equal(exitCodeFor({ summary: { total: 5, ok: 4, warn: 1, fail: 0, info: 0 } }), 0);
  assert.equal(exitCodeFor({ summary: { total: 5, ok: 3, warn: 1, fail: 1, info: 0 } }), 1);
});

// ── voice recorder backend ──────────────────────────────────────────

test('expectedRecorder — backend matches getMicCommand() per platform', () => {
  const win = expectedRecorder('win32');
  assert.deepEqual(win.probe, ['ffmpeg', 'sox'], 'Windows prefers ffmpeg then sox');
  assert.equal(win.hasFallback, true, 'Windows has native waveIn — never fails');

  const mac = expectedRecorder('darwin');
  assert.deepEqual(mac.probe, ['rec']);
  assert.equal(mac.installHint, 'brew install sox');
  assert.equal(mac.hasFallback, false);

  const linux = expectedRecorder('linux');
  assert.deepEqual(linux.probe, ['arecord']);
  assert.equal(linux.installHint, 'sudo apt install alsa-utils');
  assert.equal(linux.hasFallback, false);
});

test('renderRecorderCheck — installed backend is ok', () => {
  const c = renderRecorderCheck(expectedRecorder('darwin'), ['rec']);
  assert.equal(c.status, 'ok');
  assert.equal(c.id, 'voice.recorder');
  assert.match(c.detail, /rec/);
});

test('renderRecorderCheck — missing on macOS/Linux is warn with install hint', () => {
  const mac = renderRecorderCheck(expectedRecorder('darwin'), []);
  assert.equal(mac.status, 'warn');
  assert.match(mac.detail, /brew install sox/);

  const linux = renderRecorderCheck(expectedRecorder('linux'), []);
  assert.equal(linux.status, 'warn');
  assert.match(linux.detail, /alsa-utils/);
});

test('renderRecorderCheck — Windows never warns/fails (native waveIn fallback)', () => {
  // No external recorder found, but Windows has the built-in fallback.
  const none = renderRecorderCheck(expectedRecorder('win32'), []);
  assert.equal(none.status, 'info');
  assert.match(none.detail, /waveIn/);
  // ffmpeg present → ok, noting it's preferred over the fallback.
  const withFfmpeg = renderRecorderCheck(expectedRecorder('win32'), ['ffmpeg']);
  assert.equal(withFfmpeg.status, 'ok');
  assert.match(withFfmpeg.detail, /ffmpeg/);
});

test('renderRecorderCheck — a missing recorder never flips the exit code', () => {
  // warn/info only, so exitCodeFor stays 0 (voice is opt-in).
  for (const os of ['win32', 'darwin', 'linux']) {
    const c = renderRecorderCheck(expectedRecorder(os), []);
    assert.notEqual(c.status, 'fail', `${os} recorder check must not be fail`);
  }
});
