// Jobs — persisted automations for the hands daemon. A job is a trigger
// (file / clipboard / command / interval / daily schedule) plus an action
// (LLM task or $0 macro replay, optionally self-healing) that the daemon
// runs unattended. `hands watch` is the one-off foreground version; a job
// is the same idea made durable: it survives the terminal, the reboot, and
// — with --heal --commit — the drift.
//
// This module is the pure model (validation, child-process argv building,
// context substitution) plus the fs CRUD for job files, the daemon's
// per-job state, and the daemon event log. The loop lives in daemon-run.ts.
//
// Layout under ~/.hands/ (all owner-only):
//   jobs/<name>.json   one job definition — hand-editable
//   jobs/.state.json   daemon-owned runtime state (fires, last outcome)
//   daemon.jsonl       append-only event log, rotated like the audit log

import { readFile, writeFile, mkdir, readdir, unlink, rename, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseAt, parseInterval, describeTrigger, type WatchTrigger, type WatchAction } from './watch.js';

export interface Job {
  name: string;
  trigger: WatchTrigger;
  action: WatchAction;
  /** Poll interval for file/clipboard/command triggers, and the period for interval triggers. */
  intervalMs?: number | undefined;
  /** Macro actions: self-heal a failing step. */
  heal?: boolean | undefined;
  /** Macro actions, with heal: commit repairs back into the macro. */
  commit?: boolean | undefined;
  /** Macro actions, with heal: gate the healer through warden (fails closed unattended). */
  warden?: boolean | undefined;
  enabled: boolean;
  createdAt: number;
}

export interface JobState {
  fires: number;
  lastFireTs?: number | undefined;
  lastOk?: boolean | undefined;
  /** Trailing output / error of the last run, truncated. */
  lastDetail?: string | undefined;
}

// ── pure: validation ────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_NAME_LEN = 64;

/** A job name is one safe path segment (it becomes a filename). Pure. */
export function isValidJobName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LEN && NAME_RE.test(name);
}

/** Default poll interval for file/clipboard/command triggers. */
export const DEFAULT_POLL_MS = 2000;
/** Floor so a mistyped interval can't hot-loop the daemon. */
export const MIN_INTERVAL_MS = 500;

/**
 * Every reason a job definition is unusable, as fix-it strings — empty
 * means valid. Checked at `job add` AND at daemon load, so a hand-edited
 * file fails loudly instead of ticking wrong. Pure.
 */
export function validateJob(job: Job): string[] {
  const errors: string[] = [];
  if (!isValidJobName(job.name)) errors.push(`Invalid job name "${job.name}". Use letters, digits, dashes, and underscores.`);
  const t = job.trigger;
  if (!t || typeof t !== 'object') {
    errors.push('Job has no trigger.');
  } else if (t.kind === 'file') {
    if (!t.glob?.trim()) errors.push('File trigger needs a non-empty glob.');
  } else if (t.kind === 'clipboard') {
    if (!t.pattern?.trim()) errors.push('Clipboard trigger needs a non-empty pattern.');
    else {
      try { new RegExp(t.pattern); } catch { errors.push(`Clipboard pattern is not a valid regex: ${t.pattern}`); }
    }
  } else if (t.kind === 'command') {
    if (!t.command?.trim()) errors.push('Command trigger needs a non-empty command.');
  } else if (t.kind === 'schedule') {
    if (parseAt(t.at ?? '') === null) errors.push(`Schedule trigger needs --at HH:MM (24h), got "${t.at}".`);
  } else if (t.kind === 'interval') {
    if (!job.intervalMs || job.intervalMs <= 0) errors.push('Interval trigger needs a positive interval.');
  } else {
    errors.push(`Unknown trigger kind "${(t as { kind?: string }).kind}".`);
  }
  if (job.intervalMs !== undefined && (!Number.isFinite(job.intervalMs) || job.intervalMs < MIN_INTERVAL_MS)) {
    errors.push(`Interval must be at least ${MIN_INTERVAL_MS}ms, got ${job.intervalMs}.`);
  }
  const a = job.action;
  if (!a || typeof a !== 'object' || (a.kind !== 'task' && a.kind !== 'macro')) {
    errors.push('Job needs exactly one action: a task or a macro.');
  } else if (a.kind === 'task' && !a.task?.trim()) {
    errors.push('Task action needs a non-empty prompt.');
  } else if (a.kind === 'macro' && !a.name?.trim()) {
    errors.push('Macro action needs a macro name.');
  }
  if ((job.heal || job.commit || job.warden) && a?.kind !== 'macro') {
    errors.push('--heal/--commit/--warden repair macro replays — they need a --play action.');
  }
  if (job.commit && !job.heal) errors.push('--commit only works with --heal.');
  if (job.warden && !job.heal) errors.push('--warden on a job gates the healer — pass --heal too.');
  return errors;
}

// ── pure: turning a fire into a child process ───────────────────────

/** Substitute `{{key}}` trigger context into a task prompt. Pure. */
export function substituteContext(text: string, context: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(context)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

/**
 * The argv (after `node cli.js`) that executes a job's action. The daemon
 * runs every action as a CHILD process — `run()` exits the process on
 * config errors, and one wedged action must never take down the whole
 * daemon. Trigger context reaches a macro as `--set` params and a task by
 * substitution. Pure.
 */
export function buildActionArgs(job: Job, context: Record<string, string>): string[] {
  if (job.action.kind === 'macro') {
    const args = ['play', job.action.name];
    for (const [k, v] of Object.entries(context)) args.push('--set', `${k}=${v}`);
    if (job.heal) args.push('--heal');
    if (job.commit) args.push('--commit');
    if (job.warden) args.push('--warden');
    return args;
  }
  return ['run', '--once', substituteContext(job.action.task, context)];
}

/** One-line summary for `job list` / daemon startup. Pure. */
export function describeJob(job: Job): string {
  const action = job.action.kind === 'macro'
    ? `play ${job.action.name}${job.heal ? ' (heal' + (job.commit ? '+commit' : '') + (job.warden ? '+warden' : '') + ')' : ''}`
    : `run: ${job.action.task.length > 50 ? job.action.task.slice(0, 50) + '…' : job.action.task}`;
  const every = job.trigger.kind === 'schedule' ? '' : ` every ${job.intervalMs ?? DEFAULT_POLL_MS}ms`;
  return `${describeTrigger(job.trigger)}${every} → ${action}`;
}

// ── fs: paths + CRUD ────────────────────────────────────────────────

// Paths are computed per call (not at module load) so tests can redirect
// HOME/USERPROFILE — same pattern as the audit log.
export function getJobsDir(): string {
  return join(homedir(), '.hands', 'jobs');
}

export function jobPath(name: string): string {
  return join(getJobsDir(), `${name}.json`);
}

function statePath(): string {
  return join(getJobsDir(), '.state.json');
}

export function daemonLogPath(): string {
  return join(homedir(), '.hands', 'daemon.jsonl');
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { await chmod(dir, 0o700); } catch { /* best-effort perms repair */ }
  }
}

export async function saveJob(job: Job, opts: { force?: boolean } = {}): Promise<string> {
  const errors = validateJob(job);
  if (errors.length) throw new Error(errors.join(' '));
  const path = jobPath(job.name);
  if (!opts.force) {
    let exists = true;
    try { await stat(path); } catch { exists = false; }
    if (exists) throw new Error(`Job "${job.name}" already exists. Remove it first (hands job rm ${job.name}) or pick another name.`);
  }
  await ensureDir(getJobsDir());
  await writeFile(path, JSON.stringify(job, null, 2), { mode: 0o600 });
  return path;
}

export async function loadJob(name: string): Promise<Job> {
  if (!isValidJobName(name)) throw new Error(`Invalid job name "${name}".`);
  let raw: string;
  try {
    raw = await readFile(jobPath(name), 'utf-8');
  } catch {
    const available = (await listJobNames()).join(', ');
    throw new Error(`Job "${name}" not found.${available ? ` Available: ${available}.` : ' No jobs defined yet — see hands job add.'}`);
  }
  const parsed = JSON.parse(raw) as Job;
  return { ...parsed, name };
}

export async function deleteJob(name: string): Promise<void> {
  if (!isValidJobName(name)) throw new Error(`Invalid job name "${name}".`);
  try {
    await unlink(jobPath(name));
  } catch {
    throw new Error(`Job "${name}" not found.`);
  }
}

export async function listJobNames(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(getJobsDir());
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => f.slice(0, -5))
    .filter(isValidJobName)
    .sort((a, b) => a.localeCompare(b));
}

export async function listJobs(): Promise<Job[]> {
  const out: Job[] = [];
  for (const name of await listJobNames()) {
    try {
      out.push(await loadJob(name));
    } catch {
      // skip malformed; the daemon logs these at load
    }
  }
  return out;
}

export async function setJobEnabled(name: string, enabled: boolean): Promise<Job> {
  const job = await loadJob(name);
  const updated = { ...job, enabled };
  await saveJob(updated, { force: true });
  return updated;
}

// ── fs: daemon-owned per-job state ──────────────────────────────────

export async function readJobStates(): Promise<Record<string, JobState>> {
  try {
    return JSON.parse(await readFile(statePath(), 'utf-8')) as Record<string, JobState>;
  } catch {
    return {};
  }
}

/** Write the whole state map atomically (tmp + rename) — a killed daemon leaves the last consistent snapshot, never a torn file. */
export async function writeJobStates(states: Record<string, JobState>): Promise<void> {
  await ensureDir(getJobsDir());
  const tmp = statePath() + '.tmp';
  await writeFile(tmp, JSON.stringify(states, null, 2), { mode: 0o600 });
  await rename(tmp, statePath());
}

// ── fs: the daemon event log ────────────────────────────────────────

export interface DaemonEvent {
  ts?: number | undefined;
  job?: string | undefined;
  event: 'start' | 'stop' | 'load' | 'fire' | 'ok' | 'fail' | 'skip' | 'error';
  detail?: string | undefined;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Append one event; rotate to .1 at 5MB (one generation, like the audit log). Never throws — logging must not kill the daemon. */
export async function appendDaemonLog(event: DaemonEvent): Promise<void> {
  try {
    await ensureDir(join(homedir(), '.hands'));
    const path = daemonLogPath();
    try {
      const s = await stat(path);
      if (s.size > LOG_MAX_BYTES) await rename(path, path + '.1');
    } catch { /* no log yet */ }
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    await writeFile(path, line, { flag: 'a', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[hands.daemon] log append failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Read events, newest last, optionally filtered to one job and/or the last N. */
export async function readDaemonLog(filter: { job?: string; last?: number } = {}): Promise<DaemonEvent[]> {
  let raw: string;
  try {
    raw = await readFile(daemonLogPath(), 'utf-8');
  } catch {
    return [];
  }
  let events: DaemonEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as DaemonEvent);
    } catch { /* skip torn line */ }
  }
  if (filter.job) events = events.filter((e) => e.job === filter.job);
  if (filter.last && filter.last > 0) events = events.slice(-filter.last);
  return events;
}
