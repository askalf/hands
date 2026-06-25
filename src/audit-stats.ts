// Audit stats — an aggregate view of ~/.hands/audit.jsonl.
//
// The audit log records every tool call the agent makes (tool, action,
// ok, durationMs, error, mode). Until now the only readers were
// per-entry: `audit list` scrolls, `audit show` zooms one, `audit
// replay` re-fires one. None of them answer the question an operator
// actually asks of an audit trail — "what has my agent been doing on
// this machine, and how reliably?" `hands audit stats` rolls the log up:
// success rate, a per-tool breakdown with average latency, and the most
// recent failures, over the whole log or a `--since` window.
//
// This module is pure: aggregation (`computeAuditStats`) and rendering
// (`renderStatsText` / `renderStatsJson`) take entries / stats in and
// return values out — no filesystem, no clock — so every branch is unit-
// tested without a temp log. The CLI reads the log (reusing
// audit-replay's reader + the same mode/tool filter `audit list` uses)
// and hands the entries here.

import type { AuditEntry } from './audit-replay.js';

export interface ToolStat {
  /** Tool name (e.g. `bash`, `computer`, `read_page`). */
  tool: string;
  /** Total calls to this tool. */
  count: number;
  /** Calls that did not complete ok. */
  failed: number;
  /** Sum of durationMs across the calls that carried one. */
  totalDurationMs: number;
  /** How many calls carried a durationMs — the divisor for a correct average. */
  timed: number;
}

export interface AuditFailure {
  ts?: number | undefined;
  tool: string;
  action?: string | undefined;
  error: string;
}

export interface AuditStats {
  total: number;
  ok: number;
  failed: number;
  /** Calls suppressed by --dry-run. */
  dryRun: number;
  /** Run-mode split. Entries with no mode count as sdk (matches `audit list --mode sdk`). */
  modes: { sdk: number; cli: number };
  /** Earliest / latest entry timestamp seen (absent when no entry carried a ts). */
  firstTs?: number | undefined;
  lastTs?: number | undefined;
  /** Per-tool rollup, sorted by call count (desc), then name (asc). */
  byTool: ToolStat[];
  /** The most recent failures, oldest-first, capped at MAX_RECENT_FAILURES. */
  recentFailures: AuditFailure[];
}

const MAX_RECENT_FAILURES = 5;

// ── pure: aggregation ───────────────────────────────────────────────

/**
 * Roll a list of audit entries up into summary stats. Entries are
 * expected oldest-first (as `readAuditEntries` returns them), which is
 * what makes the `recentFailures` tail the *most recent* ones. Pure.
 */
export function computeAuditStats(entries: AuditEntry[]): AuditStats {
  const byToolMap = new Map<string, ToolStat>();
  const failures: AuditFailure[] = [];
  let ok = 0;
  let failed = 0;
  let dryRun = 0;
  let sdk = 0;
  let cli = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const e of entries) {
    if (e.ok) ok++;
    else failed++;
    if (e.dryRun) dryRun++;
    // Absent mode counts as sdk — same rule audit-replay's filter uses.
    if (e.mode === 'cli') cli++;
    else sdk++;

    if (typeof e.ts === 'number') {
      if (firstTs === undefined || e.ts < firstTs) firstTs = e.ts;
      if (lastTs === undefined || e.ts > lastTs) lastTs = e.ts;
    }

    let stat = byToolMap.get(e.tool);
    if (!stat) {
      stat = { tool: e.tool, count: 0, failed: 0, totalDurationMs: 0, timed: 0 };
      byToolMap.set(e.tool, stat);
    }
    stat.count++;
    if (!e.ok) stat.failed++;
    if (typeof e.durationMs === 'number') {
      stat.totalDurationMs += e.durationMs;
      stat.timed++;
    }

    if (!e.ok) {
      const failure: AuditFailure = { tool: e.tool, error: e.error ?? 'unknown error' };
      if (e.ts !== undefined) failure.ts = e.ts;
      if (e.action !== undefined) failure.action = e.action;
      failures.push(failure);
    }
  }

  const byTool = [...byToolMap.values()].sort(
    (a, b) => b.count - a.count || a.tool.localeCompare(b.tool),
  );

  const stats: AuditStats = {
    total: entries.length,
    ok,
    failed,
    dryRun,
    modes: { sdk, cli },
    byTool,
    recentFailures: failures.slice(-MAX_RECENT_FAILURES),
  };
  if (firstTs !== undefined) stats.firstTs = firstTs;
  if (lastTs !== undefined) stats.lastTs = lastTs;
  return stats;
}

// ── pure: derived metrics ───────────────────────────────────────────

/** Whole-percent success rate (ok / total). 0 when there are no entries. Pure. */
export function successRate(stats: AuditStats): number {
  return stats.total === 0 ? 0 : Math.round((stats.ok / stats.total) * 100);
}

/** Average call duration for a tool, or null when none of its calls were timed. Pure. */
export function avgDurationMs(stat: ToolStat): number | null {
  return stat.timed > 0 ? Math.round(stat.totalDurationMs / stat.timed) : null;
}

// ── pure: parsing + formatting ──────────────────────────────────────

/**
 * Parse a `--since` window ("90s", "30m", "24h", "7d") to milliseconds.
 * Days extend watch.ts's parseInterval (which stops at hours) for the
 * "last week of activity" question an audit window invites; a unit is
 * required (no bare ms) so `--since 5` can't silently mean 5ms. Pure —
 * invalid input → null.
 */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2];
  const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return n * mult;
}

/** Format a per-call latency: `142ms`, `1.2s`, `1m 5s`. Pure. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

/** Format an elapsed span coarsely: `45s`, `5m`, `2h 30m`, `2d 15h`. Pure. */
export function formatSpan(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const m = min % 60;
    return m > 0 ? `${hr}h ${m}m` : `${hr}h`;
  }
  const days = Math.floor(hr / 24);
  const h = hr % 24;
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

/** `YYYY-MM-DD HH:MM` from a unix-ms timestamp. Pure. */
function tsLabel(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

// ── pure: rendering ─────────────────────────────────────────────────

/** Render stats as a human-readable text block (mirrors `hands doctor`'s layout). Pure. */
export function renderStatsText(stats: AuditStats): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  hands — Audit stats');
  lines.push('  ───────────────────');
  lines.push('');

  if (stats.total === 0) {
    lines.push('  No audit entries yet. Run `hands run "..."` to record some.');
    lines.push('');
    return lines.join('\n');
  }

  if (stats.firstTs !== undefined && stats.lastTs !== undefined) {
    const span = stats.lastTs > stats.firstTs ? ` (${formatSpan(stats.lastTs - stats.firstTs)})` : '';
    lines.push(`  span      ${tsLabel(stats.firstTs)} → ${tsLabel(stats.lastTs)}${span}`);
  }
  lines.push(`  entries   ${stats.total}  (${stats.ok} ok · ${stats.failed} failed · ${successRate(stats)}% success)`);
  lines.push(`  modes     ${stats.modes.sdk} sdk · ${stats.modes.cli} cli`);
  if (stats.dryRun > 0) lines.push(`  dry-run   ${stats.dryRun}`);
  lines.push('');

  lines.push('  by tool');
  const nameW = Math.max(4, ...stats.byTool.map((t) => t.tool.length));
  for (const t of stats.byTool) {
    const avg = avgDurationMs(t);
    const avgStr = avg === null ? '' : `   avg ${formatMs(avg)}`;
    const fails = t.failed > 0 ? `  ✗ ${t.failed}` : '';
    lines.push(`    ${t.tool.padEnd(nameW)}  ${String(t.count).padStart(4)}  ✓ ${t.count - t.failed}${fails}${avgStr}`);
  }

  if (stats.recentFailures.length > 0) {
    lines.push('');
    lines.push('  recent failures');
    for (const f of stats.recentFailures) {
      const action = f.action ? `:${f.action}` : '';
      const err = f.error.length > 60 ? f.error.slice(0, 60) + '…' : f.error;
      lines.push(`    ✗ ${f.tool}${action}  ${err}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Render stats as JSON, with the derived success rate folded in for scripts. Pure. */
export function renderStatsJson(stats: AuditStats): string {
  return JSON.stringify({ ...stats, successRate: successRate(stats) }, null, 2);
}
