import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { takeScreenshot } from './platform/screenshot.js';
import { mouseClick, mouseMove, mouseDoubleClick, mouseScroll } from './platform/mouse.js';
import { keyboardType, keyboardKey } from './platform/keyboard.js';
import { checkCommand } from './util/guardrails.js';
import * as output from './util/output.js';

/**
 * Audit log read + replay surface.
 *
 * The audit log at `~/.hands/audit.jsonl` records every tool call
 * the agent makes in SDK mode. This module reads from it for two
 * operator-facing commands:
 *
 *   hands audit list [--last N]       show recent entries with index
 *   hands audit show <index>          full detail of one entry
 *   hands audit replay <index>        re-execute the entry's tool call
 *                                       (dry-run by default; --execute to fire)
 *
 * Replay safety: the default is "dry-run" — print what would happen,
 * don't actually fire the tool. Operator must pass --execute to
 * actually re-run. Each --execute invocation prompts before firing
 * for actions classed as "destructive": clicks, typing, key presses,
 * scrolls, and any bash command. Read-only computer actions
 * (screenshot, mouse_move) skip the prompt.
 *
 * Replay does NOT re-run the LLM. It just re-fires the tool call as
 * recorded. Useful for re-running a known-good action sequence on a
 * fresh state, or for inspecting what the agent did during a run.
 */

function auditPath(): string {
  // Re-evaluated per call so test setup that overrides process.env.HOME /
  // USERPROFILE (and Node's homedir()-via-os-userInfo() picks them up)
  // can redirect the read target into a tmp dir without restarting the
  // process. Module-load-time computation would freeze the path against
  // the homedir() value at import time, which is fine in production but
  // breaks unit tests that need an isolated audit log.
  return join(homedir(), '.hands', 'audit.jsonl');
}

export interface AuditEntry {
  ts?: number;
  tool: string;
  action?: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  ok: boolean;
  error?: string;
  dryRun?: boolean;
  /** Which run mode recorded the entry. Absent = SDK (pre-0.6 entries included). */
  mode?: 'sdk' | 'cli';
}

export interface AuditFilter {
  /** 'cli' = Claude Login entries; 'sdk' = dispatch-site entries (absent mode counts as sdk). */
  mode?: 'sdk' | 'cli' | undefined;
  /** Exact tool name (e.g. `bash`, `computer`, `read_page`). */
  tool?: string | undefined;
  /** Only entries that did not complete ok. */
  failedOnly?: boolean | undefined;
}

export interface IndexedEntry {
  /** Position in the FULL log — the index `hands audit show/replay` accepts. Filtering must not renumber. */
  index: number;
  entry: AuditEntry;
}

/**
 * Filter entries while preserving their replay indexes. Pure —
 * exported for tests.
 */
export function filterAuditEntries(entries: AuditEntry[], filter: AuditFilter): IndexedEntry[] {
  const out: IndexedEntry[] = [];
  entries.forEach((entry, index) => {
    if (filter.mode === 'cli' && entry.mode !== 'cli') return;
    if (filter.mode === 'sdk' && entry.mode === 'cli') return;
    if (filter.tool && entry.tool !== filter.tool) return;
    if (filter.failedOnly && entry.ok) return;
    out.push({ index, entry });
  });
  return out;
}

/** Read the audit log into memory. Returns oldest-first ordering. */
export async function readAuditEntries(): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(auditPath(), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // Skip malformed lines — diagnostic file, not authoritative.
    }
  }
  return out;
}

/**
 * Render one entry as a single human-readable line. Used by `list`
 * and by replay's dry-run preview.
 */
export function summarizeEntry(entry: AuditEntry): string {
  const ts = entry.ts ? new Date(entry.ts).toISOString().replace('T', ' ').slice(0, 19) : '????-??-?? ??:??:??';
  const ok = entry.ok ? '✓' : '✗';
  const tool = entry.tool;
  const action = entry.action ? `:${entry.action}` : '';
  const args = entry.args ? oneLineArgs(entry.args) : '';
  const dry = entry.dryRun ? ' [dry-run]' : '';
  // CLI-mode marker only — SDK entries keep their historical rendering.
  const mode = entry.mode === 'cli' ? ' [cli]' : '';
  const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';
  return `${ts}  ${ok}  ${tool}${action}  ${args}${dry}${mode}${duration}`;
}

function oneLineArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'action') continue; // already in the tool:action prefix
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 60 ? JSON.stringify(v.slice(0, 60)) + '…' : JSON.stringify(v)}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return parts.join(' ');
}

/**
 * Classify whether an entry's tool call is read-only (safe to replay
 * silently) or potentially state-changing (require confirmation
 * before --execute fires). Conservative — when in doubt, returns
 * `state-changing`.
 */
export function classifyEntry(entry: AuditEntry): 'read-only' | 'state-changing' {
  if (entry.tool === 'computer') {
    // Screenshot doesn't change anything. mouse_move doesn't click,
    // doesn't focus, doesn't drag — purely passive cursor reposition.
    if (entry.action === 'screenshot') return 'read-only';
    if (entry.action === 'mouse_move') return 'read-only';
    return 'state-changing';
  }
  if (entry.tool === 'str_replace_based_edit_tool') {
    // The `view` action just reads a file. create / str_replace /
    // insert all modify state.
    const cmd = entry.args?.['command'];
    if (cmd === 'view') return 'read-only';
    return 'state-changing';
  }
  // Bash: every command is potentially destructive without
  // semantic understanding of what it does. State-changing.
  if (entry.tool === 'bash') return 'state-changing';
  // Unknown tool — be conservative.
  return 'state-changing';
}

/**
 * Re-execute one audit entry. When `dryRun` is true, prints what
 * would happen and returns immediately. When false, actually fires
 * the tool. Throws on unknown tool/action shapes — replay only
 * handles what was recorded.
 */
export async function replayEntry(entry: AuditEntry, opts: { dryRun: boolean }): Promise<void> {
  const summary = summarizeEntry(entry);
  if (opts.dryRun) {
    output.info(`[dry-run] would replay: ${summary}`);
    return;
  }
  output.action(entry.tool, `replay: ${entry.action ?? entry.tool}`);

  if (entry.tool === 'bash') {
    const command = entry.args?.['command'];
    if (typeof command !== 'string') throw new Error('bash entry missing args.command');
    await runBash(command);
    return;
  }
  if (entry.tool === 'computer') {
    await replayComputer(entry);
    return;
  }
  if (entry.tool === 'str_replace_based_edit_tool') {
    await replayTextEditor(entry);
    return;
  }
  throw new Error(`unsupported tool for replay: ${entry.tool}`);
}

async function runBash(command: string): Promise<void> {
  // Same gate the live SDK-mode bash tool runs behind — a replayed
  // command is no less dangerous than a fresh one, and the audit file
  // is plain JSONL an attacker-influenced process could append to.
  const guard = checkCommand(command);
  if (guard.blocked) {
    throw new Error(`guardrail blocked replay: ${guard.reason}`);
  }
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : 'bash';
    const flag = isWindows ? '/c' : '-c';
    const child = spawn(shell, [flag, command], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bash exited with code ${code}`));
    });
  });
}

async function replayComputer(entry: AuditEntry): Promise<void> {
  const action = entry.action;
  const args = entry.args ?? {};
  switch (action) {
    case 'screenshot':
      await takeScreenshot();
      return;
    case 'mouse_move': {
      const coord = args['coordinate'] as [number, number] | undefined;
      if (!coord) throw new Error('mouse_move missing coordinate');
      await mouseMove(coord[0]!, coord[1]!);
      return;
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click': {
      const coord = args['coordinate'] as [number, number] | undefined;
      if (!coord) throw new Error(`${action} missing coordinate`);
      const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
      await mouseClick(coord[0]!, coord[1]!, button);
      return;
    }
    case 'double_click': {
      const coord = args['coordinate'] as [number, number] | undefined;
      if (!coord) throw new Error('double_click missing coordinate');
      await mouseDoubleClick(coord[0]!, coord[1]!);
      return;
    }
    case 'type': {
      const text = args['text'];
      if (typeof text !== 'string') throw new Error('type missing text');
      await keyboardType(text);
      return;
    }
    case 'key': {
      const text = args['text'];
      if (typeof text !== 'string') throw new Error('key missing text');
      await keyboardKey(text);
      return;
    }
    case 'scroll': {
      const coord = args['coordinate'] as [number, number] | undefined;
      const direction = args['scroll_direction'] as string | undefined;
      const amount = args['scroll_amount'] as number | undefined;
      if (!coord || !direction || amount === undefined) throw new Error('scroll missing fields');
      // Anthropic's scroll action allows up/down/left/right; the hands
      // platform layer only implements vertical scroll. Coerce
      // horizontal directions to a no-op (treat as down) and warn.
      if (direction !== 'up' && direction !== 'down') {
        output.warn(`scroll direction '${direction}' is not supported by the platform layer; replaying as 'down'`);
      }
      const verticalDir: 'up' | 'down' = direction === 'up' ? 'up' : 'down';
      await mouseScroll(coord[0]!, coord[1]!, verticalDir, amount);
      return;
    }
    default:
      throw new Error(`unsupported computer action for replay: ${action}`);
  }
}

async function replayTextEditor(entry: AuditEntry): Promise<void> {
  const cmd = entry.args?.['command'];
  if (cmd === 'view') {
    // Read-only view — replay reads and prints.
    const path = entry.args?.['path'];
    if (typeof path !== 'string') throw new Error('view missing path');
    const content = await fs.readFile(path, 'utf-8');
    output.info(content.length > 1000 ? content.slice(0, 1000) + '\n…[truncated]' : content);
    return;
  }
  // create / str_replace / insert operations: would need original
  // input fields (file_text, old_str, new_str, etc.) which the audit
  // summarizer may have truncated. Refuse rather than guess.
  throw new Error(`text_editor replay only supports the 'view' command — got '${cmd}'`);
}
