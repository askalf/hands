// Daemon process control — the pidfile lock, start/stop/status, and the
// OS-persistence installers. The loop itself lives in daemon-run.ts; this
// module is everything about managing it as a background process.
//
// Windows install uses the wscript-launcher pattern (a tiny .vbs that
// starts node hidden) + a logon scheduled task: no console window, no
// unsigned binaries (node and wscript are both signed — Smart App Control
// stays happy). macOS/Linux installs WRITE the launchd plist / systemd
// user unit and print the one activation command, because activating a
// login service is the operator's call (and can prompt for credentials).

import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDaemonLog, readJobStates, listJobs, describeJob } from './jobs.js';
import * as output from './util/output.js';

const TASK_NAME = 'hands-daemon';

export function pidFilePath(): string {
  return join(homedir(), '.hands', 'daemon.pid');
}

function cliPath(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

export async function readPid(): Promise<number | null> {
  try {
    const n = parseInt((await readFile(pidFilePath(), 'utf-8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Liveness via signal 0 — works on Windows too (OpenProcess under the hood). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Take the single-instance lock or throw. A stale pidfile (dead pid) is reclaimed silently. */
export async function acquirePidLock(): Promise<void> {
  const existing = await readPid();
  if (existing !== null && existing !== process.pid && isPidAlive(existing)) {
    throw new Error(`hands daemon is already running (pid ${existing}). Stop it with: hands daemon stop`);
  }
  await mkdir(join(homedir(), '.hands'), { recursive: true, mode: 0o700 });
  await writeFile(pidFilePath(), String(process.pid), { mode: 0o600 });
}

export async function releasePidLock(): Promise<void> {
  const pid = await readPid();
  if (pid === process.pid) {
    try { await unlink(pidFilePath()); } catch { /* already gone */ }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn `hands daemon run` detached and confirm it came up. */
export async function startDaemon(): Promise<void> {
  const existing = await readPid();
  if (existing !== null && isPidAlive(existing)) {
    output.error(`hands daemon is already running (pid ${existing}).`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [cliPath(), 'daemon', 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  // The child writes its pidfile on startup; give it a moment and verify.
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const pid = await readPid();
    if (pid !== null && isPidAlive(pid)) {
      output.success(`hands daemon started (pid ${pid}). Watch it: hands daemon status · hands job list`);
      return;
    }
  }
  output.error('daemon did not come up within 5s — check ~/.hands/daemon.jsonl for the reason.');
  process.exitCode = 1;
}

export async function stopDaemon(): Promise<void> {
  const pid = await readPid();
  if (pid === null || !isPidAlive(pid)) {
    output.info('hands daemon is not running.');
    if (pid !== null) { try { await unlink(pidFilePath()); } catch { /* stale file */ } }
    return;
  }
  // SIGTERM lands as graceful shutdown where signals exist; on Windows it
  // terminates the process — which is safe, because job state is written
  // after every fire (see daemon-run.ts).
  process.kill(pid);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!isPidAlive(pid)) {
      try { await unlink(pidFilePath()); } catch { /* released by daemon */ }
      output.success(`hands daemon stopped (pid ${pid}).`);
      return;
    }
  }
  output.error(`daemon (pid ${pid}) did not exit within 5s.`);
  process.exitCode = 1;
}

export async function daemonStatus(): Promise<void> {
  const pid = await readPid();
  const alive = pid !== null && isPidAlive(pid);
  output.info(alive ? `hands daemon: RUNNING (pid ${pid})` : 'hands daemon: not running');
  const jobs = await listJobs();
  const states = await readJobStates();
  if (jobs.length === 0) {
    output.info('no jobs defined — add one: hands job add <name> --every 5m --play <macro>');
  }
  for (const job of jobs) {
    const s = states[job.name];
    const stats = s?.fires
      ? `${s.fires} fire${s.fires === 1 ? '' : 's'}, last ${s.lastOk ? 'ok' : 'FAILED'} ${s.lastFireTs ? new Date(s.lastFireTs).toLocaleString() : ''}`
      : 'never fired';
    output.info(`  ${job.enabled ? '●' : '○'} ${job.name} — ${describeJob(job)}  (${stats})`);
  }
  const recent = await readDaemonLog({ last: 5 });
  if (recent.length) {
    output.info('recent events:');
    for (const e of recent) {
      output.info(`  ${e.ts ? new Date(e.ts).toLocaleString() : ''} ${e.job ?? '-'} ${e.event}${e.detail ? `: ${e.detail.slice(0, 100)}` : ''}`);
    }
  }
}

// ── OS persistence ──────────────────────────────────────────────────

function vbsLauncherPath(): string {
  return join(homedir(), '.hands', 'daemon-launcher.vbs');
}

/** Doubled-quote VBS string literal. */
function vbsQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function execFileP(file: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

/**
 * Register the daemon to start at logon.
 * - Windows: a hidden wscript launcher + `schtasks /Create … /SC ONLOGON`.
 * - macOS / Linux: writes the launchd plist / systemd user unit and prints
 *   the activation command.
 */
export async function installDaemon(opts: { print?: boolean } = {}): Promise<void> {
  const node = process.execPath;
  const cli = cliPath();
  if (process.platform === 'win32') {
    const vbs = `CreateObject("WScript.Shell").Run ${vbsQuote(`"${node}" "${cli}" daemon run`)}, 0, False\n`;
    if (opts.print) {
      output.info(`would write ${vbsLauncherPath()}:`);
      console.log(vbs);
      output.info(`would run: schtasks /Create /TN ${TASK_NAME} /SC ONLOGON /TR "wscript.exe \\"${vbsLauncherPath()}\\"" /F`);
      return;
    }
    await mkdir(join(homedir(), '.hands'), { recursive: true, mode: 0o700 });
    await writeFile(vbsLauncherPath(), vbs, { mode: 0o600 });
    const res = await execFileP('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', `wscript.exe "${vbsLauncherPath()}"`, '/F']);
    if (res.code !== 0) {
      output.error(`schtasks failed (${res.code}): ${res.out}`);
      process.exitCode = 1;
      return;
    }
    output.success(`installed: scheduled task "${TASK_NAME}" starts the daemon (hidden) at logon.`);
    output.info('start it now without relogging: hands daemon start · remove with: hands daemon uninstall');
    return;
  }
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'org.askalf.hands-daemon.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.askalf.hands-daemon</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>daemon</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`;
    if (opts.print) {
      output.info(`would write ${plistPath} and print: launchctl load -w ${plistPath}`);
      console.log(plist);
      return;
    }
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plistPath, plist, { mode: 0o644 });
    output.success(`wrote ${plistPath}`);
    output.info(`activate it: launchctl load -w ${plistPath}`);
    return;
  }
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, 'hands-daemon.service');
  const unit = `[Unit]
Description=hands daemon — local automation layer

[Service]
ExecStart=${node} ${cli} daemon run
Restart=on-failure

[Install]
WantedBy=default.target
`;
  if (opts.print) {
    output.info(`would write ${unitPath} and print: systemctl --user enable --now hands-daemon`);
    console.log(unit);
    return;
  }
  await mkdir(unitDir, { recursive: true });
  await writeFile(unitPath, unit, { mode: 0o644 });
  output.success(`wrote ${unitPath}`);
  output.info('activate it: systemctl --user enable --now hands-daemon');
}

export async function uninstallDaemon(): Promise<void> {
  if (process.platform === 'win32') {
    const res = await execFileP('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    if (res.code !== 0) {
      output.info(`scheduled task "${TASK_NAME}" was not installed (${res.out || 'schtasks returned ' + res.code}).`);
    } else {
      output.success(`removed scheduled task "${TASK_NAME}".`);
    }
    try { await unlink(vbsLauncherPath()); } catch { /* not written */ }
    return;
  }
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'org.askalf.hands-daemon.plist');
    output.info(`unload and remove it: launchctl unload -w ${plistPath} && rm ${plistPath}`);
    return;
  }
  output.info('disable and remove it: systemctl --user disable --now hands-daemon && rm ~/.config/systemd/user/hands-daemon.service');
}
