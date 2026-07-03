// Daemon process control (src/daemon-ctl.ts) — the single-instance pidfile
// lock, against a temp HOME and real (short-lived) child processes. The
// loop itself (daemon-run.ts) is exercised end-to-end live; its pure parts
// (trigger engine, argv building, state, log) are covered in watch/jobs
// tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'hands-daemon-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HANDS_QUIET = '1';

const { acquirePidLock, releasePidLock, readPid, isPidAlive, pidFilePath } = await import('../dist/daemon-ctl.js');

test('pid lock — acquire writes our pid; release removes only our own file', async () => {
  await acquirePidLock();
  assert.equal(await readPid(), process.pid);
  await releasePidLock();
  assert.equal(await readPid(), null);
});

test('pid lock — re-acquiring our own lock is fine (restart after crash in same pid is a non-case, but idempotence is)', async () => {
  await acquirePidLock();
  await acquirePidLock();
  assert.equal(await readPid(), process.pid);
  await releasePidLock();
});

test('pid lock — a stale pidfile (dead process) is reclaimed silently', async () => {
  // A child that exits immediately gives us a real, guaranteed-dead pid.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  await new Promise((r) => child.on('exit', r));
  mkdirSync(join(fakeHome, '.hands'), { recursive: true });
  writeFileSync(pidFilePath(), String(deadPid));
  await acquirePidLock();
  assert.equal(await readPid(), process.pid, 'stale lock reclaimed');
  await releasePidLock();
});

test('pid lock — a LIVE foreign process holds the lock; acquire throws', async () => {
  // A child that sleeps is a real live foreign pid.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
  try {
    mkdirSync(join(fakeHome, '.hands'), { recursive: true });
    writeFileSync(pidFilePath(), String(child.pid));
    assert.ok(isPidAlive(child.pid), 'child must be alive for this test to mean anything');
    await assert.rejects(() => acquirePidLock(), /already running \(pid/);
  } finally {
    child.kill();
    writeFileSync(pidFilePath(), '');
  }
});
