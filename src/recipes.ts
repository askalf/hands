// Recipes — named, reusable, parameterized automations for `hands run`.
//
// v0.7.0 made hands scriptable (`hands run --once`, `hands run -c --once`
// to chain steps across invocations). Recipes are the library on top of
// that: a saved task — or an ordered pipeline of tasks — you can re-run by
// name. `hands run @deploy` resolves ~/.hands/recipes/deploy.md, substitutes
// any {{params}}, and runs each step. Multi-step recipes chain through the
// exact session-continuity machinery `hands run -c` already uses, so a
// recipe is just that flow automated.
//
// Storage mirrors personas (~/.hands/personas/<name>.md): a recipe is a
// markdown file at ~/.hands/recipes/<name>.md — human-readable, hand-
// editable, shareable. Optional YAML-ish frontmatter carries description /
// persona / model; `## headings` delimit steps; no headings = a single
// step from the whole body. Last-run metadata lives beside them in a
// sidecar .runs.json so the .md files stay clean and portable.
//
// This module is split into pure functions (parse / serialize / param
// substitution / validation / list rendering — all unit-tested without a
// filesystem) and the thin fs CRUD layer underneath.

import { readFile, writeFile, mkdir, readdir, unlink, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RecipeStep {
  /** Optional label — the `## heading` in the file. */
  name?: string | undefined;
  /** The natural-language task for this step. */
  prompt: string;
}

export interface Recipe {
  /** Canonical name = the filename (without .md). Frontmatter `name:` is ignored to avoid drift. */
  name: string;
  description?: string | undefined;
  steps: RecipeStep[];
  /** Default persona to run under (overridable by `--persona`). */
  persona?: string | undefined;
  /** Default model id (overridable by `-m`). */
  model?: string | undefined;
}

export interface RecipeRunRecord {
  /** Unix ms of the last run. */
  lastRunAt?: number | undefined;
  /** Whether the last run completed cleanly. */
  lastOk?: boolean | undefined;
  /** Total runs recorded. */
  runs?: number | undefined;
}

// ── pure: validation ────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_NAME_LEN = 64;

/**
 * A recipe name must be a single safe path segment: letters, digits,
 * dashes, underscores, starting alphanumeric, ≤64 chars. The regex
 * already excludes `/`, `\`, `.` and so `..` — the recipe name becomes
 * a filename, so this is the path-traversal guard. Pure.
 */
export function isValidRecipeName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LEN && NAME_RE.test(name);
}

// ── pure: parse ─────────────────────────────────────────────────────

/**
 * Split leading `---` frontmatter from the body. Minimal by design — we
 * refuse to pull in a YAML dependency (the security story rests on a
 * tiny dependency surface). Handles only flat `key: value` string pairs,
 * which is all a recipe needs. Pure.
 */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  // Frontmatter must open on the very first line.
  if (!/^---\r?\n/.test(content)) {
    return { meta, body: content };
  }
  const rest = content.replace(/^---\r?\n/, '');
  const close = rest.search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (close === -1) {
    // No closing fence — treat the whole thing as body, don't swallow it.
    return { meta, body: content };
  }
  const block = rest.slice(0, close);
  const body = rest.slice(close).replace(/^\r?\n---[ \t]*(\r?\n|$)/, '');
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // A double-quoted value is JSON-escaped by serializeRecipe — parse it
    // back fully (handles embedded quotes and backslashes). Fall back to a
    // naive strip if it isn't valid JSON (hand-authored files). Single
    // quotes are stripped literally.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body };
}

/**
 * Split a recipe body into steps. A line of the form `## Label` starts a
 * new step; the text beneath it (until the next heading) is that step's
 * prompt. No headings → one unnamed step from the whole body. Any text
 * before the first heading becomes an implicit leading step rather than
 * being silently dropped. Pure.
 */
export function splitSteps(body: string): RecipeStep[] {
  const lines = body.split(/\r?\n/);
  const steps: RecipeStep[] = [];
  const preamble: string[] = [];
  let current: { name: string; buf: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const prompt = current.buf.join('\n').trim();
    if (prompt) steps.push({ name: current.name, prompt });
    current = null;
  };

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = { name: (m[1] ?? '').trim(), buf: [] };
    } else if (current) {
      current.buf.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();

  if (steps.length === 0) {
    const prompt = body.trim();
    return prompt ? [{ prompt }] : [];
  }

  const lead = preamble.join('\n').trim();
  if (lead) steps.unshift({ prompt: lead });
  return steps;
}

/**
 * Parse a recipe file's content into a Recipe. The name is the caller's
 * canonical name (the filename), not the frontmatter — they can't drift
 * that way. Throws when there is no task content. Pure.
 */
export function parseRecipe(name: string, content: string): Recipe {
  const { meta, body } = parseFrontmatter(content);
  const steps = splitSteps(body);
  if (steps.length === 0) {
    throw new Error(`Recipe "${name}" has no task content — add a prompt or at least one "## step".`);
  }
  const recipe: Recipe = { name, steps };
  if (meta['description']) recipe.description = meta['description'];
  if (meta['persona']) recipe.persona = meta['persona'];
  if (meta['model']) recipe.model = meta['model'];
  return recipe;
}

// ── pure: serialize ─────────────────────────────────────────────────

function frontmatterValue(v: string): string {
  // Quote when the value could be misread as YAML, carries edge
  // whitespace, or contains a quote/backslash. JSON.stringify escapes
  // BOTH " and \ completely (a hand-rolled `"`→`\"` replace left
  // backslashes unescaped, so `a\` produced an unterminated string) and
  // round-trips exactly with the JSON.parse in parseFrontmatter.
  return /["\\:#]|^\s|\s$/.test(v) ? JSON.stringify(v) : v;
}

/**
 * Render a Recipe back to the markdown-with-frontmatter on-disk form.
 * Round-trips with parseRecipe. Pure.
 */
export function serializeRecipe(recipe: Recipe): string {
  const fm: string[] = [];
  if (recipe.description) fm.push(`description: ${frontmatterValue(recipe.description)}`);
  if (recipe.persona) fm.push(`persona: ${recipe.persona}`);
  if (recipe.model) fm.push(`model: ${recipe.model}`);
  const head = fm.length ? `---\n${fm.join('\n')}\n---\n\n` : '';

  const single = recipe.steps.length === 1 && !recipe.steps[0]?.name;
  let body: string;
  if (single) {
    body = `${recipe.steps[0]?.prompt.trim() ?? ''}\n`;
  } else {
    body = recipe.steps
      .map((s, i) => `## ${s.name ?? `Step ${i + 1}`}\n\n${s.prompt.trim()}\n`)
      .join('\n');
  }
  return head + body;
}

// ── pure: parameters ────────────────────────────────────────────────

/** `{{key}}` / `{{key=default}}`. Shared with macros (parameterize/params). */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:=([^}]*))?\}\}/g;

/**
 * Substitute `{{key}}` / `{{key=default}}` placeholders. Missing keys
 * (no value, no default) are returned in `missing` and left in place so
 * the rendered text shows what's unfilled. Substitution is pure string
 * interpolation into the prompt text — same trust level as typing the
 * prompt; it never reaches a shell. Pure.
 */
export function substituteParams(
  text: string,
  params: Record<string, string>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = text.replace(PLACEHOLDER_RE, (full: string, key: string, def: string | undefined): string => {
    if (Object.prototype.hasOwnProperty.call(params, key)) return params[key] ?? '';
    if (def !== undefined) return def;
    missing.add(key);
    return full;
  });
  return { text: out, missing: [...missing] };
}

/**
 * Apply parameters across every step prompt and the description.
 * Returns the substituted recipe and the union of all missing keys. Pure.
 */
export function applyParams(
  recipe: Recipe,
  params: Record<string, string>,
): { recipe: Recipe; missing: string[] } {
  const missing = new Set<string>();
  const sub = (t: string): string => {
    const r = substituteParams(t, params);
    r.missing.forEach((m) => missing.add(m));
    return r.text;
  };
  const steps = recipe.steps.map((s): RecipeStep => {
    const out: RecipeStep = { prompt: sub(s.prompt) };
    if (s.name) out.name = s.name;
    return out;
  });
  const applied: Recipe = { name: recipe.name, steps };
  if (recipe.description) applied.description = sub(recipe.description);
  if (recipe.persona) applied.persona = recipe.persona;
  if (recipe.model) applied.model = recipe.model;
  return { recipe: applied, missing: [...missing] };
}

// ── pure: CLI arg helpers ───────────────────────────────────────────

/**
 * Recognize a `hands run @name` recipe reference. Returns the bare name,
 * or null when `arg` isn't a recipe ref. `@@foo` escapes to a literal
 * prompt starting with `@`. Pure.
 */
export function parseRecipeRef(arg: string | undefined): string | null {
  if (!arg || arg[0] !== '@' || arg.startsWith('@@')) return null;
  const name = arg.slice(1).trim();
  return name.length > 0 ? name : null;
}

/**
 * Parse repeated `--set key=value` pairs into a params record. Collects
 * every problem so one retry fixes the lot. Pure.
 */
export function parseSetPairs(
  pairs: string[] | undefined,
): { ok: true; params: Record<string, string> } | { ok: false; errors: string[] } {
  const params: Record<string, string> = {};
  const errors: string[] = [];
  for (const p of pairs ?? []) {
    const eq = p.indexOf('=');
    if (eq <= 0) {
      errors.push(`Invalid --set "${p}". Expected key=value.`);
      continue;
    }
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1);
    if (!/^[a-zA-Z0-9_]+$/.test(key)) {
      errors.push(`Invalid --set key "${key}". Use letters, digits, and underscores.`);
      continue;
    }
    params[key] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, params };
}

// ── pure: list rendering ────────────────────────────────────────────

function relTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Render the `hands recipe list` table. `now` is injected so the
 * relative timestamps are testable. Pure.
 */
export function renderRecipeList(
  items: Array<{ recipe: Recipe; state?: RecipeRunRecord | undefined }>,
  now: number,
): string {
  if (items.length === 0) {
    return 'No recipes yet. Create one: hands recipe save <name> "<task>"';
  }
  const nameW = Math.max(8, ...items.map((it) => it.recipe.name.length));
  return items
    .map(({ recipe, state }) => {
      const n = recipe.steps.length;
      const steps = `${n} step${n === 1 ? '' : 's'}`;
      const last =
        state?.lastRunAt != null
          ? `last run ${relTime(now - state.lastRunAt)} ${state.lastOk === false ? '✖' : '✔'}`
          : 'never run';
      const desc = recipe.description ? `  — ${recipe.description}` : '';
      return `  ${recipe.name.padEnd(nameW)}  ${steps.padEnd(8)}  ${last}${desc}`;
    })
    .join('\n');
}

// ── fs: paths ───────────────────────────────────────────────────────

const RECIPES_DIR = join(homedir(), '.hands', 'recipes');
const RUN_STATE_PATH = join(RECIPES_DIR, '.runs.json');

export function getRecipesDir(): string {
  return RECIPES_DIR;
}

export function recipePath(name: string): string {
  return join(RECIPES_DIR, `${name}.md`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── fs: CRUD ────────────────────────────────────────────────────────

/** Read + parse a recipe by name. Throws with available names when missing. */
export async function loadRecipe(name: string): Promise<Recipe> {
  if (!isValidRecipeName(name)) {
    throw new Error(`Invalid recipe name "${name}". Use letters, digits, dashes, and underscores.`);
  }
  const path = recipePath(name);
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    const available = await listRecipeNames();
    const hint = available.length ? ` Available: ${available.join(', ')}.` : ' No recipes saved yet.';
    throw new Error(`Recipe "${name}" not found (looked at ${path}).${hint}`);
  }
  return parseRecipe(name, content);
}

/** Write a recipe to disk (0600 in the 0700 recipes dir). Refuses to clobber unless force. */
export async function saveRecipe(recipe: Recipe, opts: { force?: boolean } = {}): Promise<string> {
  if (!isValidRecipeName(recipe.name)) {
    throw new Error(`Invalid recipe name "${recipe.name}". Use letters, digits, dashes, and underscores.`);
  }
  const path = recipePath(recipe.name);
  if (!opts.force && (await fileExists(path))) {
    throw new Error(`Recipe "${recipe.name}" already exists. Pass --force to overwrite, or pick another name.`);
  }
  await mkdir(RECIPES_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, serializeRecipe(recipe), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      await chmod(RECIPES_DIR, 0o700);
      await chmod(path, 0o600);
    } catch {
      // Best-effort perms repair — never fail a save over it.
    }
  }
  return path;
}

/** Delete a recipe. Throws if it doesn't exist. */
export async function deleteRecipe(name: string): Promise<void> {
  if (!isValidRecipeName(name)) {
    throw new Error(`Invalid recipe name "${name}".`);
  }
  const path = recipePath(name);
  try {
    await unlink(path);
  } catch {
    throw new Error(`Recipe "${name}" not found (looked at ${path}).`);
  }
}

/** List valid recipe names (sorted). Silent empty array when the dir is absent. */
export async function listRecipeNames(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(RECIPES_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter(isValidRecipeName)
    .sort((a, b) => a.localeCompare(b));
}

/** Load and parse every recipe. Unparseable files are skipped, not fatal. */
export async function listRecipes(): Promise<Recipe[]> {
  const names = await listRecipeNames();
  const out: Recipe[] = [];
  for (const name of names) {
    try {
      out.push(await loadRecipe(name));
    } catch {
      // A malformed file shouldn't break `recipe list`.
    }
  }
  return out;
}

// ── fs: run-state sidecar ───────────────────────────────────────────

export async function loadRunState(): Promise<Record<string, RecipeRunRecord>> {
  try {
    const raw = await readFile(RUN_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, RecipeRunRecord>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Record the outcome of a recipe run in the sidecar. Best-effort like the
 * audit log — a write failure logs to stderr and is swallowed so a
 * bookkeeping error never fails the run that already happened.
 */
export async function recordRun(name: string, ok: boolean): Promise<void> {
  try {
    const state = await loadRunState();
    const prev = state[name] ?? {};
    state[name] = { lastRunAt: Date.now(), lastOk: ok, runs: (prev.runs ?? 0) + 1 };
    await mkdir(RECIPES_DIR, { recursive: true, mode: 0o700 });
    await writeFile(RUN_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[hands.recipes] run-state save failed: ${msg}\n`);
  }
}
