import { EFFORT_LEVELS, type AgentConfig, type EffortLevel } from './config.js';

export type RunOverrides = Partial<Pick<AgentConfig, 'model' | 'effort' | 'maxBudgetUsd' | 'maxTurns'>>;

export interface OverrideParseResult {
  ok: boolean;
  overrides: RunOverrides;
  errors: string[];
}

/**
 * Validate the raw -m / -b / -t flag strings shared by `hands run` and
 * `hands config`. Pure — exported for tests.
 *
 * Collects every problem instead of stopping at the first, so one
 * retry fixes the whole invocation. Rejections matter because these
 * values can end up persisted: a previous version wrote
 * `parseFloat("abc")` (NaN → JSON null) straight into config.json,
 * which crashed every subsequent SDK run until the file was
 * hand-edited.
 */
export function parseOverrides(raw: { model?: string; effort?: string; budget?: string; turns?: string }): OverrideParseResult {
  const overrides: RunOverrides = {};
  const errors: string[] = [];

  if (raw.model !== undefined) {
    overrides.model = raw.model;
  }
  if (raw.effort !== undefined) {
    // Validated against the allowlist rather than passed through: an
    // unknown level makes the `claude` child exit before a single turn,
    // and persisting it would break every later run the same way.
    if ((EFFORT_LEVELS as readonly string[]).includes(raw.effort)) {
      overrides.effort = raw.effort as EffortLevel;
    } else {
      errors.push(`--effort must be one of ${EFFORT_LEVELS.join(', ')}, got "${raw.effort}"`);
    }
  }
  if (raw.budget !== undefined) {
    const budget = Number(raw.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      errors.push(`--budget must be a positive number, got "${raw.budget}"`);
    } else {
      overrides.maxBudgetUsd = budget;
    }
  }
  if (raw.turns !== undefined) {
    const turns = Number(raw.turns);
    if (!Number.isInteger(turns) || turns <= 0) {
      errors.push(`--turns must be a positive integer, got "${raw.turns}"`);
    } else {
      overrides.maxTurns = turns;
    }
  }

  return { ok: errors.length === 0, overrides, errors };
}
