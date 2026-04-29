import { loadConfig } from './util/config.js';
import { runSdkMode } from './sdk-mode.js';
import { runCliMode } from './cli-mode.js';
import { commandExists } from './platform/index.js';
import { autoDetectDario } from './dario-detect.js';
import * as output from './util/output.js';

export interface RunOptions {
  voice?: boolean;
  /** When set, SDK mode's tool calls are logged + stubbed — nothing fires on the host. Not supported in Claude Login mode; forces a fallback. */
  dryRun?: boolean;
  /** When true, skip the dario auto-detect probe at startup. Use when the operator wants explicit api.anthropic.com routing despite dario being available. */
  noDario?: boolean;
}

export async function run(prompt: string, options: RunOptions = {}): Promise<void> {
  // Auto-detect dario before loading config so SDK initialization picks
  // up the right ANTHROPIC_BASE_URL. Silent fall-through on no-detect;
  // a one-line info log on detect (so users know they got the
  // subscription path).
  const darioResult = await autoDetectDario({ disabled: !!options.noDario });
  if (darioResult.detected) {
    output.info(darioResult.detail);
  }

  const config = await loadConfig();

  // --dry-run only works in SDK mode. In Claude Login (oauth) mode, `claude`
  // spawns as a child process and dispatches tools itself, so hands can't
  // intercept. Force API-key mode for this invocation so dry-run actually
  // holds; fail loudly if no API key.
  if (options.dryRun && config.authMode === 'oauth') {
    if (!config.apiKey) {
      output.error('--dry-run only works in SDK mode (API key), and no API key is configured.');
      output.info('Run `hands auth` to add an API key, or drop --dry-run to use Claude Login mode.');
      process.exit(1);
    }
    output.warn('--dry-run only works in SDK mode. Forcing SDK mode for this invocation.');
    config.authMode = 'api_key';
  }

  // Auto-detect auth mode
  if (config.authMode === 'oauth') {
    const hasClaude = await commandExists('claude');
    if (!hasClaude) {
      if (config.apiKey) {
        output.warn('Claude CLI not found. Falling back to SDK mode (API key).');
        config.authMode = 'api_key';
      } else {
        output.error('Claude CLI not found. Install it: npm i -g @anthropic-ai/claude-code');
        output.info('Or switch to API key mode: hands auth');
        process.exit(1);
      }
    }
  }

  if (config.authMode === 'api_key' && !config.apiKey) {
    output.error('No API key configured. Run: hands auth');
    process.exit(1);
  }

  try {
    if (config.authMode === 'oauth') {
      // CLI mode handles its own interactive loop and output
      await runCliMode(prompt, config, { voice: options.voice });
    } else {
      const result = await runSdkMode(prompt, config, { dryRun: options.dryRun });
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
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
