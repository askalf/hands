// Tests for src/macro-run.ts — deterministic macro replay. Focused on the
// `powershell` step executor's exit-code handling (#160): execSync only
// throws when the SPAWNED process (powershell.exe) exits non-zero, and
// powershell.exe exits 0 even when the command inside it failed — so a
// failed step must not be recorded/replayed as ok:true. HOME is redirected
// BEFORE import, same pattern as macros.test.mjs / audit.test.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'hands-macro-run-test-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

const { playMacro } = await import('../dist/macro-run.js');
const { saveMacro } = await import('../dist/macros.js');
const { readAuditHistory } = await import('../dist/util/audit.js');

after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
});

test(
  'playMacro — a powershell step whose failure is only visible via $LASTEXITCODE is recorded ok:false, not ok:true',
  { skip: process.platform !== 'win32' ? 'windows-only (powershell.exe)' : false },
  async () => {
    // A native command failing is only swallowed when something runs AFTER
    // it (confirmed empirically: powershell.exe DOES forward a lone trailing
    // native command's exit code, but once more output follows, it reverts
    // to 0) — so the repro needs a step after the failure, exactly the
    // "a failed step returns normally" shape #160 describes.
    await saveMacro({
      name: 'fails-silently',
      steps: [{ tool: 'powershell', input: { command: 'node -e "process.exit(7)"\nWrite-Output "cleanup done"' } }],
    });
    const result = await playMacro('fails-silently');
    assert.equal(result.failed, 1, 'the failing step must count as failed');
    assert.equal(result.ran, 0);

    const history = await readAuditHistory();
    const entry = history.at(-1);
    assert.equal(entry.tool, 'powershell');
    assert.equal(entry.ok, false, 'a failed step must never be audited as ok:true');
  },
);

test(
  'playMacro — a genuinely passing powershell step still replays ok:true',
  { skip: process.platform !== 'win32' ? 'windows-only (powershell.exe)' : false },
  async () => {
    await saveMacro({
      name: 'passes',
      steps: [{ tool: 'powershell', input: { command: 'node -e "process.exit(0)"' } }],
    });
    const result = await playMacro('passes');
    assert.equal(result.ran, 1);
    assert.equal(result.failed, 0);

    const history = await readAuditHistory();
    const entry = history.at(-1);
    assert.equal(entry.tool, 'powershell');
    assert.equal(entry.ok, true);
  },
);
