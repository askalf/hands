import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface ClaudeInvocation {
  /** Executable to spawn — an absolute path on Windows, or the bare name as passthrough. */
  command: string;
  /** Args to prepend before the caller's own args (the cli.js path when running through node). */
  prefixArgs: string[];
}

/**
 * Pure resolution core — exported for tests.
 *
 * Given the output lines of `where claude`, pick something
 * `child_process.spawn` can actually launch without a shell:
 *   1. a `claude.exe` anywhere on PATH — spawn it directly;
 *   2. an npm `claude.cmd` shim — bypass it and target what it wraps:
 *      the packaged native binary (current claude-code layout) or
 *      `cli.js` run through our own node (older layout);
 *   3. otherwise fall back to the bare name so the caller's existing
 *      error handling produces the install hint.
 */
export function pickClaudeInvocation(
  whereLines: string[],
  fileExists: (path: string) => boolean,
  nodeExecPath: string,
): ClaudeInvocation {
  const lines = whereLines.map((l) => l.trim()).filter(Boolean);

  const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
  if (exe) {
    return { command: exe, prefixArgs: [] };
  }

  const cmdShim = lines.find((l) => l.toLowerCase().endsWith('.cmd'));
  if (cmdShim) {
    const pkgDir = join(dirname(cmdShim), 'node_modules', '@anthropic-ai', 'claude-code');
    const packagedExe = join(pkgDir, 'bin', 'claude.exe');
    if (fileExists(packagedExe)) {
      return { command: packagedExe, prefixArgs: [] };
    }
    const cliJs = join(pkgDir, 'cli.js');
    if (fileExists(cliJs)) {
      return { command: nodeExecPath, prefixArgs: [cliJs] };
    }
  }

  return { command: 'claude', prefixArgs: [] };
}

let cached: ClaudeInvocation | undefined;

/**
 * Resolve how to launch the `claude` CLI as a child process.
 *
 * On POSIX `spawn('claude', args)` just works. On Windows the npm
 * install is a `claude.cmd` shim: CreateProcess won't resolve the
 * bare name to a `.cmd`, and Node ≥ 20.12.2 refuses to spawn `.cmd`
 * files without a shell (CVE-2024-27980) — so the spawn fails with
 * ENOENT/EINVAL even though `where claude` finds the shim and the
 * CLI works fine from a terminal. Going through a shell instead
 * would hand the prompt text to cmd.exe for re-parsing, so we
 * resolve the real executable and keep spawning shell-free.
 */
export async function resolveClaudeInvocation(): Promise<ClaudeInvocation> {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    cached = { command: 'claude', prefixArgs: [] };
    return cached;
  }

  let lines: string[] = [];
  try {
    const { stdout } = await execFileAsync('where', ['claude']);
    lines = stdout.split(/\r?\n/);
  } catch {
    // Not on PATH — fall through to the bare name.
  }

  cached = pickClaudeInvocation(lines, existsSync, process.execPath);
  return cached;
}
