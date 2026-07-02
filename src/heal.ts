// Self-healing replay — the repair engine behind `hands play --heal`.
//
// A macro is deterministic automation: $0, instant, no model. Its weakness
// is drift — the world changes under it (a file moves, a button renames, a
// command's flags change) and a step starts failing. Without heal, that's
// where a human re-runs the LLM. With heal, hands brings the model back for
// a BOUNDED repair of just the failed step — same guardrails, same audit,
// optionally warden-gated — then the replay continues deterministically.
// `--commit` writes the repaired step(s) back into the macro, so the next
// `hands play` is back to $0. Automation that converges instead of rotting.
//
// This module is the pure prompt/verdict/rewrite logic (unit-tested) plus
// the healer factory that wires config, dario routing, credentials, and the
// optional warden gate. The replay loop that calls it lives in macro-run.ts.

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type AgentConfig } from './util/config.js';
import { autoDetectDario } from './dario-detect.js';
import { hasSdkCredentials } from './run.js';
import { runSdkMode } from './sdk-mode.js';
import { MacroRecorder, previewStep, type Macro, type MacroStep } from './macros.js';
import type { WardenGate } from './util/warden.js';
import type { GuardController } from './util/guard.js';
import * as output from './util/output.js';

/**
 * A repair is scoped to ONE step, so it gets a fraction of a full run's
 * turn budget. Enough to explore around a fix and still have the final
 * text turn the verdict rides on (a repair that runs out of turns after
 * executing the fix but before saying REPAIRED counts as failed — seen
 * live at 15); not enough to wander off and redo the whole task.
 */
export const HEAL_MAX_TURNS = 20;

/** How much of the failing step's raw input the healer gets to see. */
const MAX_INPUT_CHARS = 2000;
const MAX_ERROR_CHARS = 500;

// ── pure: the repair prompt ─────────────────────────────────────────

/**
 * Build the healer's task: the macro's original intent, the replay
 * position (done / FAILED / still-to-run), the failing step's full input
 * and error, and the rules — repair ONLY this step, prefer the smallest
 * fix, end with a machine-checkable verdict. Pure.
 */
export function buildHealPrompt(macro: Macro, failedIndex: number, error: string): string {
  const lines: string[] = [];
  lines.push(`You are repairing ONE failed step of "${macro.name}" — a recorded automation being replayed deterministically (a hands macro).`);
  if (macro.prompt) lines.push(`The macro's original task: "${macro.prompt}"`);
  lines.push('');
  lines.push('Replay position (✓ already replayed · ▶ FAILED — yours to repair · ○ replays after you):');
  for (let i = 0; i < macro.steps.length; i++) {
    const mark = i < failedIndex ? '✓' : i === failedIndex ? '▶' : '○';
    lines.push(`  ${mark} ${i + 1}. ${previewStep(macro.steps[i]!)}`);
  }
  lines.push('');
  const failed = macro.steps[failedIndex]!;
  const rawInput = JSON.stringify(failed.input);
  lines.push(`The failed step's full input: ${rawInput.length > MAX_INPUT_CHARS ? rawInput.slice(0, MAX_INPUT_CHARS) + '… (truncated)' : rawInput}`);
  lines.push(`The error: ${error.length > MAX_ERROR_CHARS ? error.slice(0, MAX_ERROR_CHARS) + '… (truncated)' : error}`);
  lines.push('');
  lines.push(`Achieve step ${failedIndex + 1}'s intent in the current environment. Rules:`);
  lines.push('- Start from the failing step\'s own input — the paths, names, and flags it used. The fix is usually nearby (a renamed file in the same folder, a moved control, a changed flag). Do not explore broadly.');
  lines.push('- Your turn budget is small. Once the step\'s intent is verified, state your verdict IMMEDIATELY — running out of turns before the verdict counts as a failed repair.');
  lines.push('- Do ONLY this step\'s work. The ○ steps replay automatically after you finish — do not do them.');
  lines.push('- Every effectful action that succeeds (bash, file edits, clicks, keystrokes) is recorded as the step\'s repair and will be replayed on future runs. Explore with the read-only tools (find_files, read_page, ui_tree, screenshot) — use effectful actions only for the fix itself.');
  lines.push('- Prefer the smallest fix: a corrected version of the same action beats a new approach.');
  lines.push('- If the step\'s goal is already satisfied, verify that with a real check and change nothing.');
  lines.push('- End your final message with exactly REPAIRED if the step\'s intent is now satisfied, or COULD-NOT-REPAIR if you could not achieve it.');
  return lines.join('\n');
}

// ── pure: the verdict ───────────────────────────────────────────────

/**
 * Did the healer claim success? The sentinel must sit at the TAIL of the
 * final message (last 200 chars), so a mid-transcript mention of the
 * words can't flip the verdict; COULD-NOT-REPAIR always wins. Pure.
 */
export function parseHealVerdict(text: string): boolean {
  const tail = text.trim().slice(-200).toUpperCase();
  if (tail.includes('COULD-NOT-REPAIR')) return false;
  return tail.includes('REPAIRED');
}

// ── pure: repair distillation ───────────────────────────────────────

/**
 * The healer's successful effectful trajectory includes exploration —
 * directory listings, version checks — that succeeded and so got
 * recorded. Distillation asks the model ONE tool-less question: which of
 * these effects must replay to reproduce the repair? Build that
 * question. Pure.
 */
export function buildDistillPrompt(macro: Macro, failedIndex: number, steps: MacroStep[]): string {
  const lines: string[] = [];
  lines.push(`A failed step of the automation "${macro.name}"${macro.prompt ? ` (task: "${macro.prompt}")` : ''} was just repaired.`);
  lines.push(`The broken step was: ${previewStep(macro.steps[failedIndex]!)}`);
  lines.push('');
  lines.push('The repair fired these effectful actions, in order:');
  for (let i = 0; i < steps.length; i++) {
    const raw = JSON.stringify(steps[i]!.input);
    lines.push(`  ${i + 1}. ${previewStep(steps[i]!)}`);
    lines.push(`     input: ${raw.length > 500 ? raw.slice(0, 500) + '… (truncated)' : raw}`);
  }
  lines.push('');
  lines.push('These actions will be saved and REPLAYED VERBATIM on every future run of the automation, in place of the broken step. Which must be kept so the replay reproduces the repair?');
  lines.push('- Keep an action only if its EFFECT is required — commands that were run to look around (directory listings, file reads, version or existence checks, echoes for inspection) are not.');
  lines.push('- Keep every action you are unsure about.');
  lines.push('- Reply with ONLY a JSON object of 1-based indices, e.g. {"keep":[2,3]}. An empty list means no effect needs to replay.');
  return lines.join('\n');
}

/**
 * Parse the distiller's reply into 0-based step indices to keep —
 * deduplicated, in order. Accepts `{"keep":[…]}` or a bare array,
 * tolerating prose around the JSON. Returns null on anything invalid or
 * out of range: the caller MUST fail open (keep every step) — a garbled
 * reply must never shrink a repair. Pure.
 */
export function parseDistillReply(text: string, stepCount: number): number[] | null {
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  let candidate: string | undefined;
  if (objStart !== -1 && objEnd > objStart) candidate = text.slice(objStart, objEnd + 1);
  else if (arrStart !== -1 && arrEnd > arrStart) candidate = text.slice(arrStart, arrEnd + 1);
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)['keep'];
  if (!Array.isArray(list)) return null;
  const kept = new Set<number>();
  for (const v of list) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > stepCount) return null;
    kept.add(v - 1);
  }
  return [...kept].sort((a, b) => a - b);
}

// ── pure: rewriting the macro ───────────────────────────────────────

export interface StepRepair {
  /** Index into the macro's ORIGINAL steps array. */
  index: number;
  /** The effectful steps the healer fired — replaces the failed step. */
  steps: MacroStep[];
}

/**
 * Splice each repair's replacement steps over its failed step. Indices
 * refer to the ORIGINAL steps array, so repairs apply highest-index
 * first and can't shift each other. Pure — the caller decides whether
 * to save.
 */
export function applyRepairs(macro: Macro, repairs: StepRepair[]): Macro {
  const steps = [...macro.steps];
  for (const r of [...repairs].sort((a, b) => b.index - a.index)) {
    steps.splice(r.index, 1, ...r.steps);
  }
  return { ...macro, steps };
}

// ── the healer ──────────────────────────────────────────────────────

export interface HealOutcome {
  /** True when the healer ended with the REPAIRED verdict. */
  ok: boolean;
  /** Effectful steps the healer fired — the commit candidate (may be empty when the goal was already satisfied). */
  steps: MacroStep[];
  turns: number;
  costUsd: number;
}

export interface Healer {
  heal(macro: Macro, failedIndex: number, error: string): Promise<HealOutcome>;
  /** Release the guard prompt's stdin hook, if warden attached one. */
  close(): void;
  /** warden's allowed/approved/denied/blocked tally, when gated. */
  summary(): string | undefined;
}

export interface CreateHealerOptions {
  /** Gate the healer's tool calls through warden's policy firewall. */
  warden?: boolean | undefined;
  /** Skip the dario auto-detect probe. */
  noDario?: boolean | undefined;
  /** TEST HOOKS — forwarded to runSdkMode so the repair loop is testable without an API key or display. */
  testHooks?: {
    testClient?: { beta: { messages: { create: (req: unknown) => Promise<unknown> } } } | undefined;
    testScreen?: { width: number; height: number; screenshot: () => Promise<{ data: string; mediaType: 'image/png' | 'image/jpeg' }> } | undefined;
  } | undefined;
}

/**
 * Wire up a healer once per replay: dario routing, credential check
 * (fail fast BEFORE any step runs — discovering missing creds at step 7
 * wastes the first 6), turn clamp, optional warden gate. Throws with a
 * fix-it message when SDK credentials are missing.
 */
export async function createHealer(opts: CreateHealerOptions = {}): Promise<Healer> {
  const dario = await autoDetectDario({ disabled: !!opts.noDario });
  if (dario.detected) output.info(dario.detail);

  const config = await loadConfig();
  if (!hasSdkCredentials(config.apiKey)) {
    throw new Error(
      '--heal brings the model back on a failed step, which runs in SDK mode — and no API key is configured. ' +
      'Run `hands auth` to add a key, set ANTHROPIC_API_KEY in the environment (e.g. for dario routing), or drop --heal.',
    );
  }
  // Repairs are single-step: clamp the turn budget so a drifted macro
  // can't silently burn a full run's worth of model calls per step.
  const healConfig: AgentConfig = {
    ...config,
    authMode: 'api_key',
    maxTurns: Math.min(config.maxTurns, HEAL_MAX_TURNS),
  };

  let wardenGate: WardenGate | undefined;
  let guardHandle: { guard: GuardController; close: () => void } | undefined;
  if (opts.warden) {
    const { createWardenGate, wardenPaths } = await import('./util/warden.js');
    // Red-tier approvals reuse the guard prompt, but only when a TTY is
    // attached; unattended (a watcher, cron), red fails closed.
    const interactive = process.stdin.isTTY === true;
    if (interactive) {
      const { createTerminalGuard } = await import('./util/guard.js');
      guardHandle = createTerminalGuard();
    }
    try {
      wardenGate = await createWardenGate({
        ...(guardHandle ? { guard: guardHandle.guard } : {}),
        out: (line: string) => output.info(line),
      });
    } catch (err) {
      guardHandle?.close();
      throw err instanceof Error ? err : new Error(String(err));
    }
    output.info(
      `warden firewall gates the healer — ${interactive ? 'red-tier actions prompt for approval' : 'unattended: red-tier fails closed'}. Policy: ${wardenPaths().policy}`,
    );
  }

  // Distillation reuses the run's endpoint (dario when detected) and the
  // same client shape the SDK loop uses, so the test hook covers it too.
  const distillClient = opts.testHooks?.testClient
    ?? (config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : new Anthropic());

  /**
   * One tool-less model call: which of the repair's effects must replay?
   * FAIL OPEN on any error or unusable reply — a garbled distillation
   * must never shrink a repair. And even a wrong drop self-corrects: the
   * step fails on the next play and heals again.
   */
  async function distill(macro: Macro, failedIndex: number, steps: MacroStep[]): Promise<MacroStep[]> {
    try {
      const response = await distillClient.beta.messages.create({
        model: healConfig.model,
        max_tokens: 500,
        messages: [{ role: 'user', content: buildDistillPrompt(macro, failedIndex, steps) }],
      }) as { content?: Array<{ type: string; text?: string }> };
      const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      const keep = parseDistillReply(text, steps.length);
      if (keep === null) {
        output.warn('  ⛑ distillation reply unusable — keeping the full repair trajectory.');
        return steps;
      }
      if (keep.length < steps.length) {
        output.info(`  ⛑ distilled repair: kept ${keep.length} of ${steps.length} step${keep.length === 1 ? '' : 's'} (dropped ${steps.length - keep.length} inspection-only).`);
      }
      return keep.map((i) => steps[i]!);
    } catch (err) {
      output.warn(`  ⛑ distillation errored (${err instanceof Error ? err.message : String(err)}) — keeping the full repair trajectory.`);
      return steps;
    }
  }

  return {
    async heal(macro, failedIndex, error) {
      const recorder = new MacroRecorder();
      // verify: the healer must prove the step's intent with a real check
      // before claiming REPAIRED — the verdict rides on a passed check,
      // not vibes. The verify tool itself is never recorded into macros.
      const result = await runSdkMode(buildHealPrompt(macro, failedIndex, error), healConfig, {
        recorder,
        verify: true,
        ...(wardenGate ? { warden: wardenGate } : {}),
        ...(opts.testHooks?.testClient ? { testClient: opts.testHooks.testClient } : {}),
        ...(opts.testHooks?.testScreen ? { testScreen: opts.testHooks.testScreen } : {}),
      });
      const ok = parseHealVerdict(result.text);
      // A single-step repair IS the fix; only a multi-step trajectory can
      // carry exploration worth distilling out.
      const steps = ok && recorder.steps.length > 1
        ? await distill(macro, failedIndex, recorder.steps)
        : recorder.steps;
      return {
        ok,
        steps,
        turns: result.turns,
        costUsd: result.costUsd,
      };
    },
    close() {
      guardHandle?.close();
    },
    summary() {
      return wardenGate?.summary();
    },
  };
}
