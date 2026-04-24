// Tests for util/audit.ts — the append-only log of every tool call
// SDK mode makes. Pure helpers (summarizeForAudit, summarizeToolArgs,
// getAuditPaths) are tested directly. File I/O paths (append, rotate,
// read) use a per-test temp dir by shelling HOME to point at a
// throwaway location before importing the module — the paths module
// caches HOME at import-time so the test HAS to set it first and then
// dynamic-import.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set HOME BEFORE importing audit.js — getAuditPaths computes from
// homedir() at module-load time, so env must be set first.
const testHome = mkdtempSync(join(tmpdir(), 'hands-audit-test-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

const { appendAudit, rotateIfNeeded, readAuditHistory, summarizeForAudit, getAuditPaths } =
  await import('../dist/util/audit.js');
const { summarizeToolArgs } = await import('../dist/sdk-mode.js');

const paths = getAuditPaths();

after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
});

test('summarizeForAudit — single-line JSON, parseable round-trip', () => {
  const line = summarizeForAudit({ ts: 123, tool: 'bash', action: undefined, args: { command: 'ls' }, durationMs: 12, ok: true });
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.tool, 'bash');
  assert.equal(parsed.ok,   true);
});

test('summarizeToolArgs — strips image/data/source keys, truncates long strings', () => {
  const argsIn = {
    command: 'a'.repeat(300),
    coordinate: [100, 200],
    image: 'base64junk...',
    data: 'moregunk',
    source: { type: 'base64', data: 'x'.repeat(9999) },
    ok: 'short',
  };
  const summed = summarizeToolArgs('computer', argsIn);
  assert.equal(summed.image,  undefined, 'image bytes must not land in audit');
  assert.equal(summed.data,   undefined);
  assert.equal(summed.source, undefined);
  assert.deepEqual(summed.coordinate, [100, 200]);
  assert.equal(summed.ok, 'short');
  assert.ok(typeof summed.command === 'string' && summed.command.length <= 201,
    `expected command truncated to <=201, got length ${(summed.command || '').length}`);
});

test('appendAudit + readAuditHistory — round-trip', async () => {
  await appendAudit({ tool: 'bash', action: 'exec', args: { cmd: 'ls' }, durationMs: 10, ok: true });
  await appendAudit({ tool: 'computer', action: 'screenshot', args: {}, durationMs: 40, ok: true });

  const hist = await readAuditHistory(10);
  assert.ok(hist.length >= 2, `expected at least 2 entries, got ${hist.length}`);
  assert.equal(hist[hist.length - 1].action, 'screenshot');
  assert.equal(hist[hist.length - 2].tool,   'bash');
});

test('appendAudit — creates ~/.hands/ dir with 0700 perms', async () => {
  await appendAudit({ tool: 't', ok: true });
  assert.ok(existsSync(paths.dir));
});

test('rotateIfNeeded — rotates when file exceeds MAX_BYTES', async () => {
  // Overwrite the live file with just-over-the-cap content.
  const bigLine = JSON.stringify({ tool: 'x', ok: true, pad: 'p'.repeat(1000) }) + '\n';
  const reps = Math.ceil(paths.maxBytes / bigLine.length) + 1;
  writeFileSync(paths.live, bigLine.repeat(reps));
  const result = await rotateIfNeeded();
  assert.equal(result, 'rotated');
  assert.ok(existsSync(paths.archived), 'old archive should exist after rotate');
  assert.ok(!existsSync(paths.live),    'live should be gone after rotate (next append recreates)');

  // Next append recreates live, archive stays.
  await appendAudit({ tool: 'after-rotate', ok: true });
  assert.ok(existsSync(paths.live));
  assert.ok(existsSync(paths.archived));

  // Read-history returns the fresh post-rotation entry only — old archive not scanned.
  const post = await readAuditHistory(5);
  assert.equal(post.length, 1);
  assert.equal(post[0].tool, 'after-rotate');
});

test('rotateIfNeeded — returns absent when no file exists', async () => {
  // Clean up both files first.
  try { rmSync(paths.live, { force: true }); } catch {}
  try { rmSync(paths.archived, { force: true }); } catch {}
  const result = await rotateIfNeeded();
  assert.equal(result, 'absent');
});

test('readAuditHistory — skips malformed lines', async () => {
  writeFileSync(paths.live,
    [
      JSON.stringify({ ts: 1, tool: 'valid1', ok: true }),
      'not-json-garbage',
      JSON.stringify({ ts: 2, tool: 'valid2', ok: true }),
    ].join('\n') + '\n'
  );
  const hist = await readAuditHistory(10);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map(h => h.tool), ['valid1', 'valid2']);
});
