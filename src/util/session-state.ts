// Pointer to the most recent Claude Login session, so `hands run
// --continue` can pick a conversation back up across process exits and
// reboots. The conversation itself lives in the claude CLI's own
// session store — hands only records which session id to hand to
// `claude --resume`, and from which working directory (session lookup
// is cwd-scoped on the claude side).
//
// Best-effort like the audit log: a failed save must never crash a
// run. The file is 0600 in the 0700 ~/.hands dir — task text can be
// sensitive.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.hands');
const STATE_PATH = join(STATE_DIR, 'last-session.json');

export interface LastSession {
  /** Claude CLI session id, as surfaced by the stream-json feed. */
  sessionId: string;
  /** Working directory the session was started from — claude scopes session lookup to it. */
  cwd: string;
  /** The last prompt sent, for the "resuming: ..." line. */
  task: string;
  /** Unix ms of the last completed task in the session. */
  ts: number;
}

export async function saveLastSession(state: LastSession): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[hands.session] save failed: ${msg}\n`);
  }
}

/** Null when there's nothing to resume (no file, malformed, missing fields). */
export async function loadLastSession(): Promise<LastSession | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LastSession>;
    if (
      typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 &&
      typeof parsed.cwd === 'string' && parsed.cwd.length > 0 &&
      typeof parsed.task === 'string' &&
      typeof parsed.ts === 'number'
    ) {
      return { sessionId: parsed.sessionId, cwd: parsed.cwd, task: parsed.task, ts: parsed.ts };
    }
    return null;
  } catch {
    return null;
  }
}

export function getLastSessionPath(): string {
  return STATE_PATH;
}
