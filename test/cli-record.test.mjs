// Unit tests for CLI-mode --record: the Claude Code tool_use → macro
// step mapper, the success-only recorder, the powershell step surface
// (encode / preview / recordability / export), and the raw-input
// carry on PendingToolCall. Pure functions — no child_process, no
// claude CLI dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliCallToMacroStep, CliMacroRecorder } from '../dist/cli-record.js';
import {
  encodePowerShellCommand, isRecordable, previewStep, macroToScript,
} from '../dist/macros.js';
import { isReplaySafeTrajectory } from '../dist/learn.js';
import { pendingToolCall } from '../dist/cli-stream.js';

// ── cliCallToMacroStep: the mapping table ───────────────────────────

test('Bash maps to a bash step with the verbatim command', () => {
  const step = cliCallToMacroStep('Bash', { command: 'echo hi', description: 'greet' });
  assert.deepEqual(step, { tool: 'bash', input: { command: 'echo hi' } });
});

test('PowerShell maps to a first-class powershell step', () => {
  const step = cliCallToMacroStep('PowerShell', { command: 'Get-Date; Get-Process' });
  assert.deepEqual(step, { tool: 'powershell', input: { command: 'Get-Date; Get-Process' } });
});

test('Write maps to an edit create step', () => {
  const step = cliCallToMacroStep('Write', { file_path: 'C:\\t\\a.txt', content: 'hello' });
  assert.deepEqual(step, {
    tool: 'str_replace_based_edit_tool',
    input: { command: 'create', path: 'C:\\t\\a.txt', file_text: 'hello' },
  });
});

test('Edit maps to an edit str_replace step', () => {
  const step = cliCallToMacroStep('Edit', { file_path: '/tmp/a.txt', old_string: 'foo', new_string: 'bar' });
  assert.deepEqual(step, {
    tool: 'str_replace_based_edit_tool',
    input: { command: 'str_replace', path: '/tmp/a.txt', old_str: 'foo', new_str: 'bar' },
  });
});

test('Edit with an empty old_string still maps (empty string is a valid needle to reject at replay, not at record)', () => {
  const step = cliCallToMacroStep('Edit', { file_path: '/tmp/a.txt', old_string: '', new_string: 'x' });
  assert.equal(step?.input['old_str'], '');
});

test('reads, searches, and MCP screenshots do not map', () => {
  assert.equal(cliCallToMacroStep('Read', { file_path: '/tmp/a.txt' }), null);
  assert.equal(cliCallToMacroStep('Glob', { pattern: '**/*.ts' }), null);
  assert.equal(cliCallToMacroStep('Grep', { pattern: 'foo' }), null);
  assert.equal(cliCallToMacroStep('mcp__askalf-computer__screenshot', {}), null);
  assert.equal(cliCallToMacroStep('WebFetch', { url: 'https://example.com' }), null);
  assert.equal(cliCallToMacroStep('TotallyUnknown', { anything: true }), null);
});

test('missing required fields yield null, not a broken step', () => {
  assert.equal(cliCallToMacroStep('Bash', {}), null);
  assert.equal(cliCallToMacroStep('PowerShell', { command: 42 }), null);
  assert.equal(cliCallToMacroStep('Write', { content: 'orphan' }), null);
  assert.equal(cliCallToMacroStep('Edit', { file_path: '/tmp/a.txt' }), null);
});

// ── CliMacroRecorder: order + filtering ─────────────────────────────

test('recorder keeps only mappable calls, in order', () => {
  const r = new CliMacroRecorder();
  r.record('Read', { file_path: '/a' });
  r.record('Bash', { command: 'step-1' });
  r.record('mcp__askalf-computer__screenshot', {});
  r.record('PowerShell', { command: 'step-2' });
  r.record('Write', { file_path: '/b', content: 'step-3' });
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[0].input['command'], 'step-1');
  assert.equal(r.steps[1].input['command'], 'step-2');
  assert.equal(r.steps[2].input['file_text'], 'step-3');
});

// ── powershell step surface ─────────────────────────────────────────

test('encodePowerShellCommand is base64 of UTF-16LE (what -EncodedCommand expects)', () => {
  const cmd = 'Write-Output "hi"';
  const encoded = encodePowerShellCommand(cmd);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), cmd);
  // Multiline survives the encoding untouched — the whole point.
  const multi = "Get-Date\nGet-Process | Select -First 1";
  assert.equal(Buffer.from(encodePowerShellCommand(multi), 'base64').toString('utf16le'), multi);
});

test('powershell steps are recordable and previewable', () => {
  assert.equal(isRecordable('powershell', undefined, { command: 'Get-Date' }), true);
  assert.equal(isRecordable('powershell', undefined, { command: '' }), false);
  assert.equal(previewStep({ tool: 'powershell', input: { command: 'Get-Date' } }), 'powershell: Get-Date');
});

test('macroToScript keeps powershell steps native in .ps1 and shells out from sh', () => {
  const macro = {
    name: 'ps-test',
    steps: [{ tool: 'powershell', input: { command: 'Get-Date' } }],
  };
  const ps = macroToScript(macro, 'win32');
  assert.equal(ps.language, 'powershell');
  assert.match(ps.script, /^Get-Date$/m);
  assert.equal(ps.scriptable, 1);
  assert.equal(ps.manual, 0);

  const sh = macroToScript(macro, 'linux');
  assert.equal(sh.language, 'sh');
  assert.match(sh.script, /powershell -NoProfile -EncodedCommand /);
  assert.equal(sh.scriptable, 1);
});

test('multiline powershell steps do not trip the win32 replay-safety gate (bash-only concern)', () => {
  const steps = [{ tool: 'powershell', input: { command: "Get-Date\nGet-Process" } }];
  assert.equal(isReplaySafeTrajectory(steps, 'win32'), true);
  const bashSteps = [{ tool: 'bash', input: { command: "echo a\necho b" } }];
  assert.equal(isReplaySafeTrajectory(bashSteps, 'win32'), false);
});

// ── PendingToolCall carries the raw call for the recorder ───────────

test('pendingToolCall preserves the verbatim name and full input alongside the summarized audit copy', () => {
  const longCommand = 'Write-Output "' + 'x'.repeat(500) + '"';
  const call = pendingToolCall(
    { kind: 'tool_use', id: 'toolu_9', name: 'PowerShell', input: { command: longCommand } },
    1000,
  );
  assert.equal(call.rawName, 'PowerShell');
  assert.equal(call.rawInput['command'], longCommand);      // full fidelity for --record
  assert.ok(String(call.args['command']).length < longCommand.length); // audit copy stays truncated
});
