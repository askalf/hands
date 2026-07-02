// Watchers — reactive computer use. `hands watch` fires a task (or a free
// macro) when something happens: a file appears, the clipboard matches a
// pattern, a process/command condition flips, or a timer ticks. Turns hands
// from request→response into a local automation daemon.
//
// This module is the pure trigger engine: the decision logic ("did the
// trigger fire, and with what context?") with its I/O probes injected, so
// every edge (new-file detection, clipboard change+match, command rising
// edge, interval) is unit-tested without a real filesystem, clipboard, or
// clock. The orchestrator + real probes live in watch-run.ts.

export type WatchTrigger =
  | { kind: 'file'; glob: string }
  | { kind: 'clipboard'; pattern: string }
  | { kind: 'command'; command: string }
  | { kind: 'interval' }
  /** Daily wall-clock schedule, `at` = "HH:MM" (24h, local time). */
  | { kind: 'schedule'; at: string };

/** What to run when a trigger fires: an LLM task, or a free recorded macro. */
export type WatchAction = { kind: 'task'; task: string } | { kind: 'macro'; name: string };

/** Injected I/O so the engine is testable with fakes. */
export interface WatchProbes {
  listFiles(glob: string): Promise<string[]>;
  readClipboard(): Promise<string>;
  /** Resolves to the command's exit code. */
  runCommand(command: string): Promise<number>;
  /** Wall clock, for schedule triggers. Optional so existing probe sets stay valid; defaults to the real clock. */
  now?(): Date;
}

/** Parse a schedule's "HH:MM" (24h) into minutes-since-midnight, or null. Pure. */
export function parseAt(s: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

export interface WatchHit {
  /** Context surfaced to the action — e.g. { file } or { clip, match }. */
  context: Record<string, string>;
}

// ── pure helpers ────────────────────────────────────────────────────

/** Parse a human interval ("30s", "5m", "2h", or bare ms) to milliseconds. Pure. */
export function parseInterval(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] ?? 'ms';
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  return n * mult;
}

/** Items present in `after` but not `before`. Pure. */
export function newItems(before: Iterable<string>, after: Iterable<string>): string[] {
  const seen = new Set(before);
  return [...after].filter((x) => !seen.has(x));
}

/** First regex match of `pattern` in `content` (the whole match), or null. Pure — invalid regex → null. */
export function matchRegex(content: string, pattern: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const m = re.exec(content);
  return m ? (m[0] ?? '') : null;
}

/** One-line human description of a trigger, for the "watching…" banner. Pure. */
export function describeTrigger(t: WatchTrigger): string {
  switch (t.kind) {
    case 'file': return `new file matching ${t.glob}`;
    case 'clipboard': return `clipboard matching /${t.pattern}/`;
    case 'command': return `command exits 0: ${t.command}`;
    case 'interval': return 'every interval';
    case 'schedule': return `daily at ${t.at}`;
  }
}

// ── the engine ──────────────────────────────────────────────────────

/**
 * Evaluates a trigger one probe at a time, carrying just enough state to
 * fire on *changes* — a new file (not pre-existing ones), changed-and-
 * matching clipboard, the rising edge of a command's success — rather than
 * re-firing every tick. `interval` fires every tick by design.
 */
export class WatchEngine {
  private readonly trigger: WatchTrigger;
  private readonly probes: WatchProbes;
  private seenFiles: Set<string> | null = null;
  private lastClip: string | null = null;
  private lastCommandOk = false;
  private lastScheduleDay: string | null = null;

  constructor(trigger: WatchTrigger, probes: WatchProbes) {
    this.trigger = trigger;
    this.probes = probes;
  }

  /** Run one probe cycle. Returns a hit when the trigger newly fires, else null. */
  async check(): Promise<WatchHit | null> {
    const t = this.trigger;
    if (t.kind === 'interval') {
      return { context: {} };
    }
    if (t.kind === 'schedule') {
      // Fire once per local day when the clock is at/past HH:MM. Cron
      // semantics for downtime: if the engine's FIRST look at a day is
      // already past the mark, that day is treated as missed, not fired —
      // a daemon started at 14:00 must not immediately run the 09:00 jobs.
      const target = parseAt(t.at);
      if (target === null) return null; // validated upstream; fail quiet, not loud, in the loop
      const now = (this.probes.now ?? (() => new Date()))();
      const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      const past = now.getHours() * 60 + now.getMinutes() >= target;
      if (this.lastScheduleDay === null) {
        this.lastScheduleDay = past ? day : 'baseline';
        return null;
      }
      if (past && this.lastScheduleDay !== day) {
        this.lastScheduleDay = day;
        return { context: {} };
      }
      return null;
    }
    if (t.kind === 'file') {
      const files = await this.probes.listFiles(t.glob);
      if (this.seenFiles === null) {
        // First tick is a baseline — pre-existing files don't fire the watch.
        this.seenFiles = new Set(files);
        return null;
      }
      const fresh = newItems(this.seenFiles, files);
      fresh.forEach((f) => this.seenFiles!.add(f));
      return fresh.length > 0 ? { context: { file: fresh[0]! } } : null;
    }
    if (t.kind === 'clipboard') {
      const clip = await this.probes.readClipboard();
      if (clip === this.lastClip) return null; // only react to a change
      this.lastClip = clip;
      const match = matchRegex(clip, t.pattern);
      return match !== null ? { context: { clip, match } } : null;
    }
    // command: fire on the rising edge (newly exits 0), not while it keeps passing.
    const code = await this.probes.runCommand(t.command);
    const ok = code === 0;
    const newlyOk = ok && !this.lastCommandOk;
    this.lastCommandOk = ok;
    return newlyOk ? { context: {} } : null;
  }
}
