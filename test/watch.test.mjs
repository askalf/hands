// Tests for src/watch.ts — the reactive trigger engine. Pure helpers are
// tested directly; the WatchEngine is driven with injected fake probes so
// each trigger's change-detection (new file, changed+matching clipboard,
// command rising edge, interval) is exercised without real I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterval, parseAt, newItems, matchRegex, describeTrigger, WatchEngine } from '../dist/watch.js';

// ── pure helpers ────────────────────────────────────────────────────

test('parseInterval — units and bare ms; junk → null', () => {
  assert.equal(parseInterval('30s'), 30_000);
  assert.equal(parseInterval('5m'), 300_000);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('500'), 500);
  assert.equal(parseInterval('500ms'), 500);
  assert.equal(parseInterval('abc'), null);
  assert.equal(parseInterval(''), null);
  assert.equal(parseInterval('5x'), null);
});

test('newItems — set difference', () => {
  assert.deepEqual(newItems(['a', 'b'], ['a', 'b', 'c']), ['c']);
  assert.deepEqual(newItems(['a'], ['a']), []);
  assert.deepEqual(newItems([], ['x', 'y']), ['x', 'y']);
});

test('matchRegex — first match, no match, invalid pattern', () => {
  assert.equal(matchRegex('order #4242 shipped', '#\\d+'), '#4242');
  assert.equal(matchRegex('nothing here', '#\\d+'), null);
  assert.equal(matchRegex('x', '('), null); // invalid regex → null, never throws
});

test('describeTrigger — human one-liners', () => {
  assert.match(describeTrigger({ kind: 'file', glob: '*.pdf' }), /new file/);
  assert.match(describeTrigger({ kind: 'clipboard', pattern: 'TODO' }), /clipboard/);
  assert.match(describeTrigger({ kind: 'command', command: 'x' }), /exits 0/);
  assert.match(describeTrigger({ kind: 'interval' }), /interval/);
  assert.match(describeTrigger({ kind: 'schedule', at: '07:30' }), /daily at 07:30/);
});

test('parseAt — HH:MM to minutes; junk → null', () => {
  assert.equal(parseAt('00:00'), 0);
  assert.equal(parseAt('07:30'), 450);
  assert.equal(parseAt('23:59'), 1439);
  assert.equal(parseAt('9:05'), 545);
  assert.equal(parseAt('24:00'), null);
  assert.equal(parseAt('12:60'), null);
  assert.equal(parseAt('noon'), null);
  assert.equal(parseAt(''), null);
});

// ── engine ──────────────────────────────────────────────────────────

const probes = (over = {}) => ({ listFiles: async () => [], readClipboard: async () => '', runCommand: async () => 1, ...over });

test('engine interval — fires every tick', async () => {
  const e = new WatchEngine({ kind: 'interval' }, probes());
  assert.ok(await e.check());
  assert.ok(await e.check());
});

test('engine file — baselines first tick, then fires only on a new file', async () => {
  let files = ['/a.txt'];
  const e = new WatchEngine({ kind: 'file', glob: '*' }, probes({ listFiles: async () => files }));
  assert.equal(await e.check(), null, 'pre-existing files do not fire');
  files = ['/a.txt', '/b.txt'];
  const hit = await e.check();
  assert.ok(hit);
  assert.equal(hit.context.file, '/b.txt');
  assert.equal(await e.check(), null, 'no new file → no fire');
});

test('engine clipboard — fires on changed + matching, not on unchanged or non-matching', async () => {
  let clip = '';
  const e = new WatchEngine({ kind: 'clipboard', pattern: 'TODO:' }, probes({ readClipboard: async () => clip }));
  assert.equal(await e.check(), null);
  clip = 'random text';
  assert.equal(await e.check(), null, 'changed but no match');
  clip = 'TODO: ship it';
  const hit = await e.check();
  assert.ok(hit);
  assert.equal(hit.context.match, 'TODO:');
  assert.equal(await e.check(), null, 'unchanged → no re-fire');
});

test('engine command — fires only on the rising edge', async () => {
  let code = 1;
  const e = new WatchEngine({ kind: 'command', command: 'x' }, probes({ runCommand: async () => code }));
  assert.equal(await e.check(), null, 'failing → no fire');
  code = 0;
  assert.ok(await e.check(), 'newly succeeds → fire');
  assert.equal(await e.check(), null, 'still passing → no re-fire');
  code = 1; await e.check();
  code = 0;
  assert.ok(await e.check(), 'succeeds again after failing → fire again');
});

test('engine schedule — fires once per day at/after the mark; a missed mark is skipped, not back-fired', async () => {
  let now = new Date(2026, 6, 2, 8, 0); // 08:00, before the 09:00 mark
  const e = new WatchEngine({ kind: 'schedule', at: '09:00' }, probes({ now: () => now }));
  assert.equal(await e.check(), null, 'before the mark → no fire');
  now = new Date(2026, 6, 2, 9, 0);
  assert.ok(await e.check(), 'at the mark → fire');
  now = new Date(2026, 6, 2, 14, 30);
  assert.equal(await e.check(), null, 'later the same day → no re-fire');
  now = new Date(2026, 6, 3, 9, 1);
  assert.ok(await e.check(), 'next day past the mark → fires again');
});

test('engine schedule — daemon started AFTER the mark treats today as missed (cron semantics)', async () => {
  let now = new Date(2026, 6, 2, 14, 0); // first look is already past 09:00
  const e = new WatchEngine({ kind: 'schedule', at: '09:00' }, probes({ now: () => now }));
  assert.equal(await e.check(), null, 'first look past the mark → baseline, no fire');
  now = new Date(2026, 6, 2, 18, 0);
  assert.equal(await e.check(), null, 'still today → no fire');
  now = new Date(2026, 6, 3, 9, 0);
  assert.ok(await e.check(), 'tomorrow at the mark → fires');
});
