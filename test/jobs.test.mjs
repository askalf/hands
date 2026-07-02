// Jobs (src/jobs.ts) — the pure model (validation, child argv building,
// substitution) plus the fs CRUD, daemon state, and event log against a
// temp HOME. No daemon process is started here (see daemon.test.mjs for
// process control; the loop itself is E2E'd live).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'hands-jobs-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HANDS_QUIET = '1';

const {
  isValidJobName, validateJob, buildActionArgs, substituteContext, describeJob,
  saveJob, loadJob, deleteJob, listJobNames, setJobEnabled,
  readJobStates, writeJobStates, appendDaemonLog, readDaemonLog,
} = await import('../dist/jobs.js');

const JOB = {
  name: 'ingest',
  trigger: { kind: 'file', glob: '~/in/*.csv' },
  action: { kind: 'macro', name: 'ingest-csv' },
  intervalMs: 2000,
  heal: true,
  commit: true,
  warden: false,
  enabled: true,
  createdAt: 1751400000000,
};

// ── pure: validation ────────────────────────────────────────────────

test('isValidJobName — one safe path segment', () => {
  assert.ok(isValidJobName('nightly-ingest_2'));
  assert.ok(!isValidJobName('../escape'));
  assert.ok(!isValidJobName('a b'));
  assert.ok(!isValidJobName(''));
  assert.ok(!isValidJobName('x'.repeat(65)));
});

test('validateJob — a good job has no errors', () => {
  assert.deepEqual(validateJob(JOB), []);
  assert.deepEqual(validateJob({ ...JOB, trigger: { kind: 'schedule', at: '07:30' }, intervalMs: undefined }), []);
  assert.deepEqual(validateJob({ ...JOB, heal: false, commit: false, action: { kind: 'task', task: 'do things' } }), []);
});

test('validateJob — every broken shape produces a fix-it error', () => {
  assert.ok(validateJob({ ...JOB, name: '../x' }).length > 0, 'bad name');
  assert.ok(validateJob({ ...JOB, trigger: { kind: 'file', glob: ' ' } }).length > 0, 'empty glob');
  assert.ok(validateJob({ ...JOB, trigger: { kind: 'clipboard', pattern: '(' } }).length > 0, 'invalid regex');
  assert.ok(validateJob({ ...JOB, trigger: { kind: 'schedule', at: '25:00' } }).length > 0, 'bad HH:MM');
  assert.ok(validateJob({ ...JOB, trigger: { kind: 'interval' }, intervalMs: undefined }).length > 0, 'interval without period');
  assert.ok(validateJob({ ...JOB, intervalMs: 10 }).length > 0, 'sub-floor interval (hot-loop guard)');
  assert.ok(validateJob({ ...JOB, action: { kind: 'task', task: 'x' }, heal: true }).length > 0, 'heal on a task action');
  assert.ok(validateJob({ ...JOB, heal: false, commit: true }).length > 0, 'commit without heal');
  assert.ok(validateJob({ ...JOB, heal: false, commit: false, warden: true }).length > 0, 'warden without heal');
  assert.ok(validateJob({ ...JOB, trigger: { kind: 'nope' } }).length > 0, 'unknown trigger kind');
});

// ── pure: argv building ─────────────────────────────────────────────

test('substituteContext — {{key}} replacement, multiple occurrences', () => {
  assert.equal(substituteContext('rename {{file}} and log {{file}}', { file: 'a.pdf' }), 'rename a.pdf and log a.pdf');
  assert.equal(substituteContext('no placeholders', { file: 'x' }), 'no placeholders');
});

test('buildActionArgs — macro action: --set context + heal flags in child argv', () => {
  assert.deepEqual(
    buildActionArgs(JOB, { file: 'C:\\in\\new.csv' }),
    ['play', 'ingest-csv', '--set', 'file=C:\\in\\new.csv', '--heal', '--commit'],
  );
  assert.deepEqual(
    buildActionArgs({ ...JOB, heal: false, commit: false }, {}),
    ['play', 'ingest-csv'],
  );
  assert.deepEqual(
    buildActionArgs({ ...JOB, warden: true }, {}),
    ['play', 'ingest-csv', '--heal', '--commit', '--warden'],
  );
});

test('buildActionArgs — task action: substituted prompt via run --once', () => {
  const job = { ...JOB, heal: false, commit: false, action: { kind: 'task', task: 'file {{file}} arrived — rename it' } };
  assert.deepEqual(
    buildActionArgs(job, { file: 'a.pdf' }),
    ['run', '--once', 'file a.pdf arrived — rename it'],
  );
});

test('describeJob — one-liner carries trigger, cadence, and action', () => {
  const line = describeJob(JOB);
  assert.match(line, /new file matching/);
  assert.match(line, /every 2000ms/);
  assert.match(line, /play ingest-csv \(heal\+commit\)/);
  assert.match(describeJob({ ...JOB, trigger: { kind: 'schedule', at: '07:00' } }), /daily at 07:00 → /);
});

// ── fs: CRUD ────────────────────────────────────────────────────────

test('job CRUD — save, load, list, enable/disable, delete round-trip', async () => {
  const path = await saveJob(JOB);
  assert.ok(path.endsWith('ingest.json'));
  const loaded = await loadJob('ingest');
  assert.deepEqual(loaded, JOB);
  assert.deepEqual(await listJobNames(), ['ingest']);

  await assert.rejects(() => saveJob(JOB), /already exists/, 'collision without --force');
  await saveJob({ ...JOB, intervalMs: 5000 }, { force: true });
  assert.equal((await loadJob('ingest')).intervalMs, 5000);

  const disabled = await setJobEnabled('ingest', false);
  assert.equal(disabled.enabled, false);
  assert.equal((await loadJob('ingest')).enabled, false);

  await deleteJob('ingest');
  assert.deepEqual(await listJobNames(), []);
  await assert.rejects(() => loadJob('ingest'), /not found/);
  await assert.rejects(() => deleteJob('ingest'), /not found/);
});

test('saveJob — an invalid job never reaches disk', async () => {
  await assert.rejects(() => saveJob({ ...JOB, name: 'bad', commit: true, heal: false }), /--commit only works/);
  assert.deepEqual(await listJobNames(), []);
});

test('loadJob — traversal names are rejected before touching the fs', async () => {
  await assert.rejects(() => loadJob('../escape'), /Invalid job name/);
});

// ── fs: state + log ─────────────────────────────────────────────────

test('job state — read/write round-trip; missing file is an empty map', async () => {
  assert.deepEqual(await readJobStates(), {});
  await writeJobStates({ ingest: { fires: 3, lastFireTs: 1751400000000, lastOk: true } });
  const states = await readJobStates();
  assert.equal(states.ingest.fires, 3);
  assert.equal(states.ingest.lastOk, true);
});

test('daemon log — append, read, per-job filter, last-N', async () => {
  await appendDaemonLog({ event: 'start', detail: 'pid 1' });
  await appendDaemonLog({ job: 'a', event: 'fire' });
  await appendDaemonLog({ job: 'a', event: 'ok', detail: 'done' });
  await appendDaemonLog({ job: 'b', event: 'fail', detail: 'boom' });

  const all = await readDaemonLog();
  assert.equal(all.length, 4);
  assert.ok(all.every((e) => typeof e.ts === 'number'), 'timestamps stamped on append');

  const a = await readDaemonLog({ job: 'a' });
  assert.deepEqual(a.map((e) => e.event), ['fire', 'ok']);

  const last2 = await readDaemonLog({ last: 2 });
  assert.deepEqual(last2.map((e) => e.event), ['ok', 'fail']);
});
