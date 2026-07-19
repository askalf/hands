import { existsSync } from 'node:fs';
import { loadConfig } from './util/config.js';
import type { RunOverrides } from './util/cli-overrides.js';
import { runSdkMode } from './sdk-mode.js';
import { runCliMode } from './cli-mode.js';
import { commandExists } from './platform/index.js';
import { autoDetectDario } from './dario-detect.js';
import { resolvePersona, resolveSystemPromptFile, type PersonaResolution } from './personas.js';
import { loadLastSession } from './util/session-state.js';
import type { GuardController } from './util/guard.js';
import type { WardenGate } from './util/warden.js';
import type { MacroRecorder } from './macros.js';
import * as output from './util/output.js';

export interface RunOptions {
  voice?: boolean;
  /** When set, SDK mode's tool calls are logged + stubbed — nothing fires on the host. Not supported in Claude Login mode; forces a fallback. */
  dryRun?: boolean;
  /** When set, every state-changing tool call pauses for approval before it fires (`hands run --guard`). Like dry-run, this is a SDK-mode gate, so it forces SDK mode for the invocation. Mutually exclusive with --dry-run / --json / --continue. */
  guard?: boolean;
  /** When set, every tool call is classified by warden's policy firewall before dispatch (`hands run --warden`). SDK-mode gate like --guard. Mutually exclusive with --dry-run / --json / --continue / --guard. */
  warden?: boolean;
  /** With --warden: send gray-zone (obfuscated / indirect) calls to warden's LLM judge, which can only escalate the tier (`hands run --warden --judge`). Rides the run's endpoint — $0 through dario. */
  judge?: boolean;
  /** Crystallize: record this run's effectful tool calls into a deterministic macro of this name (`hands run --record <name>`). Works in both modes — SDK captures at the dispatch site, Claude Login from the stream-json feed. */
  record?: string;
  /** Self-verify: the agent must prove success with a real check before claiming done (`hands run --verify`). Works in both modes. */
  verify?: boolean;
  /** Semantic UI targeting: give the agent `ui_tree` + `click_element` (accessibility-tree) tools (`hands run --ui`). SDK-mode tools; Windows and macOS. */
  ui?: boolean;
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

/** Surface the learning loop's outcome — the one product moment of auto-crystallize. */
function announceLearn(outcome: import('./learn.js').LearnOutcome): void {
  if (outcome.kind === 'promoted' && outcome.macroName) {
    output.success(`✨ learned: ${outcome.cluster} similar runs — crystallized ${outcome.steps} step${outcome.steps === 1 ? '' : 's'} → macro "${outcome.macroName}"`);
    output.info(`replay free (no LLM): hands play ${outcome.macroName} · re-aim: hands macro parameterize ${outcome.macroName} key=value · off: HANDS_NO_LEARN=1`);
  } else if (outcome.kind === 'reminder' && outcome.macroName) {
    output.info(`💡 you have a $0 macro for this task: hands play ${outcome.macroName}`);
  }
}

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
  // --guard is interactive and fires real actions one approval at a time,
  // so it can't combine with the modes that contradict that.
  if (options.guard && options.dryRun) {
    output.error('--guard and --dry-run are mutually exclusive: guard asks before each action fires, dry-run fires nothing.');
    process.exit(1);
  }
  if (options.guard && options.json) {
    output.error('--guard and --json are mutually exclusive: guarded mode is interactive.');
    process.exit(1);
  }
  if (options.guard && options.continueSession) {
    output.error('--guard and --continue are mutually exclusive: guard forces SDK mode, --continue is Claude Login only.');
    process.exit(1);
  }
  // --warden has the same SDK-mode, interactive constraints as --guard, and
  // the two are distinct gates — pick one.
  if (options.warden && options.guard) {
    output.error('--warden and --guard are mutually exclusive: warden gates by policy (and prompts only on red); guard prompts on every action. Pick one.');
    process.exit(1);
  }
  if (options.warden && options.dryRun) {
    output.error('--warden and --dry-run are mutually exclusive: there is nothing to gate when nothing fires.');
    process.exit(1);
  }
  if (options.warden && options.json) {
    output.error('--warden and --json are mutually exclusive: warden may prompt for red-tier actions, which is interactive.');
    process.exit(1);
  }
  // --judge is a refinement of --warden, not a mode of its own.
  if (options.judge && !options.warden) {
    output.error('--judge only works with --warden: the judge is consulted on warden\'s gray-zone verdicts.');
    process.exit(1);
  }
  if (options.warden && options.continueSession) {
    output.error('--warden and --continue are mutually exclusive: warden forces SDK mode, --continue is Claude Login only.');
    process.exit(1);
  }
  // --record captures at the SDK dispatch site (Claude Login runs tools in
  // its child, where hands can't see full inputs), and there's nothing to
  // capture from a stubbed run.
  if (options.record && options.dryRun) {
    output.error('--record and --dry-run are mutually exclusive: a stubbed run executes nothing to crystallize.');
    process.exit(1);
  }
  if (options.record && options.continueSession) {
    output.error('--record and --continue are mutually exclusive: recording is SDK-mode, --continue is Claude Login only.');
    process.exit(1);
  }

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

  // --guard gates tool calls at the SDK dispatch site. In Claude Login
  // mode the claude child runs the tools itself, so there's nothing to
  // gate — force SDK mode (route through dario to keep it $0).
  if (options.guard && config.authMode === 'oauth') {
    if (!hasSdkCredentials(config.apiKey)) {
      output.error('--guard runs in SDK mode, and no API key is configured.');
      output.info('Run `hands auth` to add a key, set ANTHROPIC_API_KEY in the environment (e.g. for dario routing), or drop --guard to use Claude Login mode.');
      process.exit(1);
    }
    output.warn('--guard runs in SDK mode (the gate must sit at the dispatch site). Forcing SDK mode; route through dario to keep it $0.');
    config.authMode = 'api_key';
  }

  // --warden gates at the SDK dispatch site too — same reasoning as --guard.
  if (options.warden && config.authMode === 'oauth') {
    if (!hasSdkCredentials(config.apiKey)) {
      output.error('--warden runs in SDK mode, and no API key is configured.');
      output.info('Run `hands auth` to add a key, set ANTHROPIC_API_KEY in the environment (e.g. for dario routing), or drop --warden to use Claude Login mode.');
      process.exit(1);
    }
    output.warn('--warden runs in SDK mode (the gate must sit at the dispatch site). Forcing SDK mode; route through dario to keep it $0.');
    config.authMode = 'api_key';
  }

  // --record works in BOTH modes. SDK mode captures at the dispatch
  // site; Claude Login mode captures from the stream-json feed, whose
  // tool_use blocks carry full inputs — so recording on a subscription
  // costs $0 and needs no key. Validate the macro name up front in
  // either mode: better to refuse before the model runs than after
  // the work is done.
  if (options.record) {
    const { isValidMacroName, loadMacro } = await import('./macros.js');
    if (!isValidMacroName(options.record)) {
      output.error(`Invalid macro name "${options.record}". Use letters, digits, dashes, and underscores.`);
      process.exit(1);
    }
    let exists = false;
    try { await loadMacro(options.record); exists = true; } catch { /* not found is what we want */ }
    if (exists) {
      output.error(`Macro "${options.record}" already exists. Delete it first (hands macro rm ${options.record}) or pick another name.`);
      process.exit(1);
    }
  }

  // --ui adds SDK-mode tools (ui_tree / click_element).
  if (options.ui && config.authMode === 'oauth') {
    if (!hasSdkCredentials(config.apiKey)) {
      output.error('--ui adds SDK-mode tools, and no API key is configured.');
      output.info('Run `hands auth` to add a key, set ANTHROPIC_API_KEY in the environment (e.g. for dario routing), or drop --ui.');
      process.exit(1);
    }
    output.warn('--ui adds SDK-mode tools (semantic targeting). Forcing SDK mode; route through dario to keep it $0.');
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
        ...(options.verify ? { verify: true } : {}),
        ...(personaResolution ? { persona: personaResolution } : {}),
        ...(resume ? { resume } : {}),
        ...(options.record ? { record: options.record } : {}),
      });
      if (options.once) {
        if (options.json) {
          console.log(formatRunJson(result, 'cli'));
        }
        if (result.ok === false) {
          process.exitCode = EXIT_TASK_FAILED;
        }
        // Learn from the run: history + reminders, PLUS the shadow trajectory
        // (result.steps) captured from the stream, so auto-crystallize works
        // on a Claude subscription — a 3rd similar run promotes itself to a
        // $0 macro, same as SDK mode. An explicit --record saves the macro
        // itself, so it skips learning, matching the SDK branch.
        if (prompt && !options.record) {
          const { recordRunAndMaybeLearn } = await import('./learn.js');
          announceLearn(await recordRunAndMaybeLearn({
            prompt, mode: 'cli', ok: result.ok !== false, turns: result.turns, costUsd: result.costUsd,
            ...(result.steps ? { steps: result.steps } : {}),
          }));
        }
      }
    } else {
      if (!prompt) {
        // cli.ts only allows a missing prompt together with --continue,
        // and --continue never reaches the SDK branch. Belt-and-braces.
        output.error('A prompt is required in SDK mode.');
        process.exit(1);
      }
      let guardHandle: { guard: GuardController; close: () => void } | undefined;
      let wardenGate: WardenGate | undefined;
      if (options.guard) {
        const { createTerminalGuard } = await import('./util/guard.js');
        guardHandle = createTerminalGuard();
        output.info('guarded mode — every state-changing action pauses for [a]llow / [d]eny / [A]lways / [e]dit / [q]uit.');
      }
      if (options.warden) {
        const { createWardenGate, wardenPaths } = await import('./util/warden.js');
        // Red-tier approvals reuse the guard prompt, but only when a TTY is
        // attached; unattended, red fails closed.
        const interactive = process.stdin.isTTY === true;
        if (interactive) {
          const { createTerminalGuard } = await import('./util/guard.js');
          guardHandle = createTerminalGuard();
        }
        try {
          wardenGate = await createWardenGate({
            ...(interactive && guardHandle ? { guard: guardHandle.guard } : {}),
            out: (line: string) => output.info(line),
            ...(options.judge ? { judge: { apiKey: config.apiKey } } : {}),
          });
        } catch (err) {
          guardHandle?.close();
          output.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        output.info(
          `warden firewall active — ${interactive ? 'red-tier actions prompt for approval' : 'unattended: red-tier fails closed'}${options.judge ? '; LLM judge on gray-zone calls (escalate-only)' : ''}. Policy: ${wardenPaths().policy}`,
        );
      }
      let recorder: MacroRecorder | undefined;
      const recordName = options.record;
      if (recordName) {
        // Name validity + collision were already checked up front,
        // before mode selection.
        const { MacroRecorder } = await import('./macros.js');
        recorder = new MacroRecorder();
        output.info(`recording → macro "${recordName}" — effectful steps will crystallize into a deterministic, $0 replay.`);
      } else if (!options.dryRun) {
        // Shadow capture for auto-crystallize: SDK runs are single-task, so
        // the effectful trajectory is exactly what --record would save —
        // kept in memory, promoted to a macro only when the learning loop
        // sees this task for the third time.
        const { MacroRecorder } = await import('./macros.js');
        recorder = new MacroRecorder();
      }
      try {
        const result = await runSdkMode(prompt, config, {
          dryRun: options.dryRun,
          ...(personaResolution ? { systemPromptOverride: personaResolution.prompt } : {}),
          ...(options.guard && guardHandle ? { guard: guardHandle.guard } : {}),
          ...(wardenGate ? { warden: wardenGate } : {}),
          ...(recorder ? { recorder } : {}),
          ...(options.verify ? { verify: true } : {}),
          ...(options.ui ? { ui: true } : {}),
        });
        if (recordName && recorder) {
          if (recorder.steps.length > 0) {
            const { saveMacro } = await import('./macros.js');
            const path = await saveMacro({ name: recordName, prompt, platform: process.platform, createdAt: Date.now(), steps: recorder.steps });
            output.success(`crystallized ${recorder.steps.length} step${recorder.steps.length === 1 ? '' : 's'} → ${path}`);
            output.info(`replay free (no LLM): hands play ${recordName}  ·  script: hands play ${recordName} --export <file>`);
          } else {
            output.warn(`nothing effectful to record — macro "${recordName}" not saved.`);
          }
        }
        if (wardenGate) output.info(wardenGate.summary());
        else if (guardHandle) output.info(guardHandle.guard.summary());
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
        if (!options.dryRun && !recordName) {
          const { recordRunAndMaybeLearn } = await import('./learn.js');
          announceLearn(await recordRunAndMaybeLearn({
            prompt, mode: 'sdk', ok: true, turns: result.turns, costUsd: result.costUsd,
            ...(recorder ? { steps: recorder.steps } : {}),
          }));
        }
      } finally {
        guardHandle?.close();
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
