// Unit tests for audit-replay's pure helpers (read, summarize,
// classify). Skips the actual replayEntry execution — that
// requires real platform tools (mouseMove, takeScreenshot) and is
// covered by integration testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeEntry, classifyEntry, readAuditEntries } from '../dist/audit-replay.js';

test('summarizeEntry — renders bash entry on one line', () => {
  const line = summarizeEntry({
    ts: 1730000000000,
    tool: 'bash',
    args: { command: 'echo hello' },
    durationMs: 42,
    ok: true,
  });
  assert.match(line, /bash/);
  assert.match(line, /echo hello/);
  assert.match(line, /✓/);
  assert.match(line, /42ms/);
});

test('summarizeEntry — renders computer:mouse_move with coordinate', () => {
  const line = summarizeEntry({
    tool: 'computer',
    action: 'mouse_move',
    args: { action: 'mouse_move', coordinate: [100, 200] },
    ok: true,
  });
  assert.match(line, /computer:mouse_move/);
  assert.match(line, /coordinate=\[100,200\]/);
});

test('summarizeEntry — failure entry shows ✗', () => {
  const line = summarizeEntry({
    tool: 'bash',
    args: { command: 'false' },
    ok: false,
    error: 'exit 1',
  });
  assert.match(line, /✗/);
});

test('summarizeEntry — dry-run entry shows the marker', () => {
  const line = summarizeEntry({
    tool: 'bash',
    args: { command: 'echo' },
    ok: true,
    dryRun: true,
  });
  assert.match(line, /\[dry-run\]/);
});

test('classifyEntry — screenshot is read-only', () => {
  const cls = classifyEntry({ tool: 'computer', action: 'screenshot', args: { action: 'screenshot' }, ok: true });
  assert.equal(cls, 'read-only');
});

test('classifyEntry — mouse_move is read-only', () => {
  const cls = classifyEntry({ tool: 'computer', action: 'mouse_move', args: { action: 'mouse_move', coordinate: [10, 10] }, ok: true });
  assert.equal(cls, 'read-only');
});

test('classifyEntry — left_click is state-changing', () => {
  const cls = classifyEntry({ tool: 'computer', action: 'left_click', args: { action: 'left_click', coordinate: [10, 10] }, ok: true });
  assert.equal(cls, 'state-changing');
});

test('classifyEntry — bash is always state-changing', () => {
  const cls = classifyEntry({ tool: 'bash', args: { command: 'whoami' }, ok: true });
  assert.equal(cls, 'state-changing');
});

test('classifyEntry — text_editor:view is read-only', () => {
  const cls = classifyEntry({ tool: 'str_replace_based_edit_tool', args: { command: 'view', path: '/tmp/x' }, ok: true });
  assert.equal(cls, 'read-only');
});

test('classifyEntry — text_editor:str_replace is state-changing', () => {
  const cls = classifyEntry({ tool: 'str_replace_based_edit_tool', args: { command: 'str_replace', path: '/tmp/x' }, ok: true });
  assert.equal(cls, 'state-changing');
});

test('readAuditEntries — empty when no file', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'hands-audit-empty-'));
  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const entries = await readAuditEntries();
    assert.equal(entries.length, 0);
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile; else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('readAuditEntries — parses JSONL, skips malformed lines', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'hands-audit-jsonl-'));
  const handsDir = join(fakeHome, '.hands');
  mkdirSync(handsDir, { recursive: true });
  const lines = [
    JSON.stringify({ ts: 1, tool: 'bash', args: { command: 'a' }, ok: true }),
    JSON.stringify({ ts: 2, tool: 'bash', args: { command: 'b' }, ok: true }),
    'this is not valid json',
    JSON.stringify({ ts: 3, tool: 'bash', args: { command: 'c' }, ok: true }),
  ].join('\n') + '\n';
  writeFileSync(join(handsDir, 'audit.jsonl'), lines, 'utf-8');

  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const entries = await readAuditEntries();
    assert.equal(entries.length, 3, 'should skip the malformed line');
    assert.equal(entries[0].args.command, 'a');
    assert.equal(entries[2].args.command, 'c');
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile; else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
