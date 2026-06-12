import { existsSync } from 'node:fs';
import { loadConfig } from './util/config.js';
import type { RunOverrides } from './util/cli-overrides.js';
import { runSdkMode } from './sdk-mode.js';
import { runCliMode } from './cli-mode.js';
import { commandExists } from './platform/index.js';
import { autoDetectDario } from './dario-detect.js';
import { resolvePersona, resolveSystemPromptFile, type PersonaResolution } from './personas.js';
import { loadLastSession } from './util/session-state.js';
import * as output from './util/output.js';

export interface RunOptions {
  voice?: boolean;
  /** When set, SDK mode's tool calls are logged + stubbed — nothing fires on the host. Not supported in Claude Login mode; forces a fallback. */
  dryRun?: boolean;
  /** When true, skip the dario auto-detect probe at startup. Use when the operator wants explicit api.anthropic.com routing despite dario being available. */
  noDario?: boolean;
  /** Named persona (bundled or ~/.hands/personas/<name>.md). Replaces the default OS-aware system prompt with the persona's text. SDK mode only. */
  persona?: string;
  /** Path to a system-prompt file. Bypasses persona lookup. SDK mode only. */
  systemPrompt?: string;
  /** Resume the most recent Claude Login session (`hands run --continue`). The conversation lives in the claude CLI's session store, so this is Claude Login mode only. */
  continueSession?: boolean;
  /** Run a single task and exit instead of entering the interactive loop. The scripting path; exit code 2 when the task did not complete cleanly. */
  once?: boolean;
  /** Emit one machine-readable JSON object on stdout. Implies `once`; caller sets HANDS_QUIET so decorative output is silenced. */
  json?: boolean;
  /** Validated -m/-b/-t values. Applied to the loaded config for this run only — never persisted. */
  overrides?: RunOverrides;
}

/** Exit code contract for `hands run --once`: 0 = task completed, 1 = setup/config error, 2 = task did not complete cleanly. */
export const EXIT_TASK_FAILED = 2;

export interface RunJsonInput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  sessionId?: string | undefined;
  ok?: boolean | undefined;
}

/**
 * The single JSON line `hands run --json` prints. Stable field set —
 * scripts parse this; add fields, never rename. Pure — exported for
 * tests.
 */
export function formatRunJson(result: RunJsonInput, mode: 'cli' | 'sdk', dryRun: boolean = false): string {
  return JSON.stringify({
    ok: result.ok ?? true,
    mode,
    ...(dryRun ? { dryRun: true } : {}),
    result: result.text,
    turns: result.turns,
    costUsd: result.costUsd,
    tokens: { input: result.inputTokens, output: result.outputTokens },
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  });
}

/**
 * True when SDK mode has a usable credential: a stored key, or an env
 * key the Anthropic SDK resolves on its own (`ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN` — the documented dario flow). Pure — exported
 * for tests.
 */
export function hasSdkCredentials(
  configApiKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(configApiKey || env['ANTHROPIC_API_KEY'] || env['ANTHROPIC_AUTH_TOKEN']);
}

export async function run(prompt: string | undefined, options: RunOptions = {}): Promise<void> {
  // Auto-detect dario before loading config so SDK initialization picks
  // up the right ANTHROPIC_BASE_URL. Silent fall-through on no-detect;
  // a one-line info log on detect (so users know they got the
  // subscription path).
  const darioResult = await autoDetectDario({ disabled: !!options.noDario });
  if (darioResult.detected) {
    output.info(darioResult.detail);
  }

  // Resolve persona / explicit system-prompt-path BEFORE config and
  // mode dispatch — surfaces "persona not found" errors with a clear
  // message before we burn time on screenshot capture or auth probing.
  // Mutex: --persona and --system-prompt are mutually exclusive;
  // operator should pick one.
  let personaResolution: PersonaResolution | undefined;
  if (options.persona && options.systemPrompt) {
    output.error('--persona and --system-prompt are mutually exclusive. Pick one.');
    process.exit(1);
  }
  if (options.systemPrompt) {
    try {
      personaResolution = await resolveSystemPromptFile(options.systemPrompt);
    } catch (err) {
      output.error(`Could not read system-prompt file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else if (options.persona) {
    try {
      personaResolution = await resolvePersona(options.persona);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  if (personaResolution) {
    const sourceLabel = personaResolution.source === 'bundled'
      ? `bundled persona "${personaResolution.label}"`
      : personaResolution.source === 'user-file'
        ? `user persona "${personaResolution.label}" (~/.hands/personas/${personaResolution.label}.md)`
        : `system prompt file ${personaResolution.label}`;
    output.info(`using ${sourceLabel} (${personaResolution.prompt.length} chars)`);
  }

  const config = await loadConfig();
  if (options.overrides) {
    Object.assign(config, options.overrides);
  }

  // --continue: resolve the saved session pointer before any mode
  // fallbacks, and refuse combinations that can't honor it. The
  // conversation lives in the claude CLI's session store — there is
  // nothing to resume in SDK mode.
  let resume: { sessionId: string; cwd: string } | undefined;
  if (options.continueSession) {
    if (options.dryRun) {
      output.error('--continue and --dry-run are mutually exclusive: --dry-run forces SDK mode, --continue is Claude Login only.');
      process.exit(1);
    }
    if (config.authMode !== 'oauth') {
      output.error('--continue only works in Claude Login mode — the claude CLI holds the conversation. Current auth mode is API key.');
      output.info('Switch with `hands auth`, or start a fresh task without --continue.');
      process.exit(1);
    }
    const last = await loadLastSession();
    if (!last) {
      output.error('No previous session to continue. Run `hands run "<task>"` first.');
      process.exit(1);
    }
    if (!existsSync(last.cwd)) {
      output.error(`The directory the previous session started from no longer exists: ${last.cwd}`);
      output.info('Start a fresh session instead: hands run "<task>"');
      process.exit(1);
    }
    resume = { sessionId: last.sessionId, cwd: last.cwd };
    const ageMin = Math.max(1, Math.round((Date.now() - last.ts) / 60_000));
    const age = ageMin < 60 ? `${ageMin}m` : ageMin < 60 * 24 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / (60 * 24))}d`;
    output.info(`resuming session ${last.sessionId.slice(0, 8)}… (last task ${age} ago: "${last.task.slice(0, 60)}")`);
  }

  // --dry-run only works in SDK mode. In Claude Login (oauth) mode, `claude`
  // spawns as a child process and dispatches tools itself, so hands can't
  // intercept. Force API-key mode for this invocation so dry-run actually
  // holds; fail loudly if no API key.
  if (options.dryRun && config.authMode === 'oauth') {
    if (!hasSdkCredentials(config.apiKey)) {
      output.error('--dry-run only works in SDK mode (API key), and no API key is configured.');
      output.info('Run `hands auth` to add a key, set ANTHROPIC_API_KEY in the environment, or drop --dry-run to use Claude Login mode.');
      process.exit(1);
    }
    output.warn('--dry-run only works in SDK mode. Forcing SDK mode for this invocation.');
    config.authMode = 'api_key';
  }

  // Auto-detect auth mode
  if (config.authMode === 'oauth') {
    const hasClaude = await commandExists('claude');
    if (!hasClaude) {
      if (resume) {
        // The SDK fallback can't resume a claude-CLI conversation.
        output.error('--continue needs the claude CLI, which was not found. Install it: npm i -g @anthropic-ai/claude-code');
        process.exit(1);
      }
      if (hasSdkCredentials(config.apiKey)) {
        output.warn('Claude CLI not found. Falling back to SDK mode (API key).');
        config.authMode = 'api_key';
      } else {
        output.error('Claude CLI not found. Install it: npm i -g @anthropic-ai/claude-code');
        output.info('Or switch to API key mode: hands auth');
        process.exit(1);
      }
    }
  }

  if (config.authMode === 'api_key' && !hasSdkCredentials(config.apiKey)) {
    output.error('No API key configured. Run `hands auth`, or set ANTHROPIC_API_KEY in the environment (e.g. for dario routing).');
    process.exit(1);
  }

  try {
    if (config.authMode === 'oauth') {
      // CLI mode handles its own interactive loop and output
      const result = await runCliMode(prompt, config, {
        voice: options.voice,
        once: options.once,
        ...(personaResolution ? { persona: personaResolution } : {}),
        ...(resume ? { resume } : {}),
      });
      if (options.once) {
        if (options.json) {
          console.log(formatRunJson(result, 'cli'));
        }
        if (result.ok === false) {
          process.exitCode = EXIT_TASK_FAILED;
        }
      }
    } else {
      if (!prompt) {
        // cli.ts only allows a missing prompt together with --continue,
        // and --continue never reaches the SDK branch. Belt-and-braces.
        output.error('A prompt is required in SDK mode.');
        process.exit(1);
      }
      const result = await runSdkMode(prompt, config, {
        dryRun: options.dryRun,
        ...(personaResolution ? { systemPromptOverride: personaResolution.prompt } : {}),
      });
      if (options.json) {
        console.log(formatRunJson(result, 'sdk', !!options.dryRun));
      } else {
        if (result.text) {
          output.header('Result');
          console.log(result.text);
        }
        output.cost(
          { input: result.inputTokens, output: result.outputTokens },
          result.costUsd,
          result.turns,
        );
      }
    }
  } catch (err) {
    if (options.json) {
      // Scripts parse stdout — a failure must still be one JSON line.
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      process.exit(EXIT_TASK_FAILED);
    }
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
