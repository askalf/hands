#!/usr/bin/env node
// PreToolUse hook for Claude Login mode.
//
// cli-mode passes `--settings` with a PreToolUse hook pointing at this
// script, so the same hard-block list that gates SDK-mode bash also
// gates the claude child's Bash tool. Claude Code runs PreToolUse hooks
// even under --dangerously-skip-permissions and respects a deny
// decision — this is enforcement, not advice (the prompt-text
// guardrails remain advice).
//
// Contract (code.claude.com/docs/en/hooks):
//   stdin  — JSON: { hook_event_name, tool_name, tool_input, ... }
//   stdout — to block: { hookSpecificOutput: { hookEventName:
//            'PreToolUse', permissionDecision: 'deny',
//            permissionDecisionReason } }. No output = normal flow.
//   exit 0 — always. A hook failure must never take down the host run,
//            so every failure path fails open (defer), which is exactly
//            the pre-0.6 status quo for CLI mode.
//
// stdout hygiene matters: anything that isn't the decision JSON
// confuses the hook reader, so this module never prints — it uses the
// pure evaluateCommand, not the chatty checkCommand.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCommand } from './util/guardrails.js';
import { appendAudit } from './util/audit.js';
import { redactSecrets } from './util/redact.js';

export interface HookDecision {
  deny: boolean;
  reason?: string | undefined;
  command?: string | undefined;
}

/**
 * Decide whether a PreToolUse payload describes a Bash command the
 * hard-block list refuses. Anything unexpected — wrong event, wrong
 * tool, missing/odd-shaped input — defers. Pure — exported for tests.
 */
export function decideHook(payload: unknown): HookDecision {
  if (typeof payload !== 'object' || payload === null) return { deny: false };
  const p = payload as Record<string, unknown>;
  if (p['hook_event_name'] !== 'PreToolUse' || p['tool_name'] !== 'Bash') return { deny: false };
  const input = p['tool_input'];
  if (typeof input !== 'object' || input === null) return { deny: false };
  const command = (input as Record<string, unknown>)['command'];
  if (typeof command !== 'string' || !command.trim()) return { deny: false };

  const verdict = evaluateCommand(command);
  if (verdict.blocked) {
    return { deny: true, reason: verdict.reason, command };
  }
  return { deny: false };
}

/** The JSON Claude Code expects on stdout for a deny. Pure — exported for tests. */
export function denyResponse(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `hands guardrail: ${reason}. This command class is hard-blocked by the operator's safety policy — do not retry variants of it; explain the block instead.`,
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // unreadable payload — fail open
  }

  const decision = decideHook(payload);
  if (!decision.deny || !decision.reason) return;

  // The blocked attempt is itself audit-worthy — it's the one class of
  // event the operator most wants in the trail.
  await appendAudit({
    tool: 'bash',
    action: 'guardrail_block',
    args: { command: redactSecrets(decision.command?.slice(0, 200) ?? '') },
    ok: false,
    mode: 'cli',
    error: decision.reason,
  });

  process.stdout.write(denyResponse(decision.reason) + '\n');
}

// Entry-point check that survives spaces in the install path: compare
// resolved filesystem paths, not URL strings (import.meta.url percent-
// encodes spaces while argv[1] has them literal — same bug class the
// MCP server hit pre-0.5).
const isMain = (() => {
  if (!process.argv[1]) return false;
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  try {
    return norm(resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then(
    () => process.exit(0),
    () => process.exit(0), // fail open — never block the host run on a hook crash
  );
}
