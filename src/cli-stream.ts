// Parser for `claude -p --output-format stream-json` JSONL output.
//
// Claude Login mode used to scrape the child's stderr with string
// heuristics ("does this line mention tool_use?") to guess what the
// agent was doing, and could not audit-log anything. stream-json gives
// us the real event stream on stdout: every assistant tool_use block,
// every tool_result, the final result envelope, and the session id.
// This module is the pure part — chunk buffering, event extraction,
// display/audit summarization — so cli-mode stays a thin renderer and
// all of the parsing is unit-testable without spawning claude.

import { redactSecrets } from './util/redact.js';
import type { AuditEntry } from './util/audit.js';

export interface InitEvent {
  kind: 'init';
  sessionId: string;
}

export interface ToolUseEvent {
  kind: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  kind: 'tool_result';
  toolUseId: string;
  isError: boolean;
}

export interface AssistantTextEvent {
  kind: 'text';
  text: string;
}

export interface ResultEvent {
  kind: 'result';
  ok: boolean;
  text: string;
  sessionId: string | undefined;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export type StreamEvent = InitEvent | ToolUseEvent | ToolResultEvent | AssistantTextEvent | ResultEvent;

/**
 * Parse one JSONL line into zero or more stream events. Unknown event
 * types and malformed lines yield [] — the stream may carry event
 * shapes we don't model (api_retry, hook events, partial-message
 * deltas on future flag combinations) and none of them should break a
 * run.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof obj !== 'object' || obj === null) return [];
  const ev = obj as Record<string, unknown>;

  switch (ev['type']) {
    case 'system': {
      if (ev['subtype'] === 'init' && typeof ev['session_id'] === 'string') {
        return [{ kind: 'init', sessionId: ev['session_id'] }];
      }
      return [];
    }
    case 'assistant':
      return extractContentEvents(ev, 'assistant');
    case 'user':
      return extractContentEvents(ev, 'user');
    case 'result':
      return [extractResult(ev)];
    default:
      return [];
  }
}

/** tool_use + text blocks from assistant messages; tool_result blocks from user messages. */
function extractContentEvents(ev: Record<string, unknown>, role: 'assistant' | 'user'): StreamEvent[] {
  const message = ev['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return [];

  const out: StreamEvent[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (role === 'assistant' && b['type'] === 'tool_use' && typeof b['name'] === 'string') {
      out.push({
        kind: 'tool_use',
        id: typeof b['id'] === 'string' ? b['id'] : '',
        name: b['name'],
        input: typeof b['input'] === 'object' && b['input'] !== null ? (b['input'] as Record<string, unknown>) : {},
      });
    } else if (role === 'assistant' && b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) {
      out.push({ kind: 'text', text: b['text'] });
    } else if (role === 'user' && b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
      out.push({ kind: 'tool_result', toolUseId: b['tool_use_id'], isError: b['is_error'] === true });
    }
  }
  return out;
}

function extractResult(ev: Record<string, unknown>): ResultEvent {
  const usage = typeof ev['usage'] === 'object' && ev['usage'] !== null ? (ev['usage'] as Record<string, unknown>) : {};
  return {
    kind: 'result',
    ok: ev['subtype'] === 'success',
    text: typeof ev['result'] === 'string' ? ev['result'] : '',
    sessionId: typeof ev['session_id'] === 'string' ? ev['session_id'] : undefined,
    costUsd: typeof ev['total_cost_usd'] === 'number' ? ev['total_cost_usd'] : 0,
    turns: typeof ev['num_turns'] === 'number' ? ev['num_turns'] : 0,
    inputTokens: typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0,
    outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0,
  };
}

/**
 * Line-buffering wrapper: stdout arrives in arbitrary chunk boundaries,
 * so a JSON line can be split across `data` events. push() returns the
 * events from every line completed by this chunk; flush() drains
 * whatever is left in the buffer at stream end.
 */
export class StreamJsonParser {
  private buffer = '';

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const out: StreamEvent[] = [];
    for (const line of lines) out.push(...parseStreamLine(line));
    return out;
  }

  flush(): StreamEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? parseStreamLine(rest) : [];
  }
}

// ── display + audit summarization ───────────────────────────────────

export interface ToolUseDescription {
  /** Tool identity for the audit log (e.g. `bash`, `askalf-computer`). */
  tool: string;
  /** Sub-action when one exists (e.g. `screenshot` for the MCP tool). */
  action?: string | undefined;
  /** Human one-liner for the live action line. Already redacted. */
  summary: string;
}

/**
 * Map a tool_use block to its display/audit identity. MCP tools arrive
 * namespaced (`mcp__askalf-computer__screenshot`); built-ins arrive as
 * bare names (`Bash`, `Write`, ...). Pure — exported for tests.
 */
export function describeToolUse(name: string, input: Record<string, unknown>): ToolUseDescription {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) {
    return { tool: mcp[1]!, action: mcp[2]!, summary: `${mcp[1]}: ${mcp[2]}` };
  }

  const str = (key: string): string | undefined => {
    const v = input[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const clip = (s: string): string => {
    const clean = redactSecrets(s.replace(/\s+/g, ' ').trim());
    return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
  };

  switch (name) {
    case 'Bash':
      return { tool: 'bash', summary: `bash: ${clip(str('command') ?? '')}` };
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return { tool: name.toLowerCase(), summary: `${name.toLowerCase()}: ${clip(str('file_path') ?? '')}` };
    case 'Glob':
    case 'Grep':
      return { tool: name.toLowerCase(), summary: `${name.toLowerCase()}: ${clip(str('pattern') ?? '')}` };
    case 'WebFetch':
    case 'WebSearch':
      return { tool: name.toLowerCase(), summary: `${name.toLowerCase()}: ${clip(str('url') ?? str('query') ?? '')}` };
    default: {
      // Unknown tool: show the first short string arg as context.
      const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
      return { tool: name, summary: typeof first === 'string' ? `${name}: ${clip(first)}` : name };
    }
  }
}

/**
 * Summarize tool_use input for the audit log: drop anything that looks
 * like image bytes, scrub known secret shapes, truncate long strings.
 * Mirrors SDK mode's audit-arg policy. Pure — exported for tests.
 */
export function summarizeCliToolArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'image' || k === 'data' || k === 'source') continue; // never log base64 image bytes
    if (typeof v === 'string') {
      const scrubbed = redactSecrets(v);
      out[k] = scrubbed.length > 200 ? scrubbed.slice(0, 200) + '…' : scrubbed;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      // Arrays/objects (e.g. coordinate pairs) — keep small ones, drop the rest.
      const json = JSON.stringify(v) ?? '';
      out[k] = json.length <= 200 ? v : '[omitted]';
    }
  }
  return out;
}

/** A tool_use we've seen go out but whose tool_result hasn't come back yet. */
export interface PendingToolCall {
  id: string;
  tool: string;
  action?: string | undefined;
  /** Redacted one-liner for the live action line. */
  summary: string;
  args: Record<string, unknown>;
  startedAt: number;
  /** Verbatim tool name from the stream (e.g. `Bash`, `PowerShell`) — the CLI recorder maps on this. */
  rawName: string;
  /** Full, un-truncated tool input — what `--record` crystallizes; the audit copy above is summarized. */
  rawInput: Record<string, unknown>;
}

export function pendingToolCall(event: ToolUseEvent, now: number): PendingToolCall {
  const desc = describeToolUse(event.name, event.input);
  return {
    id: event.id,
    tool: desc.tool,
    action: desc.action,
    summary: desc.summary,
    args: summarizeCliToolArgs(event.input),
    startedAt: now,
    rawName: event.name,
    rawInput: event.input,
  };
}

/** Audit entry for a completed (tool_use → tool_result) pair. */
export function auditEntryFor(pending: PendingToolCall, isError: boolean, now: number): AuditEntry {
  return {
    tool: pending.tool,
    action: pending.action,
    args: pending.args,
    durationMs: now - pending.startedAt,
    ok: !isError,
    mode: 'cli',
    ...(isError ? { error: 'tool_result reported is_error' } : {}),
  };
}

/**
 * Audit entries for tool_use blocks that never got a tool_result before
 * the stream ended — an interrupted run (Ctrl+C, max-turns cutoff, child
 * crash). Logged as not-ok so the trail shows the call may or may not
 * have fired.
 */
export function flushPendingAudits(pending: Iterable<PendingToolCall>, now: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const p of pending) {
    out.push({
      tool: p.tool,
      action: p.action,
      args: p.args,
      durationMs: now - p.startedAt,
      ok: false,
      mode: 'cli',
      error: 'no tool_result observed before stream end',
    });
  }
  return out;
}
