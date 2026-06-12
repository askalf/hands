// Tests for util/session-state.ts — the ~/.hands/last-session.json
// pointer behind `hands run --continue` — plus the --resume flag
// contract in buildClaudeArgs. HOME is shimmed to a temp dir before
// import (same pattern as audit.test.mjs: paths are computed from
// homedir() at module-load time).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'hands-session-test-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

const { saveLastSession, loadLastSession, getLastSessionPath } =
  await import('../dist/util/session-state.js');
const { buildClaudeArgs } = await import('../dist/cli-mode.js');

after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
});

const SAMPLE = {
  sessionId: 'sess-abc-123',
  cwd: 'C:\\Users\\someone\\projects',
  task: 'open notepad and type hello',
  ts: 1750000000000,
};

test('loadLastSession — null when nothing has been saved', async () => {
  assert.equal(await loadLastSession(), null);
});

test('save → load round-trips the pointer', async () => {
  await saveLastSession(SAMPLE);
  const loaded = await loadLastSession();
  assert.deepEqual(loaded, SAMPLE);
});

test('saveLastSession — overwrites: only the most recent session is kept', async () => {
  await saveLastSession(SAMPLE);
  await saveLastSession({ ...SAMPLE, sessionId: 'sess-newer', ts: SAMPLE.ts + 5000 });
  const loaded = await loadLastSession();
  assert.equal(loaded.sessionId, 'sess-newer');
  assert.equal(loaded.ts, SAMPLE.ts + 5000);
});

test('loadLastSession — malformed JSON and missing fields return null, never throw', async () => {
  writeFileSync(getLastSessionPath(), '{not json');
  assert.equal(await loadLastSession(), null);

  writeFileSync(getLastSessionPath(), JSON.stringify({ sessionId: '', cwd: '/x', task: 't', ts: 1 }));
  assert.equal(await loadLastSession(), null);

  writeFileSync(getLastSessionPath(), JSON.stringify({ sessionId: 'sess-1', cwd: '/x' }));
  assert.equal(await loadLastSession(), null);
});

test('saveLastSession — file content is pretty JSON (operator-inspectable)', async () => {
  await saveLastSession(SAMPLE);
  const raw = readFileSync(getLastSessionPath(), 'utf-8');
  assert.ok(raw.includes('\n'));
  assert.deepEqual(JSON.parse(raw), SAMPLE);
});

test('buildClaudeArgs — --resume rides ahead of -p and re-passes every per-run flag', () => {
  const args = buildClaudeArgs({
    prefixArgs: [],
    prompt: 'continue the spreadsheet task',
    systemPrompt: 'SYS',
    maxTurns: 50,
    mcpConfigPath: '/tmp/mcp.json',
    settingsPath: '/tmp/settings.json',
    resumeSessionId: 'sess-abc-123',
  });
  const resumeIdx = args.indexOf('--resume');
  assert.ok(resumeIdx >= 0);
  assert.equal(args[resumeIdx + 1], 'sess-abc-123');
  assert.ok(resumeIdx < args.indexOf('-p'), '--resume must come before -p');
  // resumed turns still re-pass the flags claude does not persist
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes('--mcp-config'));
  assert.ok(args.includes('--settings'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('buildClaudeArgs — no resumeSessionId → no --resume flag', () => {
  const args = buildClaudeArgs({
    prefixArgs: [],
    prompt: 'fresh task',
    systemPrompt: 'SYS',
    maxTurns: 50,
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.equal(args.includes('--resume'), false);
});
