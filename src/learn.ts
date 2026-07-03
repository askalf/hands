// Auto-crystallize — hands learns your workflows. Every task you run costs
// LLM calls; most people run the same handful of tasks over and over. This
// module watches for that: each `hands run` lands in a local run history,
// and when a task shows up for the THIRD time, the effectful steps hands
// just executed (shadow-captured at the SDK dispatch site — the same
// mechanism as --record) are promoted into a macro automatically:
//
//   ✨ learned: 3rd similar run — crystallized 4 steps → macro "auto-pull-main-tests"
//
// From then on the task replays at $0, and repeat runs get a reminder that
// the free path exists. The system gets cheaper the more you use it.
//
// Everything is local (~/.hands/history.jsonl, 0600) and deterministic —
// similarity is token overlap, not an LLM call. Promotion only happens for
// single-task runs that succeeded with a small, clean step trajectory;
// anything else degrades to `hands suggest`, which lists what's worth
// crystallizing by hand. Set HANDS_NO_LEARN=1 (or `"learn": false` in
// ~/.hands/config.json) to keep the history but silence the automation.
//
// Pure logic (normalization, similarity, clustering, naming, the
// promotion decision) is exported for unit tests; fs I/O follows the
// audit-log pattern (paths computed per call, rotation at 5MB).

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './util/config.js';
import { saveMacro, listMacroNames, isValidMacroName, type MacroStep } from './macros.js';

/** Third strike promotes. */
export const LEARN_THRESHOLD = 3;
/** Only runs inside this window count toward the threshold. */
export const LEARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Token-overlap similarity at/above this = "the same task". */
export const SIM_THRESHOLD = 0.65;
/** A shadow trajectory longer than this is a session, not a task — never promoted. */
export const MAX_PROMOTE_STEPS = 50;

export interface RunHistoryEntry {
  ts: number;
  prompt: string;
  mode: 'cli' | 'sdk';
  ok: boolean;
  turns?: number | undefined;
  costUsd?: number | undefined;
  /** Set when this run was promoted into (or reminded about) a macro. */
  macro?: string | undefined;
}

// ── pure: similarity ────────────────────────────────────────────────

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'my', 'me', 'it', 'then', 'please', 'that', 'this', 'with', 'for', 'into']);

/** Lowercase, strip punctuation, drop stopwords → significant tokens. Pure. */
export function promptTokens(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity of significant-token sets — 1 = same task in
 * different words, 0 = unrelated. Deterministic and $0 by design: the
 * learning loop must never spend model calls to save model calls. Pure.
 */
export function promptSimilarity(a: string, b: string): number {
  const ta = new Set(promptTokens(a));
  const tb = new Set(promptTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** History entries that are "the same task" as `prompt`, newest kept. Pure. */
export function similarRuns(prompt: string, history: RunHistoryEntry[], nowTs: number): RunHistoryEntry[] {
  const cutoff = nowTs - LEARN_WINDOW_MS;
  return history.filter((h) => h.ts >= cutoff && promptSimilarity(prompt, h.prompt) >= SIM_THRESHOLD);
}

/** Greedy clustering of history into repeat groups (for `hands suggest`). Pure. */
export function clusterRuns(history: RunHistoryEntry[], nowTs: number): RunHistoryEntry[][] {
  const cutoff = nowTs - LEARN_WINDOW_MS;
  const clusters: RunHistoryEntry[][] = [];
  for (const h of history) {
    if (h.ts < cutoff) continue;
    const home = clusters.find((c) => promptSimilarity(h.prompt, c[0]!.prompt) >= SIM_THRESHOLD);
    if (home) home.push(h);
    else clusters.push([h]);
  }
  return clusters;
}

/** `auto-<first-significant-tokens>`, deduped against existing names. Pure. */
export function suggestMacroName(prompt: string, existing: Iterable<string>): string {
  const tokens = promptTokens(prompt).slice(0, 3);
  let base = tokens.length ? `auto-${tokens.join('-')}`.slice(0, 48).replace(/-+$/, '') : 'auto-task';
  if (!isValidMacroName(base)) base = 'auto-task';
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Auto-created macros must clear a higher bar than hand-recorded ones: the
 * user never reviewed them. On Windows, a bash command carrying embedded
 * newlines executes unreliably under cmd's line splitting (seen live: a
 * multiline `powershell -Command` worked in the run, then failed on
 * replay) — such trajectories are never auto-promoted; they stay in
 * `hands suggest` for an explicit --record. POSIX `sh -c` handles
 * multiline fine. Pure.
 */
export function isReplaySafeTrajectory(steps: MacroStep[], platform: string = process.platform): boolean {
  if (platform !== 'win32') return true;
  return !steps.some((s) => {
    const c = s.input['command'];
    return s.tool === 'bash' && typeof c === 'string' && /[\r\n]/.test(c);
  });
}

export interface LearnOutcome {
  kind: 'none' | 'promoted' | 'reminder';
  /** promoted: the new macro. reminder: the existing macro to replay. */
  macroName?: string | undefined;
  /** promoted: how many steps crystallized. */
  steps?: number | undefined;
  /** How many similar runs (including this one) drove the outcome. */
  cluster?: number | undefined;
}

/**
 * The promotion decision, given this run and its history — no I/O. Pure.
 * Reminder beats promotion (never mint a second macro for a cluster whose
 * macro still exists); promotion needs a successful run with a small,
 * non-empty shadow trajectory and LEARN_THRESHOLD total sightings.
 */
export function decideLearn(input: {
  prompt: string;
  ok: boolean;
  stepCount: number;
  /** From isReplaySafeTrajectory — an unsafe trajectory is never auto-promoted. */
  replaySafe: boolean;
  history: RunHistoryEntry[];
  liveMacros: Set<string>;
  nowTs: number;
  enabled: boolean;
}): LearnOutcome {
  const similar = similarRuns(input.prompt, input.history, input.nowTs);
  const cluster = similar.length + 1;
  if (!input.enabled) return { kind: 'none', cluster };
  const remembered = [...similar].reverse().find((h) => h.macro && input.liveMacros.has(h.macro));
  if (remembered) return { kind: 'reminder', macroName: remembered.macro, cluster };
  if (input.ok && input.replaySafe && input.stepCount >= 1 && input.stepCount <= MAX_PROMOTE_STEPS && cluster >= LEARN_THRESHOLD) {
    return { kind: 'promoted', steps: input.stepCount, cluster };
  }
  return { kind: 'none', cluster };
}

// ── fs: run history ─────────────────────────────────────────────────

export function historyPath(): string {
  return join(homedir(), '.hands', 'history.jsonl');
}

const HISTORY_MAX_BYTES = 5 * 1024 * 1024;

/** Append one run; rotate to .1 at 5MB. Never throws — bookkeeping must not fail a run. */
export async function appendRunHistory(entry: RunHistoryEntry): Promise<void> {
  try {
    await mkdir(join(homedir(), '.hands'), { recursive: true, mode: 0o700 });
    const path = historyPath();
    try {
      const s = await stat(path);
      if (s.size > HISTORY_MAX_BYTES) await rename(path, path + '.1');
    } catch { /* no history yet */ }
    await writeFile(path, JSON.stringify(entry) + '\n', { flag: 'a', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[hands.learn] history append failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function readRunHistory(): Promise<RunHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath(), 'utf-8');
  } catch {
    return [];
  }
  const out: RunHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RunHistoryEntry;
      if (typeof e.prompt === 'string' && typeof e.ts === 'number') out.push(e);
    } catch { /* skip torn line */ }
  }
  return out;
}

// ── the hook `run()` calls ──────────────────────────────────────────

async function learningEnabled(): Promise<boolean> {
  if (process.env['HANDS_NO_LEARN']) return false;
  return (await loadConfig()).learn !== false;
}

/**
 * Record one finished run and apply the learning loop. Returns what
 * happened so the caller owns the announcement. Never throws.
 */
export async function recordRunAndMaybeLearn(input: {
  prompt: string;
  mode: 'cli' | 'sdk';
  ok: boolean;
  turns?: number | undefined;
  costUsd?: number | undefined;
  /** Shadow-captured effectful steps (SDK runs only). */
  steps?: MacroStep[] | undefined;
}): Promise<LearnOutcome> {
  try {
    const nowTs = Date.now();
    const history = await readRunHistory();
    const liveMacros = new Set(await listMacroNames());
    const outcome = decideLearn({
      prompt: input.prompt,
      ok: input.ok,
      stepCount: input.steps?.length ?? 0,
      replaySafe: input.steps ? isReplaySafeTrajectory(input.steps) : false,
      history,
      liveMacros,
      nowTs,
      enabled: await learningEnabled(),
    });

    let macroName: string | undefined;
    if (outcome.kind === 'promoted' && input.steps) {
      macroName = suggestMacroName(input.prompt, liveMacros);
      await saveMacro({ name: macroName, prompt: input.prompt, platform: process.platform, createdAt: nowTs, steps: input.steps });
      outcome.macroName = macroName;
    }
    await appendRunHistory({
      ts: nowTs,
      prompt: input.prompt,
      mode: input.mode,
      ok: input.ok,
      ...(input.turns !== undefined ? { turns: input.turns } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(macroName ? { macro: macroName } : {}),
    });
    return outcome;
  } catch (err) {
    process.stderr.write(`[hands.learn] learning hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { kind: 'none' };
  }
}

// ── `hands suggest` ─────────────────────────────────────────────────

export interface Suggestion {
  prompt: string;
  count: number;
  totalCostUsd: number;
  /** The $0 macro that already covers this task, when one exists. */
  macro?: string | undefined;
  suggestedName: string;
}

/** Repeat clusters worth crystallizing (or already crystallized), biggest first. Pure. */
export function buildSuggestions(history: RunHistoryEntry[], liveMacros: Set<string>, nowTs: number): Suggestion[] {
  const clusters = clusterRuns(history, nowTs).filter((c) => c.length >= 2);
  const suggestions = clusters.map((c) => {
    const latest = c[c.length - 1]!;
    const withMacro = [...c].reverse().find((h) => h.macro && liveMacros.has(h.macro));
    return {
      prompt: latest.prompt,
      count: c.length,
      totalCostUsd: c.reduce((sum, h) => sum + (h.costUsd ?? 0), 0),
      ...(withMacro ? { macro: withMacro.macro } : {}),
      suggestedName: suggestMacroName(latest.prompt, liveMacros),
    };
  });
  return suggestions.sort((a, b) => b.count - a.count || b.totalCostUsd - a.totalCostUsd);
}
