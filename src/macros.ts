// Macros — crystallize an AI run into a free, deterministic replay.
//
// The differentiator: a computer-use task normally costs LLM calls EVERY
// time. With `hands run --record <name> "<task>"`, hands runs the task once
// (with the model) and captures the effectful tool-call sequence into a
// macro. `hands play <name>` then re-executes that sequence with ZERO model
// calls — free, instant, deterministic. Shell-first tasks (hands' bias)
// crystallize into clean scripts you can even `--export` as .sh / .ps1:
// the AI did it once, then wrote you the automation.
//
// A macro records only the EFFECTFUL steps (bash, file edits, clicks,
// keystrokes) — not screenshots, reads, or cursor moves. Coordinate clicks
// replay best-effort (state-dependent); bash and file edits are the
// deterministic backbone.
//
// This module is the pure model + the fs CRUD. Pure functions (validation,
// recordable filter, param substitution, the export compiler) are unit-
// tested without a filesystem; the executor lives in macro-run.ts.

import { readFile, writeFile, mkdir, readdir, unlink, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { substituteParams, PLACEHOLDER_RE } from './recipes.js';

export interface MacroStep {
  /** Tool name: `bash`, `powershell`, `str_replace_based_edit_tool`, or `computer`. */
  tool: string;
  /** Sub-action for the computer tool (left_click, type, key, …). */
  action?: string | undefined;
  /** Full tool input — un-truncated, for faithful replay. */
  input: Record<string, unknown>;
}

export interface Macro {
  name: string;
  /** The original natural-language task, for provenance. */
  prompt?: string | undefined;
  /** process.platform the macro was recorded on (drives --export language). */
  platform?: string | undefined;
  /** Unix ms when recorded. */
  createdAt?: number | undefined;
  /** Unix ms when `hands play --heal --commit` last rewrote steps. */
  repairedAt?: number | undefined;
  steps: MacroStep[];
}

// ── pure: validation ────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_NAME_LEN = 64;

/** A macro name is one safe path segment (it becomes a filename). Pure. */
export function isValidMacroName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LEN && NAME_RE.test(name);
}

// ── pure: which tool calls get recorded ─────────────────────────────

/** Computer actions that change state (and so are worth replaying). */
const EFFECTFUL_COMPUTER = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key', 'scroll',
]);

/**
 * Should a successful tool call be captured into a macro? Records the
 * effectful surface — bash, file mutations, clicks/keystrokes — and skips
 * pure reads (screenshot, zoom, mouse_move, wait, read_page, find_files,
 * editor `view`), which have no replay value. Pure.
 */
export function isRecordable(tool: string, action: string | undefined, input: Record<string, unknown>): boolean {
  if (tool === 'bash' || tool === 'powershell') return typeof input['command'] === 'string' && input['command'].length > 0;
  if (tool === 'str_replace_based_edit_tool') return input['command'] !== 'view';
  if (tool === 'computer') return action !== undefined && EFFECTFUL_COMPUTER.has(action);
  // Semantic clicks (--ui) replay by NAME, not coordinates — the most
  // layout-shift-resistant step a macro can hold.
  if (tool === 'click_element') return typeof input['name'] === 'string' && input['name'].length > 0;
  return false; // read_page / find_files / ui_tree / unknown — not effectful
}

/**
 * Accumulates the effectful tool calls of a run, in order, for
 * crystallization. Injected into the SDK loop; `record` is called after
 * each successful tool execution and filters via isRecordable.
 */
export class MacroRecorder {
  readonly steps: MacroStep[] = [];
  record(tool: string, action: string | undefined, input: Record<string, unknown>): void {
    if (!isRecordable(tool, action, input)) return;
    this.steps.push({ tool, ...(action ? { action } : {}), input: { ...input } });
  }
}

// ── pure: parameters ────────────────────────────────────────────────

/** Fields whose string value carries a `{{param}}` worth substituting. */
const PARAM_FIELDS = ['command', 'text', 'file_text', 'path', 'new_str', 'old_str', 'name'];

/**
 * Substitute `{{key}}` / `{{key=default}}` across a macro's parameterizable
 * string fields (you parameterize a macro by hand-editing those values).
 * Returns the filled macro and any still-missing keys. Pure.
 */
export function applyMacroParams(macro: Macro, params: Record<string, string>): { macro: Macro; missing: string[] } {
  const missing = new Set<string>();
  const steps = macro.steps.map((s): MacroStep => {
    const input: Record<string, unknown> = { ...s.input };
    for (const f of PARAM_FIELDS) {
      if (typeof input[f] === 'string') {
        const r = substituteParams(input[f] as string, params);
        r.missing.forEach((m) => missing.add(m));
        input[f] = r.text;
      }
    }
    return { tool: s.tool, ...(s.action ? { action: s.action } : {}), input };
  });
  return { macro: { ...macro, steps }, missing: [...missing] };
}

/**
 * Does any parameterizable field of this step carry a `{{param}}`?
 * `--heal --commit` refuses to rewrite such a step — the repair was
 * recorded with this run's values baked in, and committing it would
 * silently drop the placeholder. Pure.
 */
export function stepHasPlaceholder(step: MacroStep): boolean {
  return PARAM_FIELDS.some((f) => {
    const v = step.input[f];
    return typeof v === 'string' && new RegExp(PLACEHOLDER_RE.source).test(v);
  });
}

/**
 * The `{{params}}` a macro exposes, in first-appearance order. A key is
 * required (no default) if ANY of its occurrences lacks one — that's the
 * occurrence `hands play` will refuse to run without a `--set`. Pure.
 */
export function macroParams(macro: Macro): Array<{ key: string; def: string | undefined }> {
  const seen = new Map<string, string | undefined>();
  for (const step of macro.steps) {
    for (const f of PARAM_FIELDS) {
      const text = step.input[f];
      if (typeof text !== 'string') continue;
      const re = new RegExp(PLACEHOLDER_RE.source, 'g');
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const key = m[1]!;
        const def = m[2];
        if (!seen.has(key) || (seen.get(key) !== undefined && def === undefined)) seen.set(key, def);
      }
    }
  }
  return [...seen.entries()].map(([key, def]) => ({ key, def }));
}

/**
 * Replace literal `value` with `replacement` in the placeholder-free
 * stretches of `text` — an existing `{{…}}` is never rewritten, so
 * parameterizing "stag" can't corrupt a `{{env=staging}}`. Pure.
 */
function replaceOutsidePlaceholders(text: string, value: string, replacement: string): { text: string; count: number } {
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let out = '';
  let count = 0;
  let last = 0;
  const sub = (segment: string): string => {
    const parts = segment.split(value);
    count += parts.length - 1;
    return parts.join(replacement);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += sub(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += sub(text.slice(last));
  return { text: out, count };
}

/**
 * Turn literal values into `{{key=value}}` placeholders — the one-command
 * upgrade from "recorded once" to "reusable with --set". Each assignment
 * replaces every occurrence of its value across the parameterizable
 * string fields (never inside an existing placeholder). The original
 * value becomes the DEFAULT, so a bare `hands play` replays the macro
 * exactly as recorded; `--set key=other` re-aims it. Assignments apply
 * in order. Returns the rewritten macro and a per-key occurrence count
 * (0 = the value wasn't found — likely a typo; nothing was changed for
 * that key). Pure — the caller decides whether to save.
 */
export function parameterizeMacro(macro: Macro, assignments: Record<string, string>): { macro: Macro; replaced: Record<string, number> } {
  const replaced: Record<string, number> = {};
  for (const [key, value] of Object.entries(assignments)) {
    if (!/^[a-zA-Z0-9_]+$/.test(key)) throw new Error(`Invalid param key "${key}". Use letters, digits, and underscores.`);
    if (value === '') throw new Error(`Param "${key}" needs a non-empty value to search for (key=value).`);
    // A default lives inside {{key=…}} and the parser reads it as [^}]* —
    // a value containing "}" could never round-trip.
    if (value.includes('}')) throw new Error(`Param "${key}" value contains "}", which can't be stored as a {{${key}=…}} default.`);
  }
  const steps = macro.steps.map((s): MacroStep => ({ tool: s.tool, ...(s.action ? { action: s.action } : {}), input: { ...s.input } }));
  for (const [key, value] of Object.entries(assignments)) {
    let count = 0;
    for (const step of steps) {
      for (const f of PARAM_FIELDS) {
        if (typeof step.input[f] !== 'string') continue;
        const r = replaceOutsidePlaceholders(step.input[f] as string, value, `{{${key}=${value}}}`);
        step.input[f] = r.text;
        count += r.count;
      }
    }
    replaced[key] = count;
  }
  return { macro: { ...macro, steps }, replaced };
}

// ── pure: export to a shell script ──────────────────────────────────

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compile a macro into a runnable shell script. Bash steps become commands;
 * file-create edits become a write; everything else is emitted as a
 * commented `# [manual]` placeholder (GUI clicks aren't portably
 * scriptable). The language follows the recording platform — PowerShell on
 * win32 (hands' bash tool runs PowerShell there), POSIX sh elsewhere. Pure.
 */
export function macroToScript(
  macro: Macro,
  platform: string = macro.platform ?? process.platform,
): { language: 'powershell' | 'sh'; script: string; scriptable: number; manual: number } {
  const ps = platform === 'win32';
  const lines: string[] = [];
  let scriptable = 0;
  let manual = 0;

  if (ps) {
    lines.push(`# Generated by hands from macro "${macro.name}"${macro.prompt ? ` — ${macro.prompt}` : ''}`);
    lines.push(`$ErrorActionPreference = 'Stop'`, '');
  } else {
    lines.push('#!/usr/bin/env bash', `# Generated by hands from macro "${macro.name}"${macro.prompt ? ` — ${macro.prompt}` : ''}`);
    lines.push('set -euo pipefail', '');
  }

  for (const step of macro.steps) {
    if (step.tool === 'bash' && typeof step.input['command'] === 'string') {
      lines.push(step.input['command'] as string);
      scriptable++;
    } else if (step.tool === 'powershell' && typeof step.input['command'] === 'string') {
      // Native in a .ps1; from sh, shell out to powershell.exe.
      if (ps) {
        lines.push(step.input['command'] as string);
      } else {
        lines.push(`powershell -NoProfile -EncodedCommand ${encodePowerShellCommand(step.input['command'] as string)}`);
      }
      scriptable++;
    } else if (step.tool === 'str_replace_based_edit_tool' && step.input['command'] === 'create' &&
               typeof step.input['path'] === 'string') {
      const path = step.input['path'] as string;
      const content = typeof step.input['file_text'] === 'string' ? (step.input['file_text'] as string) : '';
      if (ps) {
        lines.push(`Set-Content -LiteralPath ${shQuote(path)} -Value @'\n${content}\n'@`);
      } else {
        lines.push(`cat > ${shQuote(path)} <<'HANDS_EOF'\n${content}\nHANDS_EOF`);
      }
      scriptable++;
    } else {
      const desc = step.tool === 'click_element'
        ? `click_element "${String(step.input['name'] ?? '')}"`
        : step.action ? `${step.tool}:${step.action}` : step.tool;
      lines.push(`# [manual] ${desc} — not portably scriptable; replay with: hands play ${macro.name}`);
      manual++;
    }
  }

  return { language: ps ? 'powershell' : 'sh', script: lines.join('\n') + '\n', scriptable, manual };
}

/**
 * Encode a PowerShell command for `powershell -EncodedCommand` (base64 of
 * UTF-16LE). The encoded form survives cmd's line-splitting, so multiline
 * PowerShell replays reliably where multiline bash (execSync → cmd) does
 * not. Pure.
 */
export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

/** Render a macro step as a one-line preview for `macro show` / play progress. Pure. */
export function previewStep(step: MacroStep): string {
  if (step.tool === 'bash' || step.tool === 'powershell') {
    const c = typeof step.input['command'] === 'string' ? (step.input['command'] as string) : '';
    return `${step.tool}: ${c.length > 80 ? c.slice(0, 80) + '…' : c}`;
  }
  if (step.tool === 'str_replace_based_edit_tool') {
    return `edit ${String(step.input['command'] ?? '')}: ${String(step.input['path'] ?? '')}`;
  }
  if (step.tool === 'computer') {
    if (step.action === 'type' || step.action === 'key') return `computer ${step.action}: ${String(step.input['text'] ?? '')}`;
    const c = step.input['coordinate'];
    return Array.isArray(c) ? `computer ${step.action} @ (${c[0]}, ${c[1]})` : `computer ${step.action ?? ''}`;
  }
  if (step.tool === 'click_element') {
    const role = typeof step.input['role'] === 'string' ? ` [${step.input['role']}]` : '';
    return `click element: "${String(step.input['name'] ?? '')}"${role}`;
  }
  return step.tool;
}

// ── fs: paths + CRUD ────────────────────────────────────────────────

const MACROS_DIR = join(homedir(), '.hands', 'macros');

export function getMacrosDir(): string {
  return MACROS_DIR;
}

export function macroPath(name: string): string {
  return join(MACROS_DIR, `${name}.json`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write a macro to disk (0600 in the 0700 macros dir — it can carry literal typed text). */
export async function saveMacro(macro: Macro, opts: { force?: boolean } = {}): Promise<string> {
  if (!isValidMacroName(macro.name)) {
    throw new Error(`Invalid macro name "${macro.name}". Use letters, digits, dashes, and underscores.`);
  }
  const path = macroPath(macro.name);
  if (!opts.force && (await fileExists(path))) {
    throw new Error(`Macro "${macro.name}" already exists. Pass --force to overwrite, or pick another name.`);
  }
  await mkdir(MACROS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(macro, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      await chmod(MACROS_DIR, 0o700);
      await chmod(path, 0o600);
    } catch {
      // best-effort perms repair
    }
  }
  return path;
}

/** Read + parse a macro. Throws with available names when missing. */
export async function loadMacro(name: string): Promise<Macro> {
  if (!isValidMacroName(name)) {
    throw new Error(`Invalid macro name "${name}". Use letters, digits, dashes, and underscores.`);
  }
  let raw: string;
  try {
    raw = await readFile(macroPath(name), 'utf-8');
  } catch {
    const available = await listMacroNames();
    const hint = available.length ? ` Available: ${available.join(', ')}.` : ' No macros recorded yet.';
    throw new Error(`Macro "${name}" not found (looked at ${macroPath(name)}).${hint}`);
  }
  const parsed = JSON.parse(raw) as Macro;
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error(`Macro "${name}" is malformed (no steps array).`);
  }
  return { ...parsed, name };
}

export async function deleteMacro(name: string): Promise<void> {
  if (!isValidMacroName(name)) throw new Error(`Invalid macro name "${name}".`);
  try {
    await unlink(macroPath(name));
  } catch {
    throw new Error(`Macro "${name}" not found (looked at ${macroPath(name)}).`);
  }
}

export async function listMacroNames(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(MACROS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter(isValidMacroName)
    .sort((a, b) => a.localeCompare(b));
}

export async function listMacros(): Promise<Macro[]> {
  const out: Macro[] = [];
  for (const name of await listMacroNames()) {
    try {
      out.push(await loadMacro(name));
    } catch {
      // skip malformed
    }
  }
  return out;
}
