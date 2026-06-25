// Tests for audit-stats.ts — pure aggregation + rendering, no filesystem.
// The full `audit stats` command reads ~/.hands/audit.jsonl; these pin the
// rollup math, the derived metrics, the duration parser, and the text /
// JSON renderers without a temp log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAuditStats,
  successRate,
  avgDurationMs,
  parseDuration,
  formatMs,
  formatSpan,
  renderStatsText,
  renderStatsJson,
} from '../dist/audit-stats.js';

const ENTRIES = [
  { ts: 1000, tool: 'bash', args: { command: 'ls' }, ok: true, durationMs: 50 },                              // sdk
  { ts: 2000, tool: 'computer', action: 'screenshot', ok: true, mode: 'sdk', durationMs: 200 },               // sdk
  { ts: 3000, tool: 'bash', args: { command: 'echo hi' }, ok: true, mode: 'cli', durationMs: 150 },           // cli
  { ts: 4000, tool: 'bash', action: 'guardrail_block', ok: false, mode: 'cli', error: 'Format blocked' },     // cli, failed
  { ts: 5000, tool: 'read_page', args: { url: 'https://x' }, ok: false, error: 'timeout', dryRun: true },     // sdk, failed
];

test('computeAuditStats — totals, ok/failed, dry-run, mode split', () => {
  const s = computeAuditStats(ENTRIES);
  assert.equal(s.total, 5);
  assert.equal(s.ok, 3);
  assert.equal(s.failed, 2);
  assert.equal(s.dryRun, 1);
  // Absent mode counts as sdk: entries 0,1,4 = 3 sdk; entries 2,3 = 2 cli.
  assert.deepEqual(s.modes, { sdk: 3, cli: 2 });
  assert.equal(s.firstTs, 1000);
  assert.equal(s.lastTs, 5000);
});

test('computeAuditStats — per-tool rollup sorted by count then name', () => {
  const s = computeAuditStats(ENTRIES);
  assert.deepEqual(s.byTool.map((t) => t.tool), ['bash', 'computer', 'read_page']);
  const bash = s.byTool.find((t) => t.tool === 'bash');
  assert.equal(bash.count, 3);
  assert.equal(bash.failed, 1);
  // Only 2 of the 3 bash calls carried a durationMs (the guardrail block didn't).
  assert.equal(bash.timed, 2);
  assert.equal(bash.totalDurationMs, 200);
});

test('computeAuditStats — recentFailures keeps the most recent (oldest-first), with action + error', () => {
  const s = computeAuditStats(ENTRIES);
  assert.equal(s.recentFailures.length, 2);
  assert.deepEqual(s.recentFailures.map((f) => f.tool), ['bash', 'read_page']);
  assert.equal(s.recentFailures[0].action, 'guardrail_block');
  assert.equal(s.recentFailures[0].error, 'Format blocked');
  // A failure with no `error` field falls back to a placeholder, not undefined.
  assert.equal(s.recentFailures[1].error, 'timeout');
});

test('computeAuditStats — recentFailures caps at 5 (keeps the newest)', () => {
  const many = [];
  for (let i = 0; i < 8; i++) many.push({ ts: i, tool: 'bash', ok: false, error: `e${i}` });
  const s = computeAuditStats(many);
  assert.equal(s.recentFailures.length, 5);
  assert.deepEqual(s.recentFailures.map((f) => f.error), ['e3', 'e4', 'e5', 'e6', 'e7']);
});

test('computeAuditStats — empty log is all zeros, no timestamps', () => {
  const s = computeAuditStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.ok, 0);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.byTool, []);
  assert.deepEqual(s.recentFailures, []);
  assert.equal(s.firstTs, undefined);
  assert.equal(s.lastTs, undefined);
});

test('successRate — whole percent, 0 on empty', () => {
  assert.equal(successRate(computeAuditStats(ENTRIES)), 60); // 3/5
  assert.equal(successRate(computeAuditStats([])), 0);
  assert.equal(successRate(computeAuditStats([{ tool: 'bash', ok: true }])), 100);
});

test('avgDurationMs — divides by timed calls only, null when none timed', () => {
  const s = computeAuditStats(ENTRIES);
  assert.equal(avgDurationMs(s.byTool.find((t) => t.tool === 'bash')), 100);       // 200 / 2
  assert.equal(avgDurationMs(s.byTool.find((t) => t.tool === 'computer')), 200);   // 200 / 1
  assert.equal(avgDurationMs(s.byTool.find((t) => t.tool === 'read_page')), null); // 0 timed
});

test('parseDuration — unit required, days supported', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('7d'), 604_800_000);
  // No bare ms — a unit is required so `--since 5` can't silently mean 5ms.
  assert.equal(parseDuration('5'), null);
  assert.equal(parseDuration('5ms'), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
});

test('formatMs — ms / s / m+s scaling', () => {
  assert.equal(formatMs(142), '142ms');
  assert.equal(formatMs(1200), '1.2s');
  assert.equal(formatMs(65_000), '1m 5s');
  assert.equal(formatMs(120_000), '2m');
});

test('formatSpan — coarse elapsed buckets', () => {
  assert.equal(formatSpan(500), '500ms');
  assert.equal(formatSpan(45_000), '45s');
  assert.equal(formatSpan(300_000), '5m');
  assert.equal(formatSpan(9_000_000), '2h 30m');
  assert.equal(formatSpan(228_600_000), '2d 15h');
});

test('renderStatsText — headline, per-tool, recent failures', () => {
  const out = renderStatsText(computeAuditStats(ENTRIES));
  assert.match(out, /Audit stats/);
  assert.match(out, /entries\s+5/);
  assert.match(out, /60% success/);
  assert.match(out, /3 sdk · 2 cli/);
  assert.match(out, /dry-run\s+1/);
  assert.match(out, /by tool/);
  assert.match(out, /bash/);
  assert.match(out, /recent failures/);
  assert.match(out, /Format blocked/);
});

test('renderStatsText — empty log prints the friendly hint, not a broken table', () => {
  const out = renderStatsText(computeAuditStats([]));
  assert.match(out, /No audit entries yet/);
  assert.doesNotMatch(out, /by tool/);
});

test('renderStatsJson — valid JSON with successRate folded in', () => {
  const stats = computeAuditStats(ENTRIES);
  const parsed = JSON.parse(renderStatsJson(stats));
  assert.equal(parsed.total, 5);
  assert.equal(parsed.successRate, 60);
  assert.equal(parsed.byTool.length, 3);
});
