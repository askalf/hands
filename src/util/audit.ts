// Append-only audit log of every tool invocation the agent makes.
//
// Every call into the agent's shell / keyboard / mouse / screenshot tools
// is recorded at `~/.hands/audit.jsonl`. Non-fatal: if the append fails
// (disk full, permission change, etc.) we log to stderr and continue —
// the audit log is diagnostic, not authoritative.
//
// Only SDK mode is covered. Claude Login mode spawns the `claude` child
// process and delegates tool execution there, so those actions are
// outside hands's scope to log.
//
// Rotation is simple: when the live file crosses `MAX_BYTES`, it's moved
// to `audit.jsonl.old` (overwriting any prior archive) and a fresh empty
// file takes its place. Two files total, bounded disk cost.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUDIT_DIR = join(homedir(), '.hands');
const AUDIT_PATH = join(AUDIT_DIR, 'audit.jsonl');
const AUDIT_OLD_PATH = join(AUDIT_DIR, 'audit.jsonl.old');
const MAX_BYTES = 10 * 1024 * 1024;  // 10 MB cap per live file.

export interface AuditEntry {
  /** Unix ms. Populated by appendAudit if omitted. */
  ts?: number | undefined;
  /** Which tool was invoked (e.g. `computer`, `bash`, `text_editor`). */
  tool: string;
  /** Sub-action within the tool (e.g. `screenshot`, `left_click`, `key`). */
  action?: string | undefined;
  /** Summarized args — keep short; we're not storing full command bodies. */
  args?: Record<string, unknown> | undefined;
  /** Wall-clock ms the tool call took. */
  durationMs?: number | undefined;
  /** Whether the tool reported success. */
  ok: boolean;
  /** Short error excerpt if ok=false. */
  error?: string | undefined;
  /** True when this call was suppressed by --dry-run. */
  dryRun?: boolean | undefined;
}

/**
 * Append a single entry to the audit log. Non-fatal on any error.
 * Rotates the live file to `.old` if it would exceed MAX_BYTES after
 * this append.
 */
export async function appendAudit(entry: AuditEntry): Promise<void> {
  const full: AuditEntry = { ts: Date.now(), ...entry };
  try {
    await fs.mkdir(AUDIT_DIR, { recursive: true, mode: 0o700 });
    await rotateIfNeeded();
    const line = summarizeForAudit(full) + '\n';
    await fs.appendFile(AUDIT_PATH, line, { mode: 0o600 });
  } catch (err) {
    // Never crash the agent over a logging failure.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[hands.audit] append failed: ${msg}\n`);
  }
}

/**
 * Rotate `audit.jsonl` → `audit.jsonl.old` when the live file exceeds
 * MAX_BYTES. Silent no-op if the file doesn't exist or is small.
 */
export async function rotateIfNeeded(): Promise<'rotated' | 'kept' | 'absent'> {
  try {
    const stat = await fs.stat(AUDIT_PATH);
    if (stat.size < MAX_BYTES) return 'kept';
    await fs.rename(AUDIT_PATH, AUDIT_OLD_PATH);
    return 'rotated';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/**
 * Read the most recent N audit entries (from the live file only — old
 * archive is not scanned). Returns newest-last. Best-effort parse:
 * malformed lines are skipped rather than failing the whole read.
 */
export async function readAuditHistory(limit: number = 100): Promise<AuditEntry[]> {
  try {
    const raw = await fs.readFile(AUDIT_PATH, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    const out: AuditEntry[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed line.
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Turn an audit entry into the single-line JSON we store. Exported
 * for testability — the only reason this is separate from the
 * JSON.stringify call is so tests can pin the line shape without
 * needing a temp filesystem.
 */
export function summarizeForAudit(entry: AuditEntry): string {
  return JSON.stringify(entry);
}

/**
 * Absolute paths to the audit files. Exported so tests and docs can
 * reference them without duplicating the path construction.
 */
export function getAuditPaths(): { live: string; archived: string; dir: string; maxBytes: number } {
  return {
    live: AUDIT_PATH,
    archived: AUDIT_OLD_PATH,
    dir: AUDIT_DIR,
    maxBytes: MAX_BYTES,
  };
}
