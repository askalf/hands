// Fuzz the recipe layer — recipes are user-authored files parsed by a
// deliberately hand-rolled frontmatter/step splitter (no YAML dependency; the
// security story rests on a tiny parse surface). Contracts pinned here:
// parseFrontmatter/splitSteps are pure and never throw, returning flat
// string→string meta and well-formed steps; parseRecipe returns a well-formed
// Recipe or throws a plain Error (only for empty task content); a Recipe that
// parsed must serialize to a string that parses again (serializeRecipe
// round-trip); and isValidRecipeName — the path-traversal guard, recipe names
// become filenames — never accepts a separator, a dot, or an oversized name.
import {
  isValidRecipeName,
  parseFrontmatter,
  splitSteps,
  parseRecipe,
  serializeRecipe,
} from '../dist/recipes.js';

export function fuzz(data) {
  const s = data.toString('utf8');

  const valid = isValidRecipeName(s);
  if (typeof valid !== 'boolean') throw new Error('isValidRecipeName returned a non-boolean');
  if (valid && (/[/\\.]/.test(s) || s.length > 64)) {
    throw new Error(`path-traversal guard accepted ${JSON.stringify(s.slice(0, 80))}`);
  }

  const { meta, body } = parseFrontmatter(s);
  if (typeof body !== 'string') throw new Error('parseFrontmatter body is not a string');
  for (const [k, v] of Object.entries(meta)) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      throw new Error('parseFrontmatter meta is not flat string→string');
    }
  }

  const steps = splitSteps(body);
  if (!Array.isArray(steps)) throw new Error('splitSteps returned a non-array');
  for (const st of steps) {
    if (!st || typeof st.prompt !== 'string' || (st.name !== undefined && typeof st.name !== 'string')) {
      throw new Error('splitSteps produced a malformed step');
    }
  }

  let recipe;
  try {
    recipe = parseRecipe('fuzz-recipe', s);
  } catch (e) {
    if (!(e instanceof Error)) throw new Error(`parseRecipe threw a non-Error: ${typeof e}`);
    return; // rejecting content with no steps is the contract
  }
  if (recipe.name !== 'fuzz-recipe' || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new Error('parseRecipe returned a malformed Recipe');
  }
  const out = serializeRecipe(recipe);
  if (typeof out !== 'string') throw new Error('serializeRecipe returned a non-string');
  parseRecipe('fuzz-recipe', out); // must reparse without throwing
}
