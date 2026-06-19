// Watch orchestrator — the real probes + the poll/fire loop behind
// `hands watch`. Keeps the trigger decision logic in watch.ts (pure,
// tested); this file owns the I/O (fs, clipboard, child processes) and the
// long-running loop. On each fire it runs the action: an LLM task (with the
// trigger context substituted into the prompt) or a free recorded macro.

import { spawn, execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import {
  WatchEngine, describeTrigger,
  type WatchTrigger, type WatchProbes, type WatchAction,
} from './watch.js';
import * as output from './util/output.js';

export interface RunWatchOptions {
  /** Poll interval in ms. */
  intervalMs: number;
  /** Stop after this many fires (0/undefined = unbounded). */
  max?: number | undefined;
  /** Fire at most once, then exit. */
  once?: boolean | undefined;
  /** Skip the dario auto-detect probe for task actions. */
  noDario?: boolean | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Convert a basename glob (`*.pdf`, `report-?.txt`) to an anchored regex. */
function globToRegex(g: string): RegExp {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

/** Expand `~`, split dir/pattern, and list matching files as absolute paths. */
function globFiles(glob: string): string[] {
  const expanded = glob.replace(/^~(?=[\\/]|$)/, homedir());
  const dir = dirname(expanded) || '.';
  const re = globToRegex(basename(expanded));
  try {
    return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function readClipboard(): string {
  try {
    if (process.platform === 'win32') return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf-8', timeout: 5000 });
    if (process.platform === 'darwin') return execSync('pbpaste', { encoding: 'utf-8', timeout: 5000 });
    try {
      return execSync('xclip -selection clipboard -o', { encoding: 'utf-8', timeout: 5000 });
    } catch {
      return execSync('wl-paste', { encoding: 'utf-8', timeout: 5000 });
    }
  } catch {
    return '';
  }
}

function realProbes(): WatchProbes {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : 'bash';
  const flag = isWindows ? '/c' : '-c';
  return {
    listFiles: async (glob: string) => globFiles(glob),
    readClipboard: async () => readClipboard(),
    runCommand: (command: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(shell, [flag, command], { stdio: 'ignore' });
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      }),
  };
}

function substitute(text: string, context: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(context)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

async function runAction(action: WatchAction, context: Record<string, string>, noDario: boolean | undefined): Promise<void> {
  if (action.kind === 'macro') {
    const { playMacro } = await import('./macro-run.js');
    await playMacro(action.name, { params: context });
    return;
  }
  const { run } = await import('./run.js');
  await run(substitute(action.task, context), { once: true, ...(noDario ? { noDario: true } : {}) });
}

/** Poll the trigger and run the action on each fire. Runs until once/max or Ctrl+C. */
export async function runWatch(trigger: WatchTrigger, action: WatchAction, opts: RunWatchOptions): Promise<void> {
  const engine = new WatchEngine(trigger, realProbes());
  const what = action.kind === 'macro' ? `play macro "${action.name}"` : `run: ${action.task.slice(0, 60)}`;
  output.info(`watching for ${describeTrigger(trigger)} every ${opts.intervalMs}ms → ${what}. Ctrl+C to stop.`);

  let fires = 0;
  for (;;) {
    let hit: Awaited<ReturnType<WatchEngine['check']>> = null;
    try {
      hit = await engine.check();
    } catch (err) {
      output.warn(`probe error (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (hit) {
      fires++;
      const tag = hit.context['file'] ?? (hit.context['match'] ? `"${hit.context['match']}"` : '');
      output.success(`▶ trigger fired${tag ? `: ${tag}` : ''} (#${fires})`);
      try {
        await runAction(action, hit.context, opts.noDario);
      } catch (err) {
        output.error(`action failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (opts.once || (opts.max && fires >= opts.max)) {
        output.info(`watch done (${fires} fire${fires === 1 ? '' : 's'}).`);
        return;
      }
    }
    await sleep(opts.intervalMs);
  }
}
