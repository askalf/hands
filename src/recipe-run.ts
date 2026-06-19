// Recipe execution — `hands run @name`.
//
// A recipe run is the documented `hands run --once` + `hands run -c --once`
// chain, automated: step 1 starts a session, steps 2..n resume it via
// `continueSession`, and the recipe halts the moment a step doesn't
// complete cleanly. We deliberately drive the existing `run()` per step
// rather than re-implement the agent loop — every guardrail, audit entry,
// persona path, and the dario routing stay exactly as a hand-run task.
//
// Session continuity is Claude Login (oauth) only — the conversation lives
// in the claude CLI's session store — so a multi-step recipe requires
// oauth mode. Single-step recipes run in whichever mode is configured.

import { loadConfig } from './util/config.js';
import { autoDetectDario } from './dario-detect.js';
import { run, EXIT_TASK_FAILED, type RunOptions } from './run.js';
import { loadRecipe, applyParams, recordRun, type Recipe } from './recipes.js';
import type { RunOverrides } from './util/cli-overrides.js';
import * as output from './util/output.js';

export interface RecipeRunOptions extends RunOptions {
  /** `--set key=value` params for `{{placeholder}}` substitution. */
  params?: Record<string, string> | undefined;
}

export async function runRecipe(name: string, options: RecipeRunOptions = {}): Promise<void> {
  let recipe: Recipe;
  try {
    recipe = await loadRecipe(name);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { recipe: applied, missing } = applyParams(recipe, options.params ?? {});
  if (missing.length) {
    const plural = missing.length === 1;
    output.error(`Recipe "${name}" needs ${plural ? 'a parameter' : 'parameters'}: ${missing.join(', ')}.`);
    output.info(`Provide ${plural ? 'it' : 'them'} with ${missing.map((m) => `--set ${m}=…`).join(' ')}`);
    process.exit(1);
  }

  const multi = applied.steps.length > 1;
  const config = await loadConfig();

  // Multi-step recipes chain through session continuity, which only
  // Claude Login (oauth) mode provides. Catch it before spending a turn.
  if (multi && config.authMode !== 'oauth') {
    output.error(
      `Recipe "${name}" has ${applied.steps.length} steps, which chain via session continuity — Claude Login mode only.`,
    );
    output.info('Switch with `hands auth`, or keep recipes single-step for SDK mode.');
    process.exit(1);
  }
  if (multi && options.dryRun) {
    output.error("--dry-run can't run a multi-step recipe — dry-run forces SDK mode, which has no session to chain steps through.");
    output.info('Dry-run a single-step recipe, or drop --dry-run.');
    process.exit(1);
  }
  if (multi && options.guard) {
    output.error("--guard can't run a multi-step recipe — it forces SDK mode, which can't chain steps via session continuity.");
    output.info('Guard a single-step recipe, or run the prompt directly: hands run --guard "<task>".');
    process.exit(1);
  }
  if (multi && options.warden) {
    output.error("--warden can't run a multi-step recipe — it forces SDK mode, which can't chain steps via session continuity.");
    output.info('Run warden on a single-step recipe, or run the prompt directly: hands run --warden "<task>".');
    process.exit(1);
  }

  // Detect dario once for the whole recipe; later steps inherit
  // ANTHROPIC_BASE_URL from the environment and skip the probe.
  const dario = await autoDetectDario({ disabled: !!options.noDario });
  if (dario.detected) output.info(dario.detail);

  output.header(`recipe: ${applied.name}${applied.description ? ` — ${applied.description}` : ''}`);

  const persona = options.persona ?? applied.persona;
  // Recipe frontmatter `model:` is a default; an explicit -m (options.overrides) wins.
  const overrides: RunOverrides | undefined =
    options.overrides ?? (applied.model ? { model: applied.model } : undefined);

  let ok = true;
  for (let i = 0; i < applied.steps.length; i++) {
    const step = applied.steps[i]!;
    const label = step.name ? `: ${step.name}` : '';
    output.info(`▶ step ${i + 1}/${applied.steps.length}${label}`);

    process.exitCode = 0;
    await run(step.prompt, {
      once: true,
      noDario: true, // already detected above
      continueSession: i > 0,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.json ? { json: options.json } : {}),
      ...(options.dryRun ? { dryRun: options.dryRun } : {}),
      ...(options.guard ? { guard: options.guard } : {}),
      ...(options.warden ? { warden: options.warden } : {}),
      ...(persona ? { persona } : {}),
      ...(overrides ? { overrides } : {}),
    });

    if (process.exitCode === EXIT_TASK_FAILED) {
      ok = false;
      output.error(`Step ${i + 1} did not complete cleanly — halting recipe "${name}".`);
      break;
    }
  }

  await recordRun(name, ok);
  if (ok) {
    const n = applied.steps.length;
    output.success(`recipe "${name}" complete (${n} step${n === 1 ? '' : 's'}).`);
  } else {
    process.exitCode = EXIT_TASK_FAILED;
  }
}
