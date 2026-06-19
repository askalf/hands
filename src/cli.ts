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
import { parseRecipeRef, parseSetPairs } from './recipes.js';
import * as output from './util/output.js';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

/** Commander processor that accumulates a repeatable option into an array. */
const collect = (value: string, acc: string[]): string[] => {
  acc.push(value);
  return acc;
};

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
  .argument('[prompt]', 'What you want the agent to do (optional with --continue)')
  .option('-m, --model <model>', 'Model to use (this run only; persist with `hands config --model`)')
  .option('-b, --budget <amount>', 'Max budget in USD (this run only; persist with `hands config --budget`)')
  .option('-t, --turns <count>', 'Max turns (this run only; persist with `hands config --turns`)')
  .option('-v, --voice', 'Use voice input (microphone → whisper transcription)')
  .option('-c, --continue', 'Resume the most recent Claude Login session — works across exits and reboots')
  .option('--once', 'Run a single task and exit — no interactive "What next?" loop. For scripts and cron. Exit code 2 if the task did not complete cleanly.')
  .option('--json', 'Emit one machine-readable JSON object on stdout. Implies --once and silences all decorative output.')
  .option('--dry-run', 'Log every tool call to ~/.hands/audit.jsonl but don\'t actually execute. SDK mode only.')
  .option('--guard', 'Pause for [a]llow / [d]eny / [A]lways / [e]dit / [q]uit before every state-changing action. Forces SDK mode (like --dry-run).')
  .option('--warden', 'Route each action through warden\'s policy firewall (blocks black, holds red for approval). Forces SDK mode. Needs @askalf/warden installed (or HANDS_WARDEN_PATH).')
  .option('--record <name>', 'Crystallize this run into a deterministic macro of <name> — replay it later free (no LLM) with `hands play <name>`. Forces SDK mode.')
  .option('--no-dario', 'Skip the dario proxy auto-detect at startup. Forces direct api.anthropic.com routing even when dario is reachable on localhost:3456.')
  .option('--persona <name>', 'Use a named persona (bundled: minimal, thorough, concise, security-aware) or ~/.hands/personas/<name>.md. SDK mode only.')
  .option('--system-prompt <path>', 'Path to a system-prompt file. Bypasses --persona. SDK mode only.')
  .option('--set <pair>', 'Set a recipe parameter for {{placeholders}}: --set key=value (repeatable, put after the @recipe).', collect, [])
  .action(async (prompt, opts) => {
    // `hands run @name` runs a saved recipe instead of a one-off prompt.
    const recipeName = parseRecipeRef(prompt);
    if (recipeName) {
      if (opts.voice) {
        output.error('--voice and @recipe are mutually exclusive — a recipe is non-interactive by nature.');
        process.exit(1);
      }
      if (opts.continue) {
        output.error('--continue and @recipe are mutually exclusive — a recipe starts (and chains) its own session.');
        process.exit(1);
      }
      const setParsed = parseSetPairs(opts.set);
      if (!setParsed.ok) {
        setParsed.errors.forEach((e) => output.error(e));
        process.exit(1);
      }
      if (opts.json) process.env['HANDS_QUIET'] = '1';
      const parsedRecipeOv = parseOverrides({
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
        ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
      });
      if (!parsedRecipeOv.ok) {
        parsedRecipeOv.errors.forEach((e) => output.error(e));
        process.exit(1);
      }
      const { runRecipe } = await import('./recipe-run.js');
      await runRecipe(recipeName, {
        once: true,
        json: opts.json,
        dryRun: opts.dryRun,
        guard: opts.guard,
        warden: opts.warden,
        noDario: opts.dario === false,
        params: setParsed.params,
        ...(opts.persona ? { persona: opts.persona } : {}),
        ...(Object.keys(parsedRecipeOv.overrides).length > 0 ? { overrides: parsedRecipeOv.overrides } : {}),
      });
      return;
    }
    if (opts.set && opts.set.length > 0) {
      output.warn('--set is ignored without a @recipe.');
    }
    // `@@task` escapes a literal prompt that should start with `@`.
    if (prompt && prompt.startsWith('@@')) prompt = prompt.slice(1);
    if (!prompt && !opts.continue) {
      output.error('A prompt is required unless --continue is set.');
      output.info('Usage: hands run "<task>"  ·  hands run --continue  ·  hands run --continue "<follow-up task>"');
      process.exit(1);
    }
    const once: boolean = !!(opts.once || opts.json);
    if (once && !prompt) {
      // Bare `--continue --once` would have to ask "What next?"
      // interactively, which defeats the scripting contract.
      output.error('--once/--json need a prompt: hands run --once "<task>" (add -c to resume the previous session).');
      process.exit(1);
    }
    if (opts.json && opts.voice) {
      output.error('--json and --voice are mutually exclusive — voice input is interactive by nature.');
      process.exit(1);
    }
    if (opts.json) {
      // stdout must carry exactly one JSON line; route everything
      // decorative through the existing quiet mechanism.
      process.env['HANDS_QUIET'] = '1';
    }
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
      guard: opts.guard,
      warden: opts.warden,
      noDario: opts.dario === false,
      continueSession: opts.continue,
      once,
      json: opts.json,
      ...(opts.record ? { record: opts.record } : {}),
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
    // The checkCommand blocklist gates SDK-mode bash (and audit
    // replay) at the dispatch site, and CLI-mode bash via a PreToolUse
    // hook injected into the claude child — hooks fire and can deny
    // even under --dangerously-skip-permissions.
    console.log(chalk.dim('Guardrails:'), 'bash hard-block list active in both modes (SDK dispatch gate + CLI PreToolUse hook)');
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
  .option('--mode <mode>', "Filter by run mode: 'cli' (Claude Login) or 'sdk' (entries from before v0.6.0 count as sdk)")
  .option('--tool <name>', 'Filter by tool name (e.g. bash, computer, read_page)')
  .option('--failed', 'Only entries that did not complete ok')
  .option('--json', 'Emit the entries as a JSON array (each with its replay index)')
  .action(async (opts) => {
    const { readAuditEntries, summarizeEntry, filterAuditEntries } = await import('./audit-replay.js');
    if (opts.mode && opts.mode !== 'cli' && opts.mode !== 'sdk') {
      output.error(`Invalid --mode: ${opts.mode}. Choose 'cli' or 'sdk'.`);
      process.exit(1);
    }
    const entries = await readAuditEntries();
    const filtered = filterAuditEntries(entries, {
      mode: opts.mode,
      tool: opts.tool,
      failedOnly: !!opts.failed,
    });
    if (filtered.length === 0) {
      if (opts.json) {
        console.log('[]');
        return;
      }
      output.info(entries.length === 0
        ? 'No audit entries yet. Run `hands run "..."` to record some.'
        : `No entries match the filter (${entries.length} total).`);
      return;
    }
    const n = parseInt(opts.last, 10);
    const slice = filtered.slice(-n);
    if (opts.json) {
      console.log(JSON.stringify(slice.map(({ index, entry }) => ({ index, ...entry }))));
      return;
    }
    output.header(`Last ${slice.length} of ${filtered.length} matching entries (${entries.length} total)`);
    for (const { index, entry } of slice) {
      console.log(`  [${index}] ${summarizeEntry(entry)}`);
    }
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
    process.stdin.once('data', (c) => {
      chunks.push(c);
      // Pause stdin again or the still-flowing stream keeps the event
      // loop alive and the process hangs after "Replay complete."
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString());
    });
  });
}

// ── recipe ────────────────────────────────────────────────────────
const recipeCmd = program
  .command('recipe')
  .description('Save and manage reusable task recipes — run them with `hands run @name`');

recipeCmd
  .command('save <name> [prompt]')
  .description('Save a recipe: a single step from [prompt], or a pipeline with repeated --step.')
  .option('--step <prompt>', 'A pipeline step (repeatable). Steps chain in one session — Claude Login mode only.', collect, [])
  .option('--desc <text>', 'One-line description shown in `hands recipe list`.')
  .option('--persona <name>', 'Default persona to run the recipe under.')
  .option('--model <id>', 'Default model id for the recipe (an explicit -m on `run` still wins).')
  .option('--force', 'Overwrite an existing recipe of the same name.')
  .action(async (name, prompt, opts) => {
    const { saveRecipe, isValidRecipeName } = await import('./recipes.js');
    if (!isValidRecipeName(name)) {
      output.error(`Invalid recipe name "${name}". Use letters, digits, dashes, and underscores.`);
      process.exit(1);
    }
    const stepPrompts: string[] = (opts.step as string[]).map((s) => s.trim()).filter(Boolean);
    if (prompt && stepPrompts.length > 0) {
      output.error('Pass either a single [prompt] or one or more --step flags, not both.');
      process.exit(1);
    }
    const steps = stepPrompts.length > 0
      ? stepPrompts.map((p) => ({ prompt: p }))
      : (prompt ? [{ prompt: String(prompt).trim() }] : []);
    if (steps.length === 0) {
      output.error('Nothing to save. Give a prompt: hands recipe save <name> "<task>"  (or one or more --step).');
      process.exit(1);
    }
    try {
      const path = await saveRecipe({
        name,
        steps,
        ...(opts.desc ? { description: String(opts.desc) } : {}),
        ...(opts.persona ? { persona: String(opts.persona) } : {}),
        ...(opts.model ? { model: String(opts.model) } : {}),
      }, { force: !!opts.force });
      output.success(`saved recipe "${name}" (${steps.length} step${steps.length === 1 ? '' : 's'}) → ${path}`);
      output.info(`run it: hands run @${name}`);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

recipeCmd
  .command('list')
  .description('List saved recipes with step count and last-run status.')
  .option('--json', 'Emit recipes (with run state) as a JSON array.')
  .action(async (opts) => {
    const { listRecipes, loadRunState, renderRecipeList } = await import('./recipes.js');
    const recipes = await listRecipes();
    const state = await loadRunState();
    if (opts.json) {
      console.log(JSON.stringify(recipes.map((r) => ({ ...r, run: state[r.name] ?? null }))));
      return;
    }
    output.header(`Recipes (${recipes.length})`);
    console.log(renderRecipeList(recipes.map((r) => ({ recipe: r, state: state[r.name] })), Date.now()));
    if (recipes.length > 0) {
      console.log();
      output.info('Run one: hands run @<name>  ·  inspect: hands recipe show <name>');
    }
  });

recipeCmd
  .command('show <name>')
  .description('Show a recipe — its steps, defaults, params, and on-disk path.')
  .option('--json', 'Emit the parsed recipe as JSON.')
  .option('--raw', 'Print the raw .md file content.')
  .action(async (name, opts) => {
    const { loadRecipe, recipePath, loadRunState, applyParams } = await import('./recipes.js');
    try {
      if (opts.raw) {
        const { readFile } = await import('node:fs/promises');
        process.stdout.write(await readFile(recipePath(name), 'utf-8'));
        return;
      }
      const recipe = await loadRecipe(name);
      if (opts.json) {
        console.log(JSON.stringify(recipe, null, 2));
        return;
      }
      const params = applyParams(recipe, {}).missing;
      const runState = (await loadRunState())[name];
      output.header(`recipe: ${recipe.name}`);
      if (recipe.description) console.log(chalk.dim('Description:'), recipe.description);
      if (recipe.persona) console.log(chalk.dim('Persona:'), recipe.persona);
      if (recipe.model) console.log(chalk.dim('Model:'), recipe.model);
      if (params.length > 0) console.log(chalk.dim('Params:'), params.map((p) => `{{${p}}}`).join(' '), chalk.dim('(--set key=value)'));
      console.log(chalk.dim('File:'), recipePath(name));
      if (runState?.lastRunAt != null) {
        console.log(chalk.dim('Last run:'), new Date(runState.lastRunAt).toISOString(), runState.lastOk === false ? chalk.red('(failed)') : chalk.green('(ok)'));
      }
      console.log();
      recipe.steps.forEach((s, i) => {
        // Unnamed steps serialize as "## Step N" placeholders; don't echo that back as a label.
        const label = s.name && s.name !== `Step ${i + 1}` ? ` — ${s.name}` : '';
        console.log(chalk.cyan(`Step ${i + 1}${label}`));
        console.log(s.prompt.split('\n').map((l) => `  ${l}`).join('\n'));
        console.log();
      });
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

recipeCmd
  .command('rm <name>')
  .description('Delete a recipe.')
  .action(async (name) => {
    const { deleteRecipe } = await import('./recipes.js');
    try {
      await deleteRecipe(name);
      output.success(`deleted recipe "${name}"`);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

recipeCmd
  .command('path <name>')
  .description('Print the absolute path of a recipe file (for hand-editing).')
  .action(async (name) => {
    const { recipePath, isValidRecipeName } = await import('./recipes.js');
    if (!isValidRecipeName(name)) {
      output.error(`Invalid recipe name "${name}". Use letters, digits, dashes, and underscores.`);
      process.exit(1);
    }
    console.log(recipePath(name));
  });

// ── play / macro (crystallize) ──────────────────────────────────────
program
  .command('play <name>')
  .description('Replay a recorded macro deterministically — zero LLM calls, instant, free. (Record with `hands run --record <name>`.)')
  .option('--set <pair>', 'Fill a macro {{param}}: --set key=value (repeatable).', collect, [])
  .option('--dry-run', 'Print the steps without executing them.')
  .option('--export <file>', 'Compile the macro to a .sh / .ps1 script at <file> instead of replaying it.')
  .option('--stop-on-error', 'Halt on the first failing step (default: keep going).')
  .action(async (name, opts) => {
    const setParsed = parseSetPairs(opts.set);
    if (!setParsed.ok) {
      setParsed.errors.forEach((e) => output.error(e));
      process.exit(1);
    }
    if (opts.export) {
      const { loadMacro, macroToScript } = await import('./macros.js');
      const { writeFileSync } = await import('node:fs');
      try {
        const macro = await loadMacro(name);
        const { language, script, scriptable, manual } = macroToScript(macro);
        writeFileSync(opts.export, script, { mode: 0o755 });
        output.success(`exported "${name}" → ${opts.export}  (${language}: ${scriptable} scriptable, ${manual} manual)`);
        if (manual > 0) output.warn(`${manual} GUI step${manual === 1 ? '' : 's'} (clicks/keystrokes) aren't portably scriptable — commented out. Use \`hands play ${name}\` for full fidelity.`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
    const { playMacro } = await import('./macro-run.js');
    const res = await playMacro(name, {
      params: setParsed.params,
      dryRun: !!opts.dryRun,
      stopOnError: !!opts.stopOnError,
    });
    if (res.failed > 0) process.exitCode = 2;
  });

const macroCmd = program
  .command('macro')
  .description('Manage recorded macros (record with `hands run --record <name>`, replay with `hands play <name>`)');

macroCmd
  .command('list')
  .description('List recorded macros with step count and recording date.')
  .option('--json', 'Emit as a JSON array.')
  .action(async (opts) => {
    const { listMacros } = await import('./macros.js');
    const macros = await listMacros();
    if (opts.json) {
      console.log(JSON.stringify(macros));
      return;
    }
    output.header(`Macros (${macros.length})`);
    if (macros.length === 0) {
      output.info('None yet. Record one: hands run --record <name> "<task>"');
      return;
    }
    const w = Math.max(8, ...macros.map((m) => m.name.length));
    for (const m of macros) {
      const when = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : '—';
      const n = m.steps.length;
      console.log(`  ${m.name.padEnd(w)}  ${`${n} step${n === 1 ? '' : 's'}`.padEnd(9)}  ${when}${m.prompt ? `  — ${m.prompt.slice(0, 50)}` : ''}`);
    }
    console.log();
    output.info('Replay: hands play <name>  ·  script: hands play <name> --export <file>');
  });

macroCmd
  .command('show <name>')
  .description('Show a macro — its steps, source prompt, and on-disk path.')
  .option('--json', 'Emit the parsed macro as JSON.')
  .action(async (name, opts) => {
    const { loadMacro, macroPath, previewStep } = await import('./macros.js');
    try {
      const macro = await loadMacro(name);
      if (opts.json) {
        console.log(JSON.stringify(macro, null, 2));
        return;
      }
      output.header(`macro: ${macro.name}`);
      if (macro.prompt) console.log(chalk.dim('From:'), macro.prompt);
      if (macro.platform) console.log(chalk.dim('Platform:'), macro.platform);
      if (macro.createdAt) console.log(chalk.dim('Recorded:'), new Date(macro.createdAt).toISOString());
      console.log(chalk.dim('File:'), macroPath(name));
      console.log();
      macro.steps.forEach((s, i) => console.log(`  ${chalk.dim(`${i + 1}.`)} ${previewStep(s)}`));
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

macroCmd
  .command('rm <name>')
  .description('Delete a recorded macro.')
  .action(async (name) => {
    const { deleteMacro } = await import('./macros.js');
    try {
      await deleteMacro(name);
      output.success(`deleted macro "${name}"`);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

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

// parseAsync, not parse — every action here is async, and plain parse()
// leaves them as floating promises, so any throw (e.g. inquirer's
// ExitPromptError when the user hits Ctrl+C inside `hands auth`) became
// an unhandled-rejection crash with a stack trace.
program.parseAsync().catch((err: unknown) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.exit(130); // user cancelled an interactive prompt — quiet exit
  }
  output.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
