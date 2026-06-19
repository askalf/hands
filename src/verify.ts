// Self-verifying tasks — `hands run --verify`.
//
// Most computer-use agents fire-and-forget: they do the work and *tell* you
// it worked. hands can prove it. With --verify, the agent commits to a
// concrete, checkable success criterion and then runs a real check — in SDK
// mode via a dedicated `verify` tool whose result is ground truth (an exit
// code, not the model's self-assessment), in Claude Login mode via the same
// instruction over its built-in shell. If the check fails, the agent fixes
// and re-verifies; it can't claim success on "it should have worked".
//
// The prompt augmentation is the shared core (both modes). The deterministic
// tool is the SDK-mode enhancement. Pure builders + a small executor here,
// wired into sdk-mode.ts / cli-mode.ts.

import { execSync } from 'node:child_process';
import { checkCommand } from './util/guardrails.js';

/**
 * The self-verification instruction appended to the system prompt. When a
 * deterministic `verify` tool is available (SDK mode), point the agent at
 * it; otherwise tell it to verify over its own shell. Pure.
 */
export function buildVerifyInstruction(hasVerifyTool: boolean): string {
  const how = hasVerifyTool
    ? 'Use the `verify` tool: give it a one-line claim and a shell command that exits 0 only if the claim holds. Its result is the source of truth.'
    : 'Verify by running a command whose exit code or output confirms success — `test -f <file>` / `Test-Path <file>`, a grep/findstr for expected content, `git diff --quiet`, or a re-read of what you changed.';
  return [
    'SELF-VERIFICATION (required): before you tell the user a task is complete, PROVE it.',
    'State a concrete, checkable success criterion, then check it.',
    how,
    'If the check fails, fix the problem and re-verify. Never claim success on the strength of "it should have worked" — only on a check that passed. If you genuinely cannot verify, say so explicitly rather than implying success.',
  ].join(' ');
}

/** The SDK-mode `verify` tool declaration (shape only — typed loosely for the SDK cast). */
export function buildVerifyTool(): Record<string, unknown> {
  return {
    name: 'verify',
    description:
      'Prove the task actually succeeded. Pass a one-line `claim` and a `command` (shell) that exits 0 ONLY IF the claim is true — e.g. `test -f ~/out.txt`, `Test-Path C:\\out.txt`, `findstr /C:"OK" log.txt`, `git diff --quiet`. Call this BEFORE telling the user you are done. Returns VERIFIED when the command exits 0, otherwise FAILED with the output so you can fix the problem and re-verify. Define your success check up front and prove it — do not claim success without a passing check.',
    input_schema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'The success criterion you are asserting (one line).' },
        command: { type: 'string', description: 'A shell command that exits 0 if and only if the claim holds.' },
      },
      required: ['claim', 'command'],
    },
  };
}

export interface VerifyOutcome {
  ok: boolean;
  exitCode: number;
  output: string;
}

/**
 * Run a verification command. Passes the same hard-block guardrail as the
 * bash tool (a check is still a shell command), then runs it and reports
 * pass/fail by exit code. Never throws — a failed check is a result, not an
 * error.
 */
export function runVerifyCheck(command: string): VerifyOutcome {
  const guard = checkCommand(command);
  if (guard.blocked) {
    return { ok: false, exitCode: -1, output: `guardrail blocked the verify command: ${guard.reason}` };
  }
  try {
    const out = execSync(command, { timeout: 30_000, encoding: 'utf-8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, exitCode: 0, output: trim(out) };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof e.status === 'number' ? e.status : 1;
    const output = trim([e.stdout, e.stderr, e.message].filter(Boolean).join('\n'));
    return { ok: false, exitCode, output };
  }
}

function trim(s: string): string {
  const t = (s ?? '').trim();
  return t.length > 800 ? t.slice(0, 800) + '…' : t;
}

/**
 * Format a verify outcome as the tool_result text the model reads back. Pure.
 */
export function formatVerifyResult(claim: string, outcome: VerifyOutcome): string {
  if (outcome.ok) {
    return `VERIFIED ✓ — "${claim}" (command exited 0).${outcome.output ? `\n${outcome.output}` : ''}`;
  }
  return `FAILED ✗ — "${claim}" did NOT hold (exit ${outcome.exitCode}). Fix the problem and re-verify.${outcome.output ? `\nOutput:\n${outcome.output}` : ''}`;
}
