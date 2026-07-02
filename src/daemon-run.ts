// The hands daemon — one background process that owns every job: it polls
// their triggers, fires their actions, heals their macros, and writes the
// event log the CLI reads back. `hands watch` made hands reactive for one
// terminal; the daemon makes it the machine's automation layer.
//
// Design decisions that matter:
// - ACTIONS RUN AS CHILD PROCESSES (`node cli.js play …` / `run --once …`).
//   run() exits the process on config errors, actions can wedge, and a
//   crash in one automation must never take down the fleet. The child's
//   exit code is the outcome; its output tail lands in the log.
// - GLOBAL CONCURRENCY IS 1. Computer-use actions share one mouse, one
//   keyboard, one screen — two agents interleaving clicks is corruption,
//   not parallelism. Fires queue FIFO; a job already queued or running
//   skips re-firing (logged as 'skip').
// - JOBS HOT-RELOAD. The daemon rescans ~/.hands/jobs every few seconds;
//   `hands job add/rm/enable` just work without a restart. Engine state
//   (file baselines, clipboard history) survives for unchanged jobs.
// - STATE IS EVENT-DURABLE. Job state is written after every fire, so a
//   hard kill (Windows taskkill has no graceful signal) loses nothing.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WatchEngine } from './watch.js';
import { realProbes } from './watch-run.js';
import {
  listJobs, validateJob, describeJob, buildActionArgs,
  readJobStates, writeJobStates, appendDaemonLog,
  DEFAULT_POLL_MS, type Job, type JobState,
} from './jobs.js';
import { acquirePidLock, releasePidLock } from './daemon-ctl.js';
import * as output from './util/output.js';

const TICK_MS = 250;
const RELOAD_EVERY_MS = 5000;
const OUTPUT_TAIL_CHARS = 2000;
/** An LLM task can legitimately run for many minutes; a day-stuck one cannot. */
const DEFAULT_ACTION_TIMEOUT_MS = 15 * 60 * 1000;

interface RunningJob {
  job: Job;
  /** JSON identity of the definition — a changed file rebuilds the engine. */
  key: string;
  engine: WatchEngine;
  nextCheckAt: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jobKey(job: Job): string {
  return JSON.stringify(job);
}

function actionTimeoutMs(): number {
  const raw = process.env['HANDS_JOB_TIMEOUT_MS'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ACTION_TIMEOUT_MS;
}

/**
 * Execute one action as a child CLI process. Returns ok + a trailing slice
 * of its combined output for the log. Never throws.
 */
export async function runJobAction(job: Job, context: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args = buildActionArgs(job, context);
  return new Promise((resolve) => {
    let tail = '';
    const push = (chunk: unknown): void => {
      tail = (tail + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
    };
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HANDS_QUIET: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      push(`\n[daemon] action exceeded ${actionTimeoutMs()}ms — killed.`);
      child.kill();
    }, actionTimeoutMs());
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `spawn failed: ${err.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, detail: tail.trim() });
    });
  });
}

/**
 * Rescan the jobs dir and reconcile the running set: add new enabled jobs,
 * drop removed/disabled ones, rebuild engines whose definition changed —
 * and ONLY those, so trigger baselines survive an unrelated edit.
 */
async function reconcileJobs(running: Map<string, RunningJob>, now: number): Promise<void> {
  const defs = await listJobs();
  const seen = new Set<string>();
  for (const job of defs) {
    if (!job.enabled) continue;
    const errors = validateJob(job);
    if (errors.length) {
      if (!running.has(job.name)) await appendDaemonLog({ job: job.name, event: 'error', detail: `invalid job skipped: ${errors.join(' ')}` });
      continue;
    }
    seen.add(job.name);
    const key = jobKey(job);
    const existing = running.get(job.name);
    if (existing && existing.key === key) continue;
    running.set(job.name, { job, key, engine: new WatchEngine(job.trigger, realProbes()), nextCheckAt: now });
    await appendDaemonLog({ job: job.name, event: 'load', detail: describeJob(job) });
  }
  for (const name of [...running.keys()]) {
    if (!seen.has(name)) {
      running.delete(name);
      await appendDaemonLog({ job: name, event: 'load', detail: 'removed or disabled' });
    }
  }
}

/** The daemon main loop. Runs until SIGINT/SIGTERM (or being killed). */
export async function runDaemon(): Promise<void> {
  await acquirePidLock();
  await appendDaemonLog({ event: 'start', detail: `pid ${process.pid}` });
  output.info(`hands daemon running (pid ${process.pid}) — jobs hot-reload from ~/.hands/jobs. Ctrl+C to stop.`);

  const running = new Map<string, RunningJob>();
  const states = await readJobStates();
  const queue: Array<{ name: string; context: Record<string, string> }> = [];
  const queuedOrActive = new Set<string>();
  let stopping = false;
  let lastReload = 0;

  const shutdown = (): void => {
    stopping = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!stopping) {
    const now = Date.now();

    if (now - lastReload >= RELOAD_EVERY_MS) {
      lastReload = now;
      try {
        await reconcileJobs(running, now);
      } catch (err) {
        await appendDaemonLog({ event: 'error', detail: `job reload failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // Probe every due trigger.
    for (const rj of running.values()) {
      if (stopping) break;
      if (now < rj.nextCheckAt) continue;
      rj.nextCheckAt = now + (rj.job.intervalMs ?? DEFAULT_POLL_MS);
      let hit: Awaited<ReturnType<WatchEngine['check']>> = null;
      try {
        hit = await rj.engine.check();
      } catch (err) {
        await appendDaemonLog({ job: rj.job.name, event: 'error', detail: `probe error: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      if (!hit) continue;
      if (queuedOrActive.has(rj.job.name)) {
        await appendDaemonLog({ job: rj.job.name, event: 'skip', detail: 'previous run still queued or active' });
        continue;
      }
      queuedOrActive.add(rj.job.name);
      queue.push({ name: rj.job.name, context: hit.context });
      await appendDaemonLog({ job: rj.job.name, event: 'fire', detail: Object.keys(hit.context).length ? JSON.stringify(hit.context) : undefined });
    }

    // Drain ONE queued fire per pass — global concurrency 1 (one mouse,
    // one keyboard). Triggers keep polling while an action runs.
    const next = queue.shift();
    if (next) {
      const rj = running.get(next.name);
      if (rj) {
        const result = await runJobAction(rj.job, next.context);
        const state: JobState = states[next.name] ?? { fires: 0 };
        state.fires += 1;
        state.lastFireTs = Date.now();
        state.lastOk = result.ok;
        state.lastDetail = result.detail.slice(-500);
        states[next.name] = state;
        await writeJobStates(states);
        await appendDaemonLog({ job: next.name, event: result.ok ? 'ok' : 'fail', detail: result.detail.slice(-500) });
      }
      queuedOrActive.delete(next.name);
    }

    await sleep(TICK_MS);
  }

  await appendDaemonLog({ event: 'stop', detail: `pid ${process.pid}` });
  await releasePidLock();
  output.info('hands daemon stopped.');
}
