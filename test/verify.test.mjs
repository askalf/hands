// Tests for src/verify.ts — self-verification. Pure builders are tested
// directly; runVerifyCheck runs real (harmless) node commands to confirm it
// reports pass/fail by exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyInstruction, buildVerifyTool, runVerifyCheck, formatVerifyResult } from '../dist/verify.js';

test('buildVerifyInstruction — tool variant points at `verify`, shell variant at exit codes', () => {
  const withTool = buildVerifyInstruction(true);
  assert.match(withTool, /SELF-VERIFICATION/);
  assert.match(withTool, /`verify` tool/);
  const withoutTool = buildVerifyInstruction(false);
  assert.match(withoutTool, /SELF-VERIFICATION/);
  assert.match(withoutTool, /exit code/);
  assert.doesNotMatch(withoutTool, /`verify` tool/);
});

test('buildVerifyTool — requires claim + command', () => {
  const t = buildVerifyTool();
  assert.equal(t.name, 'verify');
  assert.deepEqual(t.input_schema.required, ['claim', 'command']);
});

test('runVerifyCheck — passing command → ok, exit 0', () => {
  const r = runVerifyCheck('node -e "process.exit(0)"');
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
});

test('runVerifyCheck — failing command → not ok, with the real exit code', () => {
  const r = runVerifyCheck('node -e "process.exit(3)"');
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
});

test('runVerifyCheck — guardrail-blocked command never executes', () => {
  // checkCommand hard-blocks disk formatting; the check must refuse, not run it.
  const r = runVerifyCheck('format C: /y');
  assert.equal(r.ok, false);
  assert.match(r.output, /guardrail/);
});

test('formatVerifyResult — VERIFIED vs FAILED phrasing', () => {
  assert.match(formatVerifyResult('file exists', { ok: true, exitCode: 0, output: '' }), /VERIFIED/);
  const f = formatVerifyResult('file exists', { ok: false, exitCode: 1, output: 'nope' });
  assert.match(f, /FAILED/);
  assert.match(f, /re-verify/);
});
