// CLI-mode --record: crystallize a Claude Login run into a macro.
//
// SDK mode records at the dispatch site (sdk-mode.ts owns every tool
// call). In Claude Login mode the claude child dispatches tools itself,
// so hands never sees the call — but the stream-json feed does: every
// assistant tool_use block arrives with its FULL, un-truncated input.
// This module maps those blocks (Claude Code tool names) onto macro
// steps, so `hands run --record` works on a subscription with zero
// API-key/SDK requirements.
//
// Same trust rule as SDK recording: a call only crystallizes after its
// tool_result comes back successful. Failed or hook-blocked calls never
// become steps — recording them as ok was the v0.18 defect.

import type { MacroStep } from './macros.js';

/**
 * Map one CLI-mode tool_use (Claude Code tool name + raw input) to a
 * macro step, or null when the call has no replay value (reads,
 * searches, screenshots) or no lossless mapping exists. Pure.
 */
export function cliCallToMacroStep(name: string, input: Record<string, unknown>): MacroStep | null {
  const str = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === 'string' ? v : undefined;
  };

  if (name === 'Bash') {
    const command = str('command');
    return command ? { tool: 'bash', input: { command } } : null;
  }
  // Claude Code on Windows dispatches shell work through a PowerShell
  // tool. Recorded as a first-class `powershell` step — replay runs it
  // via -EncodedCommand, which survives cmd's line-splitting, so even
  // multiline PowerShell replays reliably (unlike multiline bash).
  if (name === 'PowerShell') {
    const command = str('command');
    return command ? { tool: 'powershell', input: { command } } : null;
  }
  if (name === 'Write') {
    const path = str('file_path');
    if (!path) return null;
    return {
      tool: 'str_replace_based_edit_tool',
      input: { command: 'create', path, file_text: str('content') ?? '' },
    };
  }
  if (name === 'Edit') {
    const path = str('file_path');
    const oldStr = str('old_string');
    if (!path || oldStr === undefined) return null;
    // replace_all edits are recorded as plain str_replace: replay errors
    // loudly on a multi-match (which --heal can repair) — better than a
    // silently incomplete macro.
    return {
      tool: 'str_replace_based_edit_tool',
      input: { command: 'str_replace', path, old_str: oldStr, new_str: str('new_string') ?? '' },
    };
  }
  // Read/Glob/Grep/WebFetch/screenshot MCP/unknown — not effectful, or
  // not replayable without the model.
  return null;
}

/**
 * Accumulates the successful effectful tool calls of a Claude Login
 * run, in stream order. The CLI cousin of macros.ts' MacroRecorder —
 * fed from tool_result events (success only), not the dispatch site.
 */
export class CliMacroRecorder {
  readonly steps: MacroStep[] = [];
  record(name: string, input: Record<string, unknown>): void {
    const step = cliCallToMacroStep(name, input);
    if (step) this.steps.push(step);
  }
}
