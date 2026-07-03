// Auto-crystallize (src/learn.ts) — the pure learning logic (similarity,
// clustering, naming, the promotion decision) plus the history store and
// the full recordRunAndMaybeLearn hook against a temp HOME. The run.ts
// wiring is exercised live (it drives a real model).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'hands-learn-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HANDS_QUIET = '1';
delete process.env.HANDS_NO_LEARN;

const {
  promptTokens, promptSimilarity, similarRuns, clusterRuns, suggestMacroName,
  decideLearn, appendRunHistory, readRunHistory, recordRunAndMaybeLearn,
  buildSuggestions, isReplaySafeTrajectory,
  LEARN_THRESHOLD, LEARN_WINDOW_MS, SIM_THRESHOLD, MAX_PROMOTE_STEPS,
} = await import('../dist/learn.js');
const { loadMacro } = await import('../dist/macros.js');

const NOW = 1751500000000;

// ── similarity ──────────────────────────────────────────────────────

test('promptTokens — lowercased, punctuation-stripped, stopwords dropped', () => {
  assert.deepEqual(promptTokens('Open Spotify, and play my Discover Weekly!'), ['open', 'spotify', 'play', 'discover', 'weekly']);
});

test('promptSimilarity — paraphrases cluster, unrelated tasks do not', () => {
  assert.ok(promptSimilarity(
    'open spotify and play discover weekly',
    'open Spotify, play my discover weekly',
  ) >= SIM_THRESHOLD, 'paraphrase ≥ threshold');
  assert.ok(promptSimilarity(
    'pull main and run the tests',
    'rename the screenshots by their dimensions',
  ) < SIM_THRESHOLD, 'unrelated < threshold');
  assert.equal(promptSimilarity('', 'anything'), 0);
});

test('similarRuns — matches inside the window only', () => {
  const history = [
    { ts: NOW - LEARN_WINDOW_MS - 1000, prompt: 'open spotify and play discover weekly', mode: 'sdk', ok: true },
    { ts: NOW - 1000, prompt: 'open spotify play discover weekly', mode: 'sdk', ok: true },
    { ts: NOW - 500, prompt: 'completely different task about invoices', mode: 'sdk', ok: true },
  ];
  const similar = similarRuns('open spotify and play my discover weekly', history, NOW);
  assert.equal(similar.length, 1, 'expired and unrelated entries do not count');
});

test('clusterRuns — greedy grouping into repeat clusters', () => {
  const history = [
    { ts: NOW - 3000, prompt: 'pull main and run the tests', mode: 'sdk', ok: true },
    { ts: NOW - 2000, prompt: 'pull main, run tests', mode: 'sdk', ok: true },
    { ts: NOW - 1000, prompt: 'open spotify', mode: 'cli', ok: true },
  ];
  const clusters = clusterRuns(history, NOW);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 2);
});

test('suggestMacroName — slug from significant tokens, collision-deduped', () => {
  assert.equal(suggestMacroName('Pull main and run the tests', []), 'auto-pull-main-run');
  assert.equal(suggestMacroName('Pull main and run the tests', ['auto-pull-main-run']), 'auto-pull-main-run-2');
  assert.equal(suggestMacroName('!!!', []), 'auto-task', 'no significant tokens → fallback');
});

// ── the decision ────────────────────────────────────────────────────

const seen = (n, prompt = 'pull main and run the tests') =>
  Array.from({ length: n }, (_, i) => ({ ts: NOW - (n - i) * 1000, prompt, mode: 'sdk', ok: true }));

const DECIDE = { prompt: 'pull main and run the tests', ok: true, stepCount: 3, replaySafe: true, liveMacros: new Set(), nowTs: NOW, enabled: true };

test('decideLearn — third sighting promotes', () => {
  assert.equal(decideLearn({ ...DECIDE, history: seen(1) }).kind, 'none', '2nd total → not yet');
  const third = decideLearn({ ...DECIDE, history: seen(LEARN_THRESHOLD - 1) });
  assert.equal(third.kind, 'promoted');
  assert.equal(third.cluster, LEARN_THRESHOLD);
});

test('decideLearn — a live macro on the cluster means reminder, never a second macro', () => {
  const history = [...seen(3)];
  history[1] = { ...history[1], macro: 'auto-pull-main-run' };
  const out = decideLearn({ ...DECIDE, history, liveMacros: new Set(['auto-pull-main-run']) });
  assert.equal(out.kind, 'reminder');
  assert.equal(out.macroName, 'auto-pull-main-run');
});

test('decideLearn — a DELETED macro stops reminding and allows re-promotion', () => {
  const history = [...seen(3)];
  history[1] = { ...history[1], macro: 'auto-pull-main-run' };
  const out = decideLearn({ ...DECIDE, history, liveMacros: new Set() });
  assert.equal(out.kind, 'promoted', 'user removed the macro → learning starts over');
});

test('decideLearn — failed runs, empty/oversized/unsafe trajectories, and disabled learning never promote', () => {
  assert.equal(decideLearn({ ...DECIDE, history: seen(5), ok: false }).kind, 'none');
  assert.equal(decideLearn({ ...DECIDE, history: seen(5), stepCount: 0 }).kind, 'none');
  assert.equal(decideLearn({ ...DECIDE, history: seen(5), stepCount: MAX_PROMOTE_STEPS + 1 }).kind, 'none');
  assert.equal(decideLearn({ ...DECIDE, history: seen(5), replaySafe: false }).kind, 'none');
  assert.equal(decideLearn({ ...DECIDE, history: seen(5), enabled: false }).kind, 'none');
});

test('isReplaySafeTrajectory — multiline bash is unsafe on Windows, fine on POSIX; non-bash steps never taint', () => {
  const multiline = [{ tool: 'bash', input: { command: 'powershell -Command "\n$x = 1\n"' } }];
  const clean = [{ tool: 'bash', input: { command: 'powershell -Command "Get-Date"' } }];
  const edit = [{ tool: 'str_replace_based_edit_tool', input: { command: 'create', path: '/x', file_text: 'a\nb\nc' } }];
  assert.equal(isReplaySafeTrajectory(multiline, 'win32'), false);
  assert.equal(isReplaySafeTrajectory(multiline, 'linux'), true);
  assert.equal(isReplaySafeTrajectory(clean, 'win32'), true);
  assert.equal(isReplaySafeTrajectory(edit, 'win32'), true, 'newlines in file CONTENT are fine — only bash commands split under cmd');
});

test('decideLearn — sightings outside the window do not count', () => {
  const stale = seen(5).map((h) => ({ ...h, ts: NOW - LEARN_WINDOW_MS - 1000 }));
  assert.equal(decideLearn({ ...DECIDE, history: stale }).kind, 'none');
});

// ── history store ───────────────────────────────────────────────────

test('run history — append/read round-trip, torn lines skipped', async () => {
  assert.deepEqual(await readRunHistory(), []);
  await appendRunHistory({ ts: NOW, prompt: 'first', mode: 'sdk', ok: true, turns: 4, costUsd: 0.02 });
  await appendRunHistory({ ts: NOW + 1, prompt: 'second', mode: 'cli', ok: false });
  const { appendFile } = await import('node:fs/promises');
  const { historyPath } = await import('../dist/learn.js');
  await appendFile(historyPath(), '{torn json\n');
  const history = await readRunHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].prompt, 'first');
  assert.equal(history[1].ok, false);
});

// ── the full hook ───────────────────────────────────────────────────

const STEPS = [
  { tool: 'bash', input: { command: 'echo learned-ok' } },
  { tool: 'bash', input: { command: 'echo learned-too' } },
];

test('recordRunAndMaybeLearn — 1st and 2nd runs record history; 3rd promotes a real macro; 4th reminds', async () => {
  const prompt = 'create the pulse file and print it';
  const one = await recordRunAndMaybeLearn({ prompt, mode: 'sdk', ok: true, turns: 3, costUsd: 0.01, steps: STEPS });
  assert.equal(one.kind, 'none');
  const two = await recordRunAndMaybeLearn({ prompt: 'create pulse file, print it', mode: 'sdk', ok: true, steps: STEPS });
  assert.equal(two.kind, 'none');

  const three = await recordRunAndMaybeLearn({ prompt, mode: 'sdk', ok: true, steps: STEPS });
  assert.equal(three.kind, 'promoted');
  assert.equal(three.steps, 2);
  const macro = await loadMacro(three.macroName);
  assert.deepEqual(macro.steps, STEPS, 'the shadow trajectory IS the macro');
  assert.equal(macro.prompt, prompt);

  const four = await recordRunAndMaybeLearn({ prompt, mode: 'sdk', ok: true, steps: STEPS });
  assert.equal(four.kind, 'reminder');
  assert.equal(four.macroName, three.macroName);

  const history = await readRunHistory();
  assert.equal(history.filter((h) => h.macro === three.macroName).length, 1, 'only the promoting run carries the macro link');
});

test('recordRunAndMaybeLearn — HANDS_NO_LEARN keeps history but silences the automation', async () => {
  process.env.HANDS_NO_LEARN = '1';
  try {
    const before = (await readRunHistory()).length;
    const out = await recordRunAndMaybeLearn({ prompt: 'a brand new muted task', mode: 'sdk', ok: true, steps: STEPS });
    assert.equal(out.kind, 'none');
    assert.equal((await readRunHistory()).length, before + 1, 'history still recorded');
  } finally {
    delete process.env.HANDS_NO_LEARN;
  }
});

// ── suggestions ─────────────────────────────────────────────────────

test('buildSuggestions — repeat clusters only, macro-covered flagged, biggest first', () => {
  const history = [
    ...seen(3, 'pull main and run the tests'),
    { ts: NOW - 900, prompt: 'open spotify play discover weekly', mode: 'cli', ok: true, costUsd: 0.05 },
    { ts: NOW - 800, prompt: 'open spotify and play my discover weekly', mode: 'cli', ok: true, costUsd: 0.07 },
    { ts: NOW - 700, prompt: 'a one-off task nobody repeats', mode: 'sdk', ok: true },
    { ts: NOW - 600, prompt: 'pull main, run tests', mode: 'sdk', ok: true, macro: 'auto-pull-main-run' },
  ];
  const s = buildSuggestions(history, new Set(['auto-pull-main-run']), NOW);
  assert.equal(s.length, 2, 'singletons excluded');
  assert.equal(s[0].count, 4, 'biggest cluster first');
  assert.equal(s[0].macro, 'auto-pull-main-run', 'covered cluster points at its macro');
  assert.equal(s[1].macro, undefined);
  assert.ok(Math.abs(s[1].totalCostUsd - 0.12) < 1e-9, 'cluster cost summed');
  assert.match(s[1].suggestedName, /^auto-open-spotify/);
});
