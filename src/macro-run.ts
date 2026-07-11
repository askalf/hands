// Deterministic macro replay — `hands play <name>`. Re-executes a recorded
// tool-call sequence with ZERO model calls. Bash and file edits are the
// deterministic backbone; coordinate clicks replay best-effort (scaled to
// the current screen, so they assume roughly the same layout as recording);
// semantic clicks (click_element, from --ui runs) re-resolve their target
// by NAME in the live accessibility tree, so they survive layout shifts.
//
// Every replayed call passes the same guardrail blocklist as a live run and
// is appended to ~/.hands/audit.jsonl (mode left as sdk). The model is never
// invoked — unless `--heal` is set, in which case a FAILED step brings it
// back for a bounded repair of just that step (see heal.ts), and `--commit`
// crystallizes the fix back into the macro.

import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import {
  mouseClick, mouseMove, mouseDoubleClick, mouseTripleClick, mouseScroll,
  mouseButtonEvent, mouseDrag,
} from './platform/mouse.js';
import { keyboardType, keyboardKey, keyboardHoldKey } from './platform/keyboard.js';
import { getScreenSize } from './platform/screen-info.js';
import { enumerateUiElements, findElements, elementCenter } from './ui.js';
import { checkCommand } from './util/guardrails.js';
import { appendAudit } from './util/audit.js';
import {
  loadMacro, saveMacro, applyMacroParams, stepHasPlaceholder, previewStep,
  type Macro, type MacroStep,
} from './macros.js';
import type { Healer, StepRepair } from './heal.js';
import * as output from './util/output.js';

const SCREENSHOT_MAX_WIDTH = 1280; // must match sdk-mode / screenshot.ts

export interface PlayOptions {
  params?: Record<string, string> | undefined;
  /** Print each step without executing it. */
  dryRun?: boolean | undefined;
  /** Stop the whole replay on the first failing step (default: continue). */
  stopOnError?: boolean | undefined;
  /** On a failing step, bring the model back to repair JUST that step (SDK mode, bounded turns), then continue the replay. */
  heal?: boolean | undefined;
  /** With heal: write repaired steps back into the macro after the replay. Steps carrying `{{params}}` are never rewritten. */
  commit?: boolean | undefined;
  /** With heal: gate the healer's tool calls through warden's policy firewall. */
  warden?: boolean | undefined;
}

export interface PlayResult {
  ran: number;
  failed: number;
  skipped: number;
  /** Steps a failing replay repaired via --heal. */
  healed: number;
}

/** Execute a saved macro deterministically. Returns per-step tallies. */
export async function playMacro(name: string, opts: PlayOptions = {}): Promise<PlayResult> {
  const macro = await loadMacro(name);
  const { macro: applied, missing } = applyMacroParams(macro, opts.params ?? {});
  if (missing.length) {
    const plural = missing.length === 1;
    output.error(`Macro "${name}" needs ${plural ? 'a parameter' : 'parameters'}: ${missing.join(', ')}.`);
    output.info(`Provide ${plural ? 'it' : 'them'} with ${missing.map((m) => `--set ${m}=…`).join(' ')}`);
    process.exit(1);
  }

  // Wire the healer BEFORE any step runs — missing SDK credentials should
  // fail fast, not surface after half the macro has already fired.
  let healer: Healer | undefined;
  if (opts.heal && !opts.dryRun) {
    const { createHealer } = await import('./heal.js');
    healer = await createHealer({ ...(opts.warden ? { warden: true } : {}) });
    output.info(`heal armed — a failing step brings the model back for a bounded repair${opts.commit ? ', repairs commit back to the macro' : ''}.`);
  }

  const scaleFactor = await coordinateScale(applied);

  output.header(`play macro: ${name}${applied.prompt ? ` — ${applied.prompt}` : ''} (${applied.steps.length} steps, no LLM)`);

  const result: PlayResult = { ran: 0, failed: 0, skipped: 0, healed: 0 };
  const repairs: StepRepair[] = [];
  try {
    for (let i = 0; i < applied.steps.length; i++) {
      const step = applied.steps[i]!;
      output.info(`▶ ${i + 1}/${applied.steps.length}  ${previewStep(step)}`);
      if (opts.dryRun) {
        result.skipped++;
        continue;
      }
      const start = Date.now();
      try {
        await runStep(step, scaleFactor);
        await appendAudit({ tool: step.tool, action: step.action, args: { macro: name }, durationMs: Date.now() - start, ok: true });
        result.ran++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.warn(`  step ${i + 1} failed: ${msg}`);
        await appendAudit({ tool: step.tool, action: step.action, args: { macro: name }, durationMs: Date.now() - start, ok: false, error: msg.slice(0, 200) });
        if (healer && (await tryHeal(healer, applied, i, msg, name, result, repairs))) continue;
        result.failed++;
        if (opts.stopOnError) break;
      }
    }
  } finally {
    healer?.close();
  }
  const wardenSummary = healer?.summary();
  if (wardenSummary) output.info(wardenSummary);

  if (opts.commit && repairs.length > 0) {
    await commitRepairs(macro, repairs);
  } else if (opts.commit && result.healed > 0) {
    output.info('nothing to commit — the healed steps fired no replacement actions (their goals were already satisfied).');
  }

  if (opts.dryRun) output.info(`(dry-run — ${result.skipped} steps previewed, nothing executed)`);
  else {
    const healedNote = result.healed > 0 ? `, ${result.healed} healed` : '';
    output.success(`macro "${name}" done — ${result.ran} ran${healedNote}, ${result.failed} failed.`);
  }
  return result;
}

/**
 * Run one bounded repair. Returns true when the healer verified the step's
 * intent (REPAIRED) — the caller then treats the step as done and moves on.
 * A healer error (endpoint down, warden policy unreadable) is a failed
 * heal, not a crashed replay.
 */
async function tryHeal(
  healer: Healer,
  applied: Macro,
  index: number,
  error: string,
  name: string,
  result: PlayResult,
  repairs: StepRepair[],
): Promise<boolean> {
  output.info(`  ⛑ healing step ${index + 1} — bringing the model back for a bounded repair…`);
  const start = Date.now();
  try {
    const outcome = await healer.heal(applied, index, error);
    await appendAudit({ tool: 'heal', args: { macro: name, step: index + 1 }, durationMs: Date.now() - start, ok: outcome.ok, ...(outcome.ok ? {} : { error: 'healer verdict: not repaired' }) });
    if (!outcome.ok) {
      output.warn(`  ⛑ step ${index + 1} not healed (${outcome.turns} turns).`);
      return false;
    }
    result.healed++;
    if (outcome.steps.length > 0) repairs.push({ index, steps: outcome.steps });
    const replaced = outcome.steps.length > 0 ? `${outcome.steps.length} replacement step${outcome.steps.length === 1 ? '' : 's'}` : 'no replacement needed';
    output.success(`  ⛑ step ${index + 1} healed — ${replaced} (${outcome.turns} turns, $${outcome.costUsd.toFixed(4)}).`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.warn(`  ⛑ heal errored for step ${index + 1}: ${msg}`);
    await appendAudit({ tool: 'heal', args: { macro: name, step: index + 1 }, durationMs: Date.now() - start, ok: false, error: msg.slice(0, 200) });
    return false;
  }
}

/**
 * Crystallize this replay's repairs back into the macro — the next `play`
 * replays the fixes deterministically, at $0. Repairs land in the ORIGINAL
 * macro (placeholders in other steps survive); a repaired step that itself
 * carries a `{{param}}` is skipped, because the recorded fix has this
 * run's values baked in and would silently drop the placeholder.
 */
async function commitRepairs(macro: Macro, repairs: StepRepair[]): Promise<void> {
  const committable: StepRepair[] = [];
  for (const r of repairs) {
    if (stepHasPlaceholder(macro.steps[r.index]!)) {
      output.warn(`  not committing step ${r.index + 1}: it carries a {{param}}, and the repair was recorded with this run's values baked in. Re-parameterize after a manual edit, or re-record.`);
    } else {
      committable.push(r);
    }
  }
  if (committable.length === 0) return;
  const { applyRepairs } = await import('./heal.js');
  const repaired = applyRepairs(macro, committable);
  const path = await saveMacro({ ...repaired, repairedAt: Date.now() }, { force: true });
  output.success(`committed ${committable.length} repair${committable.length === 1 ? '' : 's'} → ${path} (next play replays them at $0).`);
}

/** Compute the screenshot→screen scale factor, only if the macro has clicks. */
async function coordinateScale(macro: Macro): Promise<number> {
  const needsCoords = macro.steps.some((s) => s.tool === 'computer' && Array.isArray(s.input['coordinate']));
  if (!needsCoords) return 1;
  try {
    const { width } = await getScreenSize();
    return Math.min(1, SCREENSHOT_MAX_WIDTH / width);
  } catch {
    return 1;
  }
}

async function runStep(step: MacroStep, scaleFactor: number): Promise<void> {
  if (step.tool === 'bash') {
    const command = step.input['command'];
    if (typeof command !== 'string') throw new Error('bash step missing command');
    const guard = checkCommand(command);
    if (guard.blocked) throw new Error(`guardrail blocked: ${guard.reason}`);
    execSync(command, { timeout: 30_000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    return;
  }
  if (step.tool === 'str_replace_based_edit_tool') {
    await runEditStep(step);
    return;
  }
  if (step.tool === 'computer') {
    await runComputerStep(step, scaleFactor);
    return;
  }
  if (step.tool === 'click_element') {
    await runClickElementStep(step);
    return;
  }
  throw new Error(`unsupported macro tool: ${step.tool}`);
}

/**
 * Replay a semantic click: re-resolve the control by name (and role) in the
 * live accessibility tree and click its center. The control is found
 * wherever it sits NOW — no stale coordinates. Runs wherever the --ui tools
 * that record these steps do (Windows + macOS), via enumerateUiElements().
 */
async function runClickElementStep(step: MacroStep): Promise<void> {
  const name = step.input['name'];
  if (typeof name !== 'string' || !name.trim()) throw new Error('click_element step missing name');
  const role = typeof step.input['role'] === 'string' ? step.input['role'] : undefined;
  const els = await enumerateUiElements();
  const matches = findElements(els, { name, ...(role ? { role } : {}) });
  if (matches.length === 0) throw new Error(`no control matching "${name}"${role ? ` [${role}]` : ''} in the active window`);
  const { x, y } = elementCenter(matches[0]!);
  await mouseClick(x, y, 'left');
}

async function runEditStep(step: MacroStep): Promise<void> {
  const command = String(step.input['command'] ?? '');
  const path = step.input['path'];
  if (typeof path !== 'string') throw new Error('edit step missing path');
  if (command === 'create') {
    await writeFile(path, (step.input['file_text'] as string) ?? '', 'utf-8');
    return;
  }
  if (command === 'str_replace') {
    const oldStr = step.input['old_str'];
    if (typeof oldStr !== 'string') throw new Error('str_replace step missing old_str');
    const newStr = (step.input['new_str'] as string) ?? '';
    const content = await readFile(path, 'utf-8');
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) throw new Error(`old_str not found in ${path}`);
    if (occurrences > 1) throw new Error(`old_str matched ${occurrences} times in ${path}`);
    await writeFile(path, content.replace(oldStr, () => newStr), 'utf-8');
    return;
  }
  if (command === 'insert') {
    const insertLine = (step.input['insert_line'] as number) ?? 0;
    const newStr = (step.input['new_str'] as string) ?? '';
    const content = await readFile(path, 'utf-8');
    const lines = content.split('\n');
    lines.splice(Math.max(0, insertLine), 0, newStr);
    await writeFile(path, lines.join('\n'), 'utf-8');
    return;
  }
  throw new Error(`unsupported edit command: ${command}`);
}

async function runComputerStep(step: MacroStep, scaleFactor: number): Promise<void> {
  const action = step.action;
  const scale = (c: [number, number]): [number, number] => [Math.round(c[0] / scaleFactor), Math.round(c[1] / scaleFactor)];
  const coord = (): [number, number] => {
    const raw = step.input['coordinate'];
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${action} step missing coordinate`);
    return scale([Number(raw[0]), Number(raw[1])]);
  };
  switch (action) {
    case 'left_click': case 'right_click': case 'middle_click': {
      const [x, y] = coord();
      await mouseClick(x, y, action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left');
      return;
    }
    case 'double_click': { const [x, y] = coord(); await mouseDoubleClick(x, y); return; }
    case 'triple_click': { const [x, y] = coord(); await mouseTripleClick(x, y); return; }
    case 'left_mouse_down': case 'left_mouse_up': {
      const [x, y] = coord();
      await mouseButtonEvent(x, y, action === 'left_mouse_down' ? 'down' : 'up');
      return;
    }
    case 'left_click_drag': {
      const startRaw = step.input['start_coordinate'];
      if (!Array.isArray(startRaw) || startRaw.length !== 2) throw new Error('drag step missing start_coordinate');
      const [sx, sy] = scale([Number(startRaw[0]), Number(startRaw[1])]);
      const [ex, ey] = coord();
      await mouseDrag(sx, sy, ex, ey);
      return;
    }
    case 'type': { await keyboardType(String(step.input['text'] ?? '')); return; }
    case 'key': { await keyboardKey(String(step.input['text'] ?? '')); return; }
    case 'hold_key': { await keyboardHoldKey(String(step.input['text'] ?? ''), (step.input['duration'] as number) ?? 1); return; }
    case 'scroll': {
      const [x, y] = coord();
      const dir = step.input['scroll_direction'];
      const direction = dir === 'up' || dir === 'left' || dir === 'right' ? dir : 'down';
      await mouseScroll(x, y, direction, (step.input['scroll_amount'] as number) ?? 3);
      return;
    }
    default:
      // mouse_move and other non-effectful actions shouldn't be recorded, but
      // fail safe rather than throw a record/replay-version mismatch.
      await mouseMove(...coord());
      return;
  }
}
