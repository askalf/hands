#!/usr/bin/env node

import { Command } from 'commander';
import { authInteractive, showAuthStatus } from './auth.js';
import { initInteractive } from './init.js';
import { run } from './run.js';
import { checkPlatform } from './platform/index.js';
import { loadConfig, saveConfig } from './util/config.js';
import { parseOverrides } from './util/cli-overrides.js';
import { isWhisperInstalled, setupWhisper } from './voice/index.js';
import { runDoctor, renderDoctorText, renderDoctorJson, exitCodeFor } from './doctor.js';
import * as output from './util/output.js';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('hands')
  .description('Open source computer-use agent — control your computer with natural language')
  .version(pkg.version);

program
  .command('init')
  .description('Interactive first-run setup: auth, voice (optional), dario routing tips. Safe to re-run.')
  .action(async () => {
    await initInteractive();
  });

program
  .command('auth')
  .description('Configure authentication (API key or Claude OAuth)')
  .option('--status', 'Show current auth status')
  .action(async (opts) => {
    if (opts.status) {
      await showAuthStatus();
    } else {
      await authInteractive();
    }
  });

program
  .command('run')
  .description('Run the agent with a natural language prompt')
  .argument('<prompt>', 'What you want the agent to do')
  .option('-m, --model <model>', 'Model to use (this run only; persist with `hands config --model`)')
  .option('-b, --budget <amount>', 'Max budget in USD (this run only; persist with `hands config --budget`)')
  .option('-t, --turns <count>', 'Max turns (this run only; persist with `hands config --turns`)')
  .option('-v, --voice', 'Use voice input (microphone → whisper transcription)')
  .option('--dry-run', 'Log every tool call to ~/.hands/audit.jsonl but don\'t actually execute. SDK mode only.')
  .option('--no-dario', 'Skip the dario proxy auto-detect at startup. Forces direct api.anthropic.com routing even when dario is reachable on localhost:3456.')
  .option('--persona <name>', 'Use a named persona (bundled: minimal, thorough, concise, security-aware) or ~/.hands/personas/<name>.md. SDK mode only.')
  .option('--system-prompt <path>', 'Path to a system-prompt file. Bypasses --persona. SDK mode only.')
  .action(async (prompt, opts) => {
    // -m/-b/-t apply to this run only — `hands config` is the
    // persistence path. (They used to be written straight to
    // config.json, unvalidated, so `-b abc` persisted a NaN budget
    // that crashed every later SDK run.)
    const parsed = parseOverrides({
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
    });
    if (!parsed.ok) {
      parsed.errors.forEach((e) => output.error(e));
      process.exit(1);
    }

    await run(prompt, {
      voice: opts.voice,
      dryRun: opts.dryRun,
      noDario: opts.dario === false,
      ...(opts.persona ? { persona: opts.persona } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(Object.keys(parsed.overrides).length > 0 ? { overrides: parsed.overrides } : {}),
    });
  });

program
  .command('check')
  .description('Check platform dependencies and capabilities')
  .action(async () => {
    output.header('Platform Check');

    const check = await checkPlatform();

    console.log();
    console.log(chalk.dim('Platform:'), check.platform);
    console.log(chalk.dim('Display:'), check.displayServer);
    console.log();

    const icon = (ok: boolean) => ok ? chalk.green('✔') : chalk.red('✖');

    console.log(icon(check.screenshot.available), 'Screenshot:', check.screenshot.tool);
    console.log(icon(check.mouse.available), 'Mouse control:', check.mouse.tool);
    console.log(icon(check.keyboard.available), 'Keyboard control:', check.keyboard.tool);
    console.log(icon(check.claudeCli), 'Claude CLI:', check.claudeCli ? 'installed' : 'not found');
    console.log();

    const whisperReady = await isWhisperInstalled();
    console.log(icon(whisperReady), 'Voice (whisper.cpp):', whisperReady ? 'installed' : 'not found — run: hands voice-setup');
    console.log();

    if (check.missingDeps.length > 0) {
      output.warn(`Missing dependencies: ${check.missingDeps.join(', ')}`);
      if (check.installHint) {
        output.info(`Install with: ${check.installHint}`);
      }
    } else {
      output.success('All dependencies available!');
    }

    const config = await loadConfig();
    console.log();
    console.log(chalk.dim('Auth mode:'), config.authMode ?? 'not configured');
    console.log(chalk.dim('Model:'), config.model);
    console.log(chalk.dim('Budget:'), `$${config.maxBudgetUsd.toFixed(2)}`);
    console.log(chalk.dim('Max turns:'), config.maxTurns);
    console.log(chalk.dim('Guardrails:'), chalk.green('active'));
  });

program
  .command('doctor')
  .description('Aggregated health report — env, config, platform tools, Claude CLI, voice, dario routing. Paste into issues.')
  .option('--json', 'Emit structured JSON instead of the text table')
  .option('--skip-dario', 'Skip the dario reachability probe even if ANTHROPIC_BASE_URL is set')
  .option('--skip-whisper', 'Skip the whisper-install check (useful in CI without the binary)')
  .action(async (opts) => {
    const report = await runDoctor({
      skipDario: !!opts.skipDario,
      skipWhisper: !!opts.skipWhisper,
    });
    process.stdout.write(opts.json ? renderDoctorJson(report) + '\n' : renderDoctorText(report));
    process.exit(exitCodeFor(report));
  });

// ── audit ─────────────────────────────────────────────────────────
const auditCmd = program
  .command('audit')
  .description('Inspect and replay entries from ~/.hands/audit.jsonl');

auditCmd
  .command('list')
  .description('List recent audit entries with their replay index')
  .option('-n, --last <count>', 'Show the last N entries (default 20)', '20')
  .action(async (opts) => {
    const { readAuditEntries, summarizeEntry } = await import('./audit-replay.js');
    const entries = await readAuditEntries();
    if (entries.length === 0) {
      output.info('No audit entries yet. Run `hands run "..."` to record some.');
      return;
    }
    const n = parseInt(opts.last, 10);
    const slice = entries.slice(-n);
    const startIdx = entries.length - slice.length;
    output.header(`Last ${slice.length} of ${entries.length} entries`);
    slice.forEach((entry, i) => {
      const idx = startIdx + i;
      console.log(`  [${idx}] ${summarizeEntry(entry)}`);
    });
    console.log();
    output.info('Use `hands audit show <index>` for full detail, or `hands audit replay <index>` to re-execute.');
  });

auditCmd
  .command('show <index>')
  .description('Show full JSON detail for one audit entry')
  .action(async (indexStr) => {
    const { readAuditEntries } = await import('./audit-replay.js');
    const entries = await readAuditEntries();
    const idx = parseInt(indexStr, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= entries.length) {
      output.error(`Invalid index: ${indexStr}. Range is 0–${entries.length - 1}.`);
      process.exit(1);
    }
    console.log(JSON.stringify(entries[idx], null, 2));
  });

auditCmd
  .command('replay <index>')
  .description('Re-execute one audit entry. Default is dry-run (preview); --execute fires.')
  .option('--execute', 'Actually fire the tool call. Without this flag, only prints what would happen.')
  .action(async (indexStr, opts) => {
    const { readAuditEntries, replayEntry, classifyEntry, summarizeEntry } = await import('./audit-replay.js');
    const entries = await readAuditEntries();
    const idx = parseInt(indexStr, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= entries.length) {
      output.error(`Invalid index: ${indexStr}. Range is 0–${entries.length - 1}.`);
      process.exit(1);
    }
    const entry = entries[idx]!;
    output.info(`entry [${idx}]: ${summarizeEntry(entry)}`);
    if (!opts.execute) {
      output.info('(dry-run; pass --execute to fire)');
      await replayEntry(entry, { dryRun: true });
      return;
    }
    const cls = classifyEntry(entry);
    if (cls === 'state-changing') {
      output.warn(`Entry is state-changing (${entry.tool}${entry.action ? ':' + entry.action : ''}). Fire? [y/N]`);
      const answer = await readLine();
      if (answer.trim().toLowerCase() !== 'y') {
        output.info('Aborted.');
        return;
      }
    }
    try {
      await replayEntry(entry, { dryRun: false });
      output.success('Replay complete.');
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.once('data', (c) => { chunks.push(c); resolve(Buffer.concat(chunks).toString()); });
  });
}

program
  .command('voice-setup')
  .description('Download whisper.cpp binary and speech model for voice control')
  .option('--model <size>', 'Model size: tiny, base, small, medium', 'base')
  .action(async (opts) => {
    const validModels = ['tiny', 'base', 'small', 'medium'] as const;
    const model = opts.model as typeof validModels[number];
    if (!validModels.includes(model)) {
      output.error(`Invalid model: ${opts.model}. Choose: ${validModels.join(', ')}`);
      process.exit(1);
    }
    await setupWhisper(model);
  });

program
  .command('config')
  .description('Update configuration')
  .option('-m, --model <model>', 'Default model')
  .option('-b, --budget <amount>', 'Default max budget in USD')
  .option('-t, --turns <count>', 'Default max turns')
  .action(async (opts) => {
    const parsed = parseOverrides({
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
    });
    if (!parsed.ok) {
      parsed.errors.forEach((e) => output.error(e));
      process.exit(1);
    }
    const updates = parsed.overrides;

    if (Object.keys(updates).length === 0) {
      const config = await loadConfig();
      output.header('Current Configuration');
      console.log(JSON.stringify(config, null, 2));
    } else {
      const config = await saveConfig(updates);
      output.success('Configuration updated');
      console.log(JSON.stringify(config, null, 2));
    }
  });

program.parse();
