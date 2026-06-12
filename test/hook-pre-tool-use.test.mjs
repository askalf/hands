// Unit tests for the PreToolUse guardrail hook (Claude Login mode
// enforcement) and the settings builder that wires it into the claude
// child. Decision logic is tested pure; the stdin→stdout contract and
// the entry-point guard are exercised through a real child process,
// exactly the way Claude Code invokes the hook.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideHook, denyResponse } from '../dist/hook-pre-tool-use.js';
import { buildHookSettings } from '../dist/cli-mode.js';
import { evaluateCommand } from '../dist/util/guardrails.js';

const HOOK_SCRIPT = resolve('dist', 'hook-pre-tool-use.js');
// The deny path appends to ~/.hands/audit.jsonl — point the child at a
// throwaway home so tests never touch the operator's real audit log.
const testHome = mkdtempSync(join(tmpdir(), 'hands-hook-test-'));
after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
});

function runHook(stdinText) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: testHome, USERPROFILE: testHome, HOMEDRIVE: '', HOMEPATH: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

function payload(toolName, toolInput, event = 'PreToolUse') {
  return {
    session_id: 'sess-1',
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

test('decideHook — hard-blocked Bash command is denied with a reason', () => {
  const d = decideHook(payload('Bash', { command: 'format C: /y' }));
  assert.equal(d.deny, true);
  assert.match(d.reason, /Format disk/i);
  assert.equal(d.command, 'format C: /y');
});

test('decideHook — benign Bash command defers', () => {
  const d = decideHook(payload('Bash', { command: 'Get-ChildItem ~/Downloads' }));
  assert.equal(d.deny, false);
});

test('decideHook — warn-level command defers (warnings are not blocks)', () => {
  const verdict = evaluateCommand('taskkill /im notepad.exe');
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warnings.length > 0);
  assert.equal(decideHook(payload('Bash', { command: 'taskkill /im notepad.exe' })).deny, false);
});

test('decideHook — non-Bash tools and other events defer', () => {
  assert.equal(decideHook(payload('Write', { file_path: '/etc/passwd' })).deny, false);
  assert.equal(decideHook(payload('Bash', { command: 'format C:' }, 'PostToolUse')).deny, false);
});

test('decideHook — malformed payloads fail open', () => {
  assert.equal(decideHook(null).deny, false);
  assert.equal(decideHook('string').deny, false);
  assert.equal(decideHook({}).deny, false);
  assert.equal(decideHook(payload('Bash', null)).deny, false);
  assert.equal(decideHook(payload('Bash', { command: 42 })).deny, false);
  assert.equal(decideHook(payload('Bash', { command: '   ' })).deny, false);
});

test('denyResponse — emits the documented hookSpecificOutput deny shape', () => {
  const parsed = JSON.parse(denyResponse('Format disk drive'));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /hands guardrail: Format disk drive/);
});

test('evaluateCommand — pure twin agrees with the block list and stays silent on shape', () => {
  const blocked = evaluateCommand('diskpart');
  assert.equal(blocked.blocked, true);
  assert.equal(typeof blocked.reason, 'string');
  assert.deepEqual(blocked.warnings, []);

  const clean = evaluateCommand('echo hello');
  assert.equal(clean.blocked, false);
  assert.deepEqual(clean.warnings, []);
});

test('buildHookSettings — quotes both paths and targets Bash PreToolUse', () => {
  const s = buildHookSettings('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\some user\\dist\\hook-pre-tool-use.js');
  const entry = s.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash');
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(
    entry.hooks[0].command,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\some user\\dist\\hook-pre-tool-use.js"',
  );
});

test('buildHookSettings — round-trips through JSON intact', () => {
  const s = buildHookSettings('/usr/local/bin/node', '/opt/hands/dist/hook-pre-tool-use.js');
  const back = JSON.parse(JSON.stringify(s));
  assert.equal(back.hooks.PreToolUse[0].hooks[0].command, '"/usr/local/bin/node" "/opt/hands/dist/hook-pre-tool-use.js"');
});

// ── subprocess contract (how Claude Code actually calls it) ─────────

test('hook subprocess — blocked command → deny JSON on stdout, exit 0', async () => {
  const { code, stdout } = await runHook(JSON.stringify(
    payload('Bash', { command: 'diskpart' }),
  ));
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /hands guardrail/);
});

test('hook subprocess — benign command → no output, exit 0', async () => {
  const { code, stdout } = await runHook(JSON.stringify(
    payload('Bash', { command: 'echo hello' }),
  ));
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('hook subprocess — garbage stdin fails open: no output, exit 0', async () => {
  const { code, stdout } = await runHook('this is not json{');
  assert.equal(code, 0);
  assert.equal(stdout, '');
});
