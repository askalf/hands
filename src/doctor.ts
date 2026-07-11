// `hands doctor` — one command, one aggregated report.
//
// Mirrors dario / deepdive / claude-bridge's doctor philosophy: every
// subsystem hands depends on (Node, platform tools, Claude CLI, config
// dir, voice stack, optional dario endpoint) gets probed; anything
// unhealthy is visible without the user chasing error messages across
// three separate commands. Paste-able into issues.
//
// Non-destructive: config is inspected, not modified. No browser is
// opened. The optional dario probe sends a single GET to a local
// endpoint (default http://localhost:3456) only when ANTHROPIC_BASE_URL
// is set; skipped otherwise.

import { promises as fs } from 'node:fs';
import { homedir, platform as osPlatform, arch as osArch, release as osRelease } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlatform } from './platform/index.js';
import { resolveClaudeInvocation } from './platform/claude-cli.js';
import { isWhisperInstalled, expectedRecorder, type RecorderBackend } from './voice/index.js';
import { loadConfig, getConfigDir } from './util/config.js';
import { commandExists } from './platform/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface CheckResult {
  id: string;
  category: string;
  status: CheckStatus;
  label: string;
  detail: string;
  durationMs?: number;
}

export interface DoctorReport {
  version: string;
  generatedAt: number;
  checks: CheckResult[];
  summary: { total: number; ok: number; warn: number; fail: number; info: number };
}

export interface DoctorOptions {
  skipDario?: boolean;
  skipWhisper?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const now = opts.now ?? Date.now;
  const checks: CheckResult[] = [];

  for (const c of envChecks()) checks.push(c);
  for (const c of await configChecks()) checks.push(c);
  for (const c of await platformChecks()) checks.push(c);
  for (const c of await claudeCliChecks()) checks.push(c);
  if (!opts.skipWhisper) for (const c of await voiceChecks()) checks.push(c);
  if (!opts.skipDario) for (const c of await darioChecks(opts)) checks.push(c);

  const summary = checks.reduce(
    (s, c) => ({ ...s, total: s.total + 1, [c.status]: s[c.status] + 1 }),
    { total: 0, ok: 0, warn: 0, fail: 0, info: 0 },
  );

  return {
    version: await readHandsVersion(),
    generatedAt: now(),
    checks,
    summary,
  };
}

// ─── Categories ────────────────────────────────────────────────────

function envChecks(): CheckResult[] {
  return [
    {
      id: 'env.hands',
      category: 'environment',
      status: 'info',
      label: 'hands',
      detail: '',  // filled by caller via report.version
    },
    {
      id: 'env.node',
      category: 'environment',
      status: nodeMeetsMinimum(process.version) ? 'ok' : 'fail',
      label: 'Node',
      detail: process.version,
    },
    {
      id: 'env.platform',
      category: 'environment',
      status: 'info',
      label: 'Platform',
      detail: `${osPlatform()} ${osArch()} (${osRelease()})`,
    },
  ];
}

async function configChecks(): Promise<CheckResult[]> {
  const dir = getConfigDir();
  const out: CheckResult[] = [];

  let dirExists = false;
  let dirMode = 0;
  try {
    const stat = await fs.stat(dir);
    dirExists = stat.isDirectory();
    dirMode = stat.mode & 0o777;
  } catch {
    // dir not there — hands hasn't been configured yet, that's fine
  }

  if (!dirExists) {
    out.push({
      id: 'config.dir',
      category: 'config',
      status: 'info',
      label: 'config dir',
      detail: `${scrubPath(dir)} — not created yet (hands auth will make it)`,
    });
    return out;
  }

  out.push({
    id: 'config.dir',
    category: 'config',
    status: 'ok',
    label: 'config dir',
    detail: scrubPath(dir),
  });

  // Permission check — ~/.hands/ should be 0700 so secrets in config
  // aren't readable by other users on the same machine.
  if (osPlatform() !== 'win32') {
    out.push({
      id: 'config.perms',
      category: 'config',
      status: dirMode === 0o700 ? 'ok' : 'warn',
      label: 'dir perms',
      detail: `0${dirMode.toString(8)} (expected 0700)`,
    });
  }

  try {
    const cfg = await loadConfig();
    out.push({
      id: 'config.auth',
      category: 'config',
      status: 'info',
      label: 'auth mode',
      detail: cfg.authMode,
    });
    out.push({
      id: 'config.model',
      category: 'config',
      status: 'info',
      label: 'model',
      detail: cfg.model,
    });
    out.push({
      id: 'config.budget',
      category: 'config',
      status: 'info',
      label: 'budget',
      detail: `$${cfg.maxBudgetUsd.toFixed(2)} / ${cfg.maxTurns} turns`,
    });
    if (cfg.authMode === 'api_key' && !cfg.apiKey) {
      out.push({
        id: 'config.api-key',
        category: 'config',
        status: 'fail',
        label: 'api key',
        detail: 'not set — run `hands auth`',
      });
    }
  } catch (err) {
    out.push({
      id: 'config.load',
      category: 'config',
      status: 'fail',
      label: 'config file',
      detail: classifyFsError(err),
    });
  }

  return out;
}

async function platformChecks(): Promise<CheckResult[]> {
  const p = await checkPlatform();
  const out: CheckResult[] = [
    {
      id: 'platform.display',
      category: 'platform',
      status: 'info',
      label: 'display',
      detail: p.displayServer,
    },
    {
      id: 'platform.screenshot',
      category: 'platform',
      status: p.screenshot.available ? 'ok' : 'fail',
      label: 'screenshot',
      detail: p.screenshot.tool + (p.screenshot.available ? '' : ' — not installed'),
    },
    {
      id: 'platform.mouse',
      category: 'platform',
      status: p.mouse.available ? 'ok' : 'fail',
      label: 'mouse',
      detail: p.mouse.tool + (p.mouse.available ? '' : ' — not installed'),
    },
    {
      id: 'platform.keyboard',
      category: 'platform',
      status: p.keyboard.available ? 'ok' : 'fail',
      label: 'keyboard',
      detail: p.keyboard.tool + (p.keyboard.available ? '' : ' — not installed'),
    },
  ];
  // Wayland: ydotool is a thin client to the ydotoold daemon. The binary can be
  // installed while the daemon is down, in which case mouse/keyboard report ok
  // but every input call hangs to timeout. warn (not fail) — the tool is there,
  // it just needs starting — so this never flips the exit code on its own.
  if (p.displayServer === 'wayland' && p.daemon) {
    out.push({
      id: 'platform.daemon',
      category: 'platform',
      status: p.daemon.running ? 'ok' : 'warn',
      label: p.daemon.name,
      detail: p.daemon.running
        ? `reachable at ${scrubPath(p.daemon.socket)}`
        : `not running — start it: systemctl --user start ydotoold (or run ydotoold with uinput permissions); input calls will hang until it is up`,
    });
  }
  if (p.missingDeps.length > 0 && p.installHint) {
    out.push({
      id: 'platform.install-hint',
      category: 'platform',
      status: 'info',
      label: 'install',
      detail: p.installHint,
    });
  }
  return out;
}

async function claudeCliChecks(): Promise<CheckResult[]> {
  const installed = await commandExists('claude');
  if (!installed) {
    return [
      {
        id: 'claude-cli.present',
        category: 'claude-cli',
        status: 'warn',
        label: 'Claude CLI',
        detail: 'not found — install with `npm i -g @anthropic-ai/claude-code` for zero-per-token Claude Login mode',
      },
    ];
  }
  let version = '?';
  try {
    const claude = await resolveClaudeInvocation();
    const { stdout } = await execFileAsync(claude.command, [...claude.prefixArgs, '--version']);
    version = stdout.trim().split(/\s+/)[0] ?? '?';
  } catch {
    // leave version as ?
  }
  return [
    {
      id: 'claude-cli.present',
      category: 'claude-cli',
      status: 'ok',
      label: 'Claude CLI',
      detail: `v${version}`,
    },
  ];
}

async function voiceChecks(): Promise<CheckResult[]> {
  const ok = await isWhisperInstalled();
  const out: CheckResult[] = [
    {
      id: 'voice.whisper',
      category: 'voice',
      status: ok ? 'ok' : 'info',
      label: 'whisper.cpp',
      detail: ok ? 'installed' : 'not installed — run `hands voice-setup` to enable --voice mode',
    },
  ];

  // The mic recorder is a SEPARATE install from whisper: whisper transcribes a
  // WAV, but nothing produces one without a recording backend, and a user who
  // has whisper but no SoX/arecord hits a runtime ENOENT — exactly what doctor
  // exists to pre-empt. Report the platform's backend (matching getMicCommand()
  // so doctor and --voice never disagree). warn (never fail) on missing —
  // voice is opt-in, so it must not flip the exit code for someone who never
  // uses --voice. Gated by skipWhisper along with the whisper check above.
  const rec = expectedRecorder();
  const found: string[] = [];
  for (const cmd of rec.probe) {
    if (await commandExists(cmd)) found.push(cmd);
  }
  out.push(renderRecorderCheck(rec, found));
  return out;
}

/**
 * Render the `voice.recorder` check from a backend and which of its probe
 * tools were found. Pure — the probing (commandExists) happens in the caller,
 * so the installed/missing rendering is unit-testable without a real recorder.
 */
export function renderRecorderCheck(rec: RecorderBackend, found: string[]): CheckResult {
  if (found.length > 0) {
    return {
      id: 'voice.recorder',
      category: 'voice',
      status: 'ok',
      label: 'recorder',
      detail: `${found[0]}${rec.hasFallback ? ' (preferred; native waveIn otherwise)' : ''}`,
    };
  }
  if (rec.hasFallback) {
    // Windows: native PowerShell waveIn always works, so never warn/fail.
    return {
      id: 'voice.recorder',
      category: 'voice',
      status: 'info',
      label: 'recorder',
      detail: 'native PowerShell waveIn (built in — ffmpeg/sox used first if installed)',
    };
  }
  return {
    id: 'voice.recorder',
    category: 'voice',
    status: 'warn',
    label: 'recorder',
    detail: `${rec.label} not installed — run \`${rec.installHint}\` for --voice`,
  };
}

async function darioChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const baseUrl = process.env['ANTHROPIC_BASE_URL'];
  if (!baseUrl) {
    // Mirror `hands run`'s auto-detect: even with no env var set, run
    // probes the default dario endpoint and silently routes through it
    // when reachable. Reporting "will hit api.anthropic.com directly"
    // here without checking was wrong in exactly the case the
    // auto-detect feature creates.
    const target = (process.env['HANDS_DARIO_URL'] || 'http://localhost:3456').replace(/\/$/, '');
    const fetchImplProbe = opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImplProbe(`${target}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        return [
          {
            id: 'dario.base-url',
            category: 'dario',
            status: 'ok',
            label: 'routing',
            detail: `ANTHROPIC_BASE_URL not set, but dario is reachable at ${target} — \`hands run\` will auto-route through it (subscription billing)`,
          },
        ];
      }
    } catch {
      // No dario — the common case; fall through to the direct-routing note.
    }
    return [
      {
        id: 'dario.base-url',
        category: 'dario',
        status: 'info',
        label: 'routing',
        detail: `ANTHROPIC_BASE_URL not set and no dario detected at ${target} — SDK mode will hit api.anthropic.com directly (per-token billing)`,
      },
    ];
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const start = Date.now();
  try {
    const res = await fetchImpl(`${trimTrailingSlash(baseUrl)}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const durationMs = Date.now() - start;
    if (res.ok) {
      return [
        {
          id: 'dario.reachable',
          category: 'dario',
          status: 'ok',
          label: 'proxy',
          detail: `${baseUrl} — ${res.status} in ${durationMs}ms`,
          durationMs,
        },
      ];
    }
    return [
      {
        id: 'dario.reachable',
        category: 'dario',
        status: 'warn',
        label: 'proxy',
        detail: `${baseUrl} — ${res.status} ${res.statusText}`,
        durationMs,
      },
    ];
  } catch (err) {
    return [
      {
        id: 'dario.reachable',
        category: 'dario',
        status: 'fail',
        label: 'proxy',
        detail: `${baseUrl} — ${classifyFetchError(err)}`,
        durationMs: Date.now() - start,
      },
    ];
  }
}

// ─── Pure helpers (exported for unit tests) ─────────────────────────

/** Minimum Node version for hands: 20.0.0 (engines.node in package.json). */
export function nodeMeetsMinimum(version: string): boolean {
  const clean = version.replace(/^v/, '');
  const [major] = clean.split('.').map(Number);
  return typeof major === 'number' && major >= 20;
}

/** Replace $HOME (or Windows USERPROFILE) in a path with `~` so screenshots / error messages don't leak the user's home directory. */
export function scrubPath(s: string): string {
  const home = homedir();
  if (!home) return s;
  // Simple prefix rewrite, case-insensitive on Windows.
  if (osPlatform() === 'win32') {
    const sLower = s.toLowerCase();
    const homeLower = home.toLowerCase();
    if (sLower.startsWith(homeLower)) {
      return '~' + s.slice(home.length);
    }
  } else if (s.startsWith(home)) {
    return '~' + s.slice(home.length);
  }
  return s;
}

/** Remove trailing slashes from a URL without regex (avoids polynomial-ReDoS). */
export function trimTrailingSlash(url: string): string {
  let i = url.length;
  while (i > 0 && url[i - 1] === '/') i--;
  return url.slice(0, i);
}

/** Convert an fs error into a short human string. */
export function classifyFsError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'not found';
    if (code === 'EACCES') return 'permission denied';
    return `${code ?? 'error'}: ${err.message.slice(0, 80)}`;
  }
  return String(err).slice(0, 80);
}

/** Convert a fetch error into a short human string. */
export function classifyFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
    if (err.message.includes('ECONNREFUSED')) return 'connection refused';
    if (err.message.includes('ENOTFOUND')) return 'dns lookup failed';
    return err.message.slice(0, 80);
  }
  return String(err).slice(0, 80);
}

/** Render a DoctorReport as a human-readable text block. */
export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  hands — Doctor');
  lines.push('  ─────────────');
  lines.push('');

  // Left-pad status icons to a consistent width.
  const ICON: Record<CheckStatus, string> = {
    ok:   '[ OK ]',
    warn: '[WARN]',
    fail: '[FAIL]',
    info: '[INFO]',
  };

  // Compute column widths from the check list.
  const labelWidth = Math.max(...report.checks.map(c => c.label.length), 10);

  // Inject version into the first env.hands row.
  const patched = report.checks.map(c =>
    c.id === 'env.hands' ? { ...c, detail: `v${report.version}` } : c,
  );

  for (const c of patched) {
    lines.push(`  ${ICON[c.status]}  ${c.label.padEnd(labelWidth)}  ${c.detail}`);
  }

  lines.push('');
  const { ok, warn, fail, info } = report.summary;
  lines.push(`  summary: ${ok} ok · ${warn} warn · ${fail} fail · ${info} info`);
  lines.push('');

  return lines.join('\n');
}

/** Render a DoctorReport as JSON. */
export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

/** Exit code to use when `hands doctor` finishes: 1 if any check failed, 0 otherwise. */
export function exitCodeFor(report: DoctorReport): number {
  return report.summary.fail > 0 ? 1 : 0;
}

// ─── Internals ─────────────────────────────────────────────────────

async function readHandsVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/doctor.js → ../package.json when running as the compiled CLI;
    // src/doctor.ts → ../package.json when running via tsx in dev.
    const pkgPath = join(here, '..', 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
