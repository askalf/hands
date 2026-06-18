// Tests for src/recipes.ts — the recipe model behind `hands run @name`.
//
// Pure functions (validation, frontmatter/step parsing, serialize round-
// trip, param substitution, CLI-arg helpers, list rendering) are tested
// directly. The fs CRUD + run-state layer points at a throwaway HOME set
// BEFORE the dynamic import, because the recipes dir is computed from
// homedir() at module-load time (same pattern as util/audit.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect HOME before importing — getRecipesDir() bakes from homedir().
const testHome = mkdtempSync(join(tmpdir(), 'hands-recipes-test-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.HOMEDRIVE = '';
process.env.HOMEPATH = '';

const {
  isValidRecipeName,
  parseFrontmatter,
  splitSteps,
  parseRecipe,
  serializeRecipe,
  substituteParams,
  applyParams,
  parseRecipeRef,
  parseSetPairs,
  renderRecipeList,
  // fs
  getRecipesDir,
  recipePath,
  saveRecipe,
  loadRecipe,
  deleteRecipe,
  listRecipeNames,
  listRecipes,
  loadRunState,
  recordRun,
} = await import('../dist/recipes.js');

after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
});

// ── isValidRecipeName ───────────────────────────────────────────────

test('isValidRecipeName — accepts safe single-segment names', () => {
  for (const ok of ['deploy', 'my-recipe', 'a_b', 'Recipe1', 'x', 'a1-b2_c3']) {
    assert.equal(isValidRecipeName(ok), true, `${ok} should be valid`);
  }
});

test('isValidRecipeName — rejects traversal, separators, and bad shapes', () => {
  for (const bad of ['', '..', '../etc', 'a/b', 'a\\b', 'a.b', '-leading', '_leading', 'has space', 'a'.repeat(65), '@at']) {
    assert.equal(isValidRecipeName(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

// ── parseFrontmatter ────────────────────────────────────────────────

test('parseFrontmatter — extracts flat key: value pairs and strips the block from the body', () => {
  const { meta, body } = parseFrontmatter('---\ndescription: do a thing\npersona: thorough\n---\n\nbody text\n');
  assert.equal(meta.description, 'do a thing');
  assert.equal(meta.persona, 'thorough');
  assert.equal(body.trim(), 'body text');
});

test('parseFrontmatter — strips one layer of matching quotes', () => {
  const { meta } = parseFrontmatter('---\ndescription: "quoted: with colon"\n---\nx');
  assert.equal(meta.description, 'quoted: with colon');
});

test('parseFrontmatter — no frontmatter returns empty meta and full body', () => {
  const { meta, body } = parseFrontmatter('just a prompt');
  assert.deepEqual(meta, {});
  assert.equal(body, 'just a prompt');
});

test('parseFrontmatter — unterminated fence is treated as body, not swallowed', () => {
  const input = '---\ndescription: oops\nno closing fence here';
  const { meta, body } = parseFrontmatter(input);
  assert.deepEqual(meta, {});
  assert.equal(body, input);
});

// ── splitSteps ──────────────────────────────────────────────────────

test('splitSteps — no headings yields one unnamed step from the whole body', () => {
  const steps = splitSteps('open notepad and type hello');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, undefined);
  assert.equal(steps[0].prompt, 'open notepad and type hello');
});

test('splitSteps — ## headings delimit named steps', () => {
  const steps = splitSteps('## pull\n\ngit pull main\n\n## test\n\nrun the tests\n');
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.name), ['pull', 'test']);
  assert.equal(steps[0].prompt, 'git pull main');
  assert.equal(steps[1].prompt, 'run the tests');
});

test('splitSteps — text before the first heading becomes an implicit leading step', () => {
  const steps = splitSteps('do the prep\n\n## build\n\nbuild it');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].name, undefined);
  assert.equal(steps[0].prompt, 'do the prep');
  assert.equal(steps[1].name, 'build');
});

test('splitSteps — empty body yields no steps', () => {
  assert.deepEqual(splitSteps('   \n\n  '), []);
});

// ── parseRecipe ─────────────────────────────────────────────────────

test('parseRecipe — single-step with frontmatter', () => {
  const r = parseRecipe('greet', '---\ndescription: say hi\nmodel: claude-opus-4-6\n---\n\nopen notepad and type {{name}}\n');
  assert.equal(r.name, 'greet');
  assert.equal(r.description, 'say hi');
  assert.equal(r.model, 'claude-opus-4-6');
  assert.equal(r.steps.length, 1);
  assert.match(r.steps[0].prompt, /\{\{name\}\}/);
});

test('parseRecipe — name comes from the caller, not frontmatter (no drift)', () => {
  const r = parseRecipe('canonical', '---\nname: something-else\n---\nbody');
  assert.equal(r.name, 'canonical');
});

test('parseRecipe — throws on empty content', () => {
  assert.throws(() => parseRecipe('empty', '---\ndescription: x\n---\n\n   '), /no task content/);
});

// ── serializeRecipe round-trip ──────────────────────────────────────

test('serializeRecipe — single-step round-trips through parseRecipe', () => {
  const original = { name: 'r', description: 'a desc', steps: [{ prompt: 'do a thing' }] };
  const reparsed = parseRecipe('r', serializeRecipe(original));
  assert.equal(reparsed.description, 'a desc');
  assert.equal(reparsed.steps.length, 1);
  assert.equal(reparsed.steps[0].prompt, 'do a thing');
});

test('serializeRecipe — multi-step with names + persona round-trips', () => {
  const original = {
    name: 'pipe',
    persona: 'thorough',
    steps: [{ name: 'one', prompt: 'first' }, { name: 'two', prompt: 'second' }],
  };
  const text = serializeRecipe(original);
  assert.match(text, /## one/);
  assert.match(text, /## two/);
  const reparsed = parseRecipe('pipe', text);
  assert.equal(reparsed.persona, 'thorough');
  assert.deepEqual(reparsed.steps.map((s) => s.name), ['one', 'two']);
  assert.deepEqual(reparsed.steps.map((s) => s.prompt), ['first', 'second']);
});

test('serializeRecipe — description with a colon is quoted so it round-trips', () => {
  const text = serializeRecipe({ name: 'r', description: 'pull: then push', steps: [{ prompt: 'x' }] });
  assert.equal(parseRecipe('r', text).description, 'pull: then push');
});

// ── substituteParams ────────────────────────────────────────────────

test('substituteParams — fills present keys', () => {
  const { text, missing } = substituteParams('hello {{name}}', { name: 'World' });
  assert.equal(text, 'hello World');
  assert.deepEqual(missing, []);
});

test('substituteParams — uses {{key=default}} when the key is absent', () => {
  const { text, missing } = substituteParams('env={{env=prod}}', {});
  assert.equal(text, 'env=prod');
  assert.deepEqual(missing, []);
});

test('substituteParams — reports missing keys and leaves the placeholder intact', () => {
  const { text, missing } = substituteParams('{{a}} and {{b}}', { a: '1' });
  assert.equal(text, '1 and {{b}}');
  assert.deepEqual(missing, ['b']);
});

test('substituteParams — explicit param overrides a default', () => {
  const { text } = substituteParams('{{env=prod}}', { env: 'staging' });
  assert.equal(text, 'staging');
});

// ── applyParams ─────────────────────────────────────────────────────

test('applyParams — substitutes across all steps and the description; unions missing', () => {
  const recipe = {
    name: 'r',
    description: 'deploy to {{env}}',
    model: 'claude-sonnet-4-6',
    steps: [{ name: 's1', prompt: 'build {{app}}' }, { prompt: 'ship {{app}} to {{env}}' }],
  };
  const { recipe: applied, missing } = applyParams(recipe, { app: 'api' });
  assert.equal(applied.description, 'deploy to {{env}}');
  assert.equal(applied.steps[0].prompt, 'build api');
  assert.equal(applied.steps[1].prompt, 'ship api to {{env}}');
  assert.equal(applied.steps[0].name, 's1');
  assert.equal(applied.model, 'claude-sonnet-4-6', 'model default is preserved');
  assert.deepEqual(missing, ['env']);
});

// ── parseRecipeRef ──────────────────────────────────────────────────

test('parseRecipeRef — @name → name, @@foo and plain text → null', () => {
  assert.equal(parseRecipeRef('@deploy'), 'deploy');
  assert.equal(parseRecipeRef('@my-recipe'), 'my-recipe');
  assert.equal(parseRecipeRef('@@literal'), null, 'doubled @ escapes to a literal prompt');
  assert.equal(parseRecipeRef('open notepad'), null);
  assert.equal(parseRecipeRef('@'), null);
  assert.equal(parseRecipeRef('@   '), null, 'whitespace-only after @ is not a ref');
  assert.equal(parseRecipeRef(undefined), null);
});

// ── parseSetPairs ───────────────────────────────────────────────────

test('parseSetPairs — parses key=value, keeps = inside the value', () => {
  const r = parseSetPairs(['env=prod', 'token=a=b=c']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, { env: 'prod', token: 'a=b=c' });
});

test('parseSetPairs — empty/undefined yields no params', () => {
  assert.deepEqual(parseSetPairs(undefined), { ok: true, params: {} });
  assert.deepEqual(parseSetPairs([]), { ok: true, params: {} });
});

test('parseSetPairs — collects every malformed pair', () => {
  const r = parseSetPairs(['noequals', '=leadingeq', 'bad key=1', 'good=ok']);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3, `expected 3 errors, got ${JSON.stringify(r.errors)}`);
});

// ── renderRecipeList ────────────────────────────────────────────────

test('renderRecipeList — empty shows the create hint', () => {
  assert.match(renderRecipeList([], 1_000_000), /No recipes yet/);
});

test('renderRecipeList — renders name, step count, and last-run state', () => {
  const now = 1_000_000_000_000;
  const out = renderRecipeList([
    { recipe: { name: 'deploy', steps: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }, state: { lastRunAt: now - 120_000, lastOk: true } },
    { recipe: { name: 'morning', steps: [{ prompt: 'a' }] }, state: undefined },
  ], now);
  assert.match(out, /deploy/);
  assert.match(out, /3 steps/);
  assert.match(out, /2m ago/);
  assert.match(out, /morning/);
  assert.match(out, /1 step\b/);
  assert.match(out, /never run/);
});

// ── fs: CRUD round-trip (against the redirected HOME) ────────────────

test('getRecipesDir — lives under the redirected HOME', () => {
  assert.ok(getRecipesDir().startsWith(testHome), `expected dir under ${testHome}, got ${getRecipesDir()}`);
});

test('saveRecipe + loadRecipe — single-step round-trip', async () => {
  const path = await saveRecipe({ name: 'rt-single', description: 'd', steps: [{ prompt: 'open notepad' }] });
  assert.equal(path, recipePath('rt-single'));
  const loaded = await loadRecipe('rt-single');
  assert.equal(loaded.description, 'd');
  assert.equal(loaded.steps[0].prompt, 'open notepad');
});

test('saveRecipe + loadRecipe — multi-step round-trip', async () => {
  await saveRecipe({ name: 'rt-multi', steps: [{ prompt: 'one' }, { prompt: 'two' }] });
  const loaded = await loadRecipe('rt-multi');
  assert.equal(loaded.steps.length, 2);
});

test('saveRecipe — refuses to clobber without force, allows with force', async () => {
  await saveRecipe({ name: 'clobber', steps: [{ prompt: 'first' }] });
  await assert.rejects(() => saveRecipe({ name: 'clobber', steps: [{ prompt: 'second' }] }), /already exists/);
  await saveRecipe({ name: 'clobber', steps: [{ prompt: 'second' }] }, { force: true });
  assert.equal((await loadRecipe('clobber')).steps[0].prompt, 'second');
});

test('saveRecipe — rejects an invalid name (no traversal onto disk)', async () => {
  await assert.rejects(() => saveRecipe({ name: '../escape', steps: [{ prompt: 'x' }] }), /Invalid recipe name/);
});

test('loadRecipe — missing recipe throws with a not-found message', async () => {
  await assert.rejects(() => loadRecipe('does-not-exist'), /not found/);
});

test('loadRecipe — invalid name is rejected before any fs access', async () => {
  await assert.rejects(() => loadRecipe('../../etc/passwd'), /Invalid recipe name/);
});

test('listRecipeNames / listRecipes — sorted, ignores non-.md and the run-state sidecar', async () => {
  const dir = getRecipesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'zeta.md'), 'last alphabetically');
  writeFileSync(join(dir, 'alpha.md'), 'first');
  writeFileSync(join(dir, 'notes.txt'), 'not a recipe');
  const names = await listRecipeNames();
  assert.ok(names.includes('alpha') && names.includes('zeta'));
  assert.ok(!names.includes('notes'), 'non-.md ignored');
  assert.ok(!names.includes('.runs'), 'sidecar ignored');
  assert.deepEqual([...names].sort(), names, 'names are sorted');
  const recipes = await listRecipes();
  assert.ok(recipes.some((r) => r.name === 'alpha'));
});

test('deleteRecipe — removes the file; deleting a missing recipe throws', async () => {
  await saveRecipe({ name: 'to-delete', steps: [{ prompt: 'x' }] });
  await deleteRecipe('to-delete');
  await assert.rejects(() => loadRecipe('to-delete'), /not found/);
  await assert.rejects(() => deleteRecipe('to-delete'), /not found/);
});

test('recordRun + loadRunState — tracks lastOk and increments the run count', async () => {
  await saveRecipe({ name: 'tracked', steps: [{ prompt: 'x' }] });
  await recordRun('tracked', true);
  await recordRun('tracked', false);
  const state = await loadRunState();
  assert.equal(state.tracked.runs, 2);
  assert.equal(state.tracked.lastOk, false);
  assert.ok(typeof state.tracked.lastRunAt === 'number');
});
