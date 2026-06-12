// Tests for the audit-list filter helper — pure, no filesystem. The
// critical invariant: filtering must NOT renumber entries, because the
// printed index is what `hands audit show/replay <index>` accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAuditEntries, summarizeEntry } from '../dist/audit-replay.js';

const ENTRIES = [
  { ts: 1, tool: 'bash', args: { command: 'ls' }, ok: true },                                  // 0: sdk (no mode)
  { ts: 2, tool: 'computer', action: 'screenshot', ok: true, mode: 'sdk' },                    // 1: sdk (explicit)
  { ts: 3, tool: 'bash', args: { command: 'echo hi' }, ok: true, mode: 'cli' },                // 2: cli
  { ts: 4, tool: 'bash', action: 'guardrail_block', ok: false, mode: 'cli', error: 'Format' }, // 3: cli, failed
  { ts: 5, tool: 'read_page', args: { url: 'https://x' }, ok: false, error: 'timeout' },       // 4: sdk, failed
];

test('filterAuditEntries — no filter returns everything with original indexes', () => {
  const out = filterAuditEntries(ENTRIES, {});
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((e) => e.index), [0, 1, 2, 3, 4]);
});

test('filterAuditEntries — mode cli matches only mode:"cli" entries', () => {
  const out = filterAuditEntries(ENTRIES, { mode: 'cli' });
  assert.deepEqual(out.map((e) => e.index), [2, 3]);
});

test('filterAuditEntries — mode sdk includes entries with no mode field (pre-0.6 logs)', () => {
  const out = filterAuditEntries(ENTRIES, { mode: 'sdk' });
  assert.deepEqual(out.map((e) => e.index), [0, 1, 4]);
});

test('filterAuditEntries — tool filter is exact', () => {
  assert.deepEqual(filterAuditEntries(ENTRIES, { tool: 'bash' }).map((e) => e.index), [0, 2, 3]);
  assert.deepEqual(filterAuditEntries(ENTRIES, { tool: 'read_page' }).map((e) => e.index), [4]);
  assert.deepEqual(filterAuditEntries(ENTRIES, { tool: 'nope' }), []);
});

test('filterAuditEntries — failedOnly keeps not-ok entries', () => {
  assert.deepEqual(filterAuditEntries(ENTRIES, { failedOnly: true }).map((e) => e.index), [3, 4]);
});

test('filterAuditEntries — filters compose (cli + bash + failed → the guardrail block)', () => {
  const out = filterAuditEntries(ENTRIES, { mode: 'cli', tool: 'bash', failedOnly: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 3);
  assert.equal(out[0].entry.action, 'guardrail_block');
});

test('summarizeEntry — cli entries carry a [cli] marker, sdk entries keep the historical rendering', () => {
  assert.match(summarizeEntry(ENTRIES[2]), / \[cli\]/);
  assert.doesNotMatch(summarizeEntry(ENTRIES[0]), /\[cli\]/);
  assert.doesNotMatch(summarizeEntry(ENTRIES[1]), /\[cli\]/);
});
