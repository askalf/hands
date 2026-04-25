// `hands init` — interactive first-run setup.
//
// One command that walks a new user through the choices hands asks them
// to make before the first `hands run`: which auth mode, whether to set
// up voice, whether they're routing through dario. Delegates the
// mode-specific flows (auth → authInteractive, voice → setupWhisper)
// to the existing modules so there's no duplicated logic.
//
// Safe to run repeatedly — every step asks before changing anything, and
// sane defaults reflect the current config.

import { commandExists } from './platform/index.js';
import { authInteractive } from './auth.js';
import { loadConfig } from './util/config.js';
import { isWhisperInstalled, setupWhisper } from './voice/index.js';
import * as output from './util/output.js';

export async function initInteractive(): Promise<void> {
  const { default: inquirer } = await import('inquirer');

  output.header('hands — First-run setup');
  console.log();

  // Environment snapshot, informational.
  const claudeInstalled = await commandExists('claude');
  const whisperReady = await isWhisperInstalled();
  const darioRoutingHint = process.env['ANTHROPIC_BASE_URL'];

  console.log(`  ${fmt(claudeInstalled)} Claude CLI ${claudeInstalled ? 'installed' : 'NOT installed (needed for Claude Login mode)'}`);
  console.log(`  ${fmt(whisperReady)} whisper.cpp ${whisperReady ? 'installed' : 'not installed (voice mode off)'}`);
  console.log(`  ${fmt(!!darioRoutingHint)} ANTHROPIC_BASE_URL ${darioRoutingHint ? '= ' + darioRoutingHint : 'not set (SDK mode hits api.anthropic.com directly)'}`);
  console.log();

  // Step 1 — auth mode. If claude CLI is missing, suggest installing it
  // before bailing into API-key-only territory.
  if (!claudeInstalled) {
    const { installClaude } = await inquirer.prompt([{
      type: 'confirm',
      name: 'installClaude',
      message: 'Claude CLI (`claude`) is not on PATH. Claude Login mode needs it and costs zero per token. Install it now? (`npm i -g @anthropic-ai/claude-code`)',
      default: true,
    }]);
    if (installClaude) {
      output.info('Run: npm i -g @anthropic-ai/claude-code');
      output.info('Then re-run `hands init` to continue.');
      return;
    }
    output.warn('Continuing without Claude CLI — only API Key mode will be available.');
  }

  // Step 2 — delegate to the existing auth flow. It handles Claude Login
  // vs API Key, prompts for a key if needed, and saves config.
  console.log();
  output.info('Configuring authentication...');
  await authInteractive();

  // Step 3 — voice setup offer. Non-destructive skip if already installed.
  console.log();
  if (whisperReady) {
    output.success('whisper.cpp already installed — `--voice` mode is ready.');
  } else {
    const { wantVoice } = await inquirer.prompt([{
      type: 'confirm',
      name: 'wantVoice',
      message: 'Set up voice input now? Downloads whisper.cpp locally (~148MB for the base.en model). Offline, private.',
      default: false,
    }]);
    if (wantVoice) {
      await setupWhisper('base');
    } else {
      output.info('Skipped. Run `hands voice-setup` later to enable `--voice`.');
    }
  }

  // Step 4 — dario routing nudge. Only meaningful for API Key mode (SDK
  // mode routes to whatever ANTHROPIC_BASE_URL points at). We don't
  // write env vars for the user — shells are too varied — we just
  // surface the instruction.
  console.log();
  const config = await loadConfig();
  if (config.authMode === 'api_key' && !darioRoutingHint) {
    output.info('Tip: if you run [dario](https://github.com/askalf/dario) locally, point SDK mode at it to bill against your Claude Max subscription instead of per-token API overage:');
    console.log();
    console.log('    export ANTHROPIC_BASE_URL=http://localhost:3456');
    console.log('    export ANTHROPIC_API_KEY=dario');
    console.log();
    output.info('(Set these in your shell before running `hands`. The SDK client reads them by default.)');
  }

  // Final summary.
  console.log();
  output.header('Ready');
  // Boolean intermediate so CodeQL's js/clear-text-logging flow can
  // see that we only consume the truthy-ness of apiKey, never its
  // value. The template literal's true-branch is the fixed string
  // ' (key stored)' — the key itself is never emitted — but CodeQL's
  // dataflow conservatively flags any access on the path to a logger,
  // and routing through Boolean(...) is the standard break.
  const keyStored = config.authMode === 'api_key' && Boolean(config.apiKey);
  output.success(`auth: ${config.authMode}${keyStored ? ' (key stored)' : ''}`);
  output.success(`model: ${config.model}`);
  output.success(`budget: $${config.maxBudgetUsd.toFixed(2)} / ${config.maxTurns} turns`);
  output.success(`voice: ${(await isWhisperInstalled()) ? 'ready' : 'not installed'}`);
  console.log();
  output.info('Try it:');
  console.log('    hands run "open notepad and type hello world"');
}

function fmt(ok: boolean): string {
  // ASCII-only to avoid codepage fights in Windows terminals.
  return ok ? '[ok]  ' : '[miss]';
}
