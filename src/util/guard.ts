// Guarded step-through mode — the run mode between --dry-run (nothing
// fires) and full-send (everything fires). With `hands run --guard`, every
// state-changing tool call pauses for an explicit decision before it
// executes: [a]llow once, [d]eny, [A]lways-allow this tool, [e]dit the
// command, or [q]uit the run.
//
// Like --dry-run, this is a SDK-mode feature: the gate lives at the
// dispatch site, where hands executes the tools itself. Claude Login mode
// runs the tools inside the claude child, so --guard forces SDK mode for
// the invocation (route through dario to keep it $0).
//
// Read-only calls (screenshot, zoom, mouse_move, wait, read_page,
// find_files, ui_tree, text-editor `view`) never prompt — only actions
// that can change host state do. The decision logic is split into pure functions
// (classification, preview, answer parsing) and a GuardController whose
// terminal I/O is injected, so the prompt loop is testable without a TTY.

import { createInterface } from 'node:readline';

export type ToolClass = 'read-only' | 'state-changing';

/**
 * Classify a live SDK-mode tool call. Mirrors audit-replay's
 * classifyEntry, but reads the tool input directly rather than a logged
 * entry. Conservative — unknown tools/actions are state-changing. Pure.
 */
export function classifyToolUse(tool: string, input: Record<string, unknown>): ToolClass {
  if (tool === 'computer') {
    const action = input['action'];
    // Passive: capture pixels, reposition the cursor, or idle. None of
    // these click, type, drag, or focus — nothing on the host changes.
    if (action === 'screenshot' || action === 'zoom' || action === 'mouse_move' ||
        action === 'wait' || action === 'cursor_position') {
      return 'read-only';
    }
    return 'state-changing';
  }
  if (tool === 'str_replace_based_edit_tool') {
    return input['command'] === 'view' ? 'read-only' : 'state-changing';
  }
  // read_page (network GET) and find_files (disk walk) don't mutate the host.
  if (tool === 'read_page' || tool === 'find_files') return 'read-only';
  // --ui: ui_tree only reads the accessibility tree; click_element clicks.
  if (tool === 'ui_tree') return 'read-only';
  if (tool === 'click_element') return 'state-changing';
  // bash and anything unrecognized: assume it changes state.
  return 'state-changing';
}

function oneLine(v: unknown, max = 120): string {
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * A short, human one-line preview of what a tool call will do — the line
 * shown above the [a]llow/[d]eny prompt. Not redacted: the operator is
 * approving their own action and needs to see the real command. Pure.
 */
export function previewToolUse(tool: string, input: Record<string, unknown>): string {
  if (tool === 'bash') return `bash: ${oneLine(input['command'])}`;
  if (tool === 'computer') {
    const action = String(input['action'] ?? 'action');
    if (action === 'type') return `computer type: ${oneLine(input['text'], 80)}`;
    if (action === 'key' || action === 'hold_key') return `computer ${action}: ${oneLine(input['text'], 40)}`;
    const coord = input['coordinate'];
    if (Array.isArray(coord) && coord.length === 2) return `computer ${action} @ (${coord[0]}, ${coord[1]})`;
    return `computer ${action}`;
  }
  if (tool === 'str_replace_based_edit_tool') {
    const cmd = String(input['command'] ?? 'edit');
    const path = input['path'] ? ` ${oneLine(input['path'], 80)}` : '';
    return `edit ${cmd}:${path}`;
  }
  if (tool === 'click_element') {
    const role = typeof input['role'] === 'string' ? ` [${input['role']}]` : '';
    return `click element: "${oneLine(input['name'], 60)}"${role}`;
  }
  return tool;
}

export type GuardChoice = 'allow' | 'deny' | 'always' | 'edit' | 'abort' | 'unknown';

/**
 * Parse a typed answer to the guard prompt. Case-sensitive on the one
 * pair that matters: `A` = always-allow, `a` = allow once. A bare Enter
 * is `unknown` (re-prompt) rather than a silent default — a guarded
 * session shouldn't fire on accidental keypresses. Pure.
 */
export function parseGuardAnswer(raw: string): GuardChoice {
  const s = raw.trim();
  if (s === '') return 'unknown';
  if (s === 'A') return 'always';
  const l = s.toLowerCase();
  if (l === 'a' || l === 'y' || l === 'yes' || l === 'allow') return 'allow';
  if (l === 'd' || l === 'n' || l === 'no' || l === 'deny') return 'deny';
  if (l === 'always') return 'always';
  if (l === 'e' || l === 'edit') return 'edit';
  if (l === 'q' || l === 'quit' || l === 'abort') return 'abort';
  return 'unknown';
}

export interface GuardCall {
  tool: string;
  action?: string | undefined;
  input: Record<string, unknown>;
  preview: string;
}

export type GuardDecision =
  | { kind: 'allow'; input?: Record<string, unknown> | undefined }
  | { kind: 'deny' }
  | { kind: 'abort' };

/** Thrown when the operator picks [q]uit — caught by the SDK loop to end the run cleanly. */
export class GuardAbort extends Error {
  constructor() {
    super('Run aborted by operator at the guard prompt.');
    this.name = 'GuardAbort';
  }
}

interface GuardIo {
  /** Print a prompt and resolve with the operator's typed line. */
  ask(prompt: string): Promise<string>;
  /** Print a message (hints, edit confirmations) without reading. */
  out(message: string): void;
}

/**
 * The decision engine behind `--guard`. Holds the per-run "always allow"
 * set and tallies. Terminal I/O is injected so the prompt loop is unit-
 * testable with a scripted answer queue.
 */
export class GuardController {
  private readonly io: GuardIo;
  private readonly always = new Set<string>();
  allowed = 0;
  denied = 0;

  constructor(io: GuardIo) {
    this.io = io;
  }

  /** "always allow" key: bash collapses to one entry; computer is per-action. */
  private key(call: GuardCall): string {
    return call.tool === 'bash' ? 'bash' : `${call.tool}:${call.action ?? ''}`;
  }

  async decide(call: GuardCall): Promise<GuardDecision> {
    if (this.always.has(this.key(call))) {
      this.allowed++;
      return { kind: 'allow' };
    }
    for (;;) {
      const raw = await this.io.ask(`\n  ▶ ${call.preview}\n    [a]llow  [d]eny  [A]lways  [e]dit  [q]uit ? `);
      const choice = parseGuardAnswer(raw);
      if (choice === 'allow') { this.allowed++; return { kind: 'allow' }; }
      if (choice === 'always') { this.always.add(this.key(call)); this.allowed++; return { kind: 'allow' }; }
      if (choice === 'deny') { this.denied++; return { kind: 'deny' }; }
      if (choice === 'abort') { return { kind: 'abort' }; }
      if (choice === 'edit') {
        const edited = await this.edit(call);
        if (edited) { this.allowed++; return { kind: 'allow', input: edited }; }
        this.io.out('    (edit is only supported for bash commands, computer type/key text, and click_element targets)\n');
        continue;
      }
      this.io.out('    ? a=allow once · d=deny · A=always allow this tool · e=edit · q=quit\n');
    }
  }

  /**
   * Prompt for an edited value. Supports the bash command, the computer
   * type/key text, and the click_element target name — the fields where
   * an inline tweak is meaningful. Returns the new input, or null when
   * this call isn't editable. An empty edit keeps the original.
   */
  private async edit(call: GuardCall): Promise<Record<string, unknown> | null> {
    if (call.tool === 'bash') {
      const current = typeof call.input['command'] === 'string' ? call.input['command'] : '';
      const next = (await this.io.ask(`    edit command (Enter keeps "${oneLine(current, 60)}"): `)).trim();
      return next ? { ...call.input, command: next } : call.input;
    }
    if (call.tool === 'computer' && (call.action === 'type' || call.action === 'key' || call.action === 'hold_key')) {
      const current = typeof call.input['text'] === 'string' ? call.input['text'] : '';
      const next = await this.io.ask(`    edit text (Enter keeps "${oneLine(current, 60)}"): `);
      return next.trim() ? { ...call.input, text: next } : call.input;
    }
    if (call.tool === 'click_element') {
      const current = typeof call.input['name'] === 'string' ? call.input['name'] : '';
      const next = (await this.io.ask(`    edit target name (Enter keeps "${oneLine(current, 60)}"): `)).trim();
      return next ? { ...call.input, name: next } : call.input;
    }
    return null;
  }

  /** One-line tally for the end-of-run summary. */
  summary(): string {
    return `guard: ${this.allowed} allowed, ${this.denied} denied`;
  }
}

/**
 * Wire a GuardController to the real terminal via node:readline. Returns
 * the controller plus a `close()` that must be called when the run ends
 * (an open readline interface keeps the event loop alive).
 */
export function createTerminalGuard(): { guard: GuardController; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const guard = new GuardController({
    ask: (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
    out: (message: string) => { process.stdout.write(message); },
  });
  return { guard, close: () => rl.close() };
}
