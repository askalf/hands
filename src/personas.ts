import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Personas — named system prompt overrides for `hands run`.
 *
 * Why this exists: dario research (askalf/dario#172) confirmed that
 * Anthropic's billing classifier doesn't fingerprint the system
 * prompt content — content, length, and block count are not
 * classifier inputs as long as the rest of the request shape is
 * preserved. Combined with hands routing through dario for OAuth
 * subscription billing, that means hands users can replace hands'
 * default system prompt with anything they want and keep five_hour
 * billing. Personas are the operator-facing surface for that.
 *
 * Resolution order for `hands run --persona <name>`:
 *   1. ~/.hands/personas/<name>.md   (user override; takes precedence)
 *   2. one of the bundled personas below
 *   3. error: persona '<name>' not found
 *
 * The default behavior (no --persona, no --system-prompt) is
 * unchanged — hands' built-in OS-aware prompt from system-prompt.ts.
 *
 * Resolution order for `hands run --system-prompt <path>`:
 *   - the file at <path>, period. Bypasses --persona and the
 *     bundled set. For one-off / external prompts.
 *
 * Both flags only affect SDK mode (the API-key / dario-routed
 * path). CLI mode (Claude Login spawning `claude`) doesn't pass
 * them through — adding them there is a future PR.
 */

export interface PersonaResolution {
  /** The system prompt text to use. */
  prompt: string;
  /** Where the prompt came from, for `[persona]` log line. */
  source: 'bundled' | 'user-file' | 'explicit-path';
  /** Persona name (when known) or absolute file path (for explicit-path). */
  label: string;
}

/**
 * Bundled personas. Names are kebab-case for CLI ergonomics.
 *
 * Each prompt is intentionally short — the dario research showed
 * the model's *capability ceiling* is in the weights, not the
 * prompt; the prompt's job is to set defaults (verbosity, tool
 * orchestration mode, autonomy) without padding.
 */
const BUNDLED: Record<string, string> = {
  minimal: `You are a computer control agent. The user can give you tasks involving the bash tool, the computer tool, and the str_replace_based_edit_tool. Help them complete their tasks. Use tools when they're useful, answer directly when they're not.`,

  thorough: `You are a computer control agent.

Take initiative. When a task is ambiguous, pick the most reasonable interpretation and proceed; don't ask for confirmation on routine decisions.

Be exhaustive. When the user asks for code, include thorough comments explaining the reasoning, edge cases, and tradeoffs. When they ask for a plan, walk through it step by step with timing, rollback considerations, and risk assessment.

Use the bash tool, computer tool, or str_replace_based_edit_tool as needed. Combine multiple steps into single shell commands when you can.`,

  concise: `You are a computer control agent. Be terse. Answer in one or two sentences when the question is short. Use the bash tool, computer tool, or str_replace_based_edit_tool as appropriate. No preamble, no summary at the end.`,

  'security-aware': `You are a computer control agent operating on a personal workstation.

Before any destructive shell command (rm, mv to overwrite, kill, format, registry edit, system-config change), pause and explain what you're about to do, why, and what would happen if you got it wrong. Then proceed if the user confirms.

Read-only investigation (ls, cat, grep, ps, get-process, etc.) doesn't need confirmation. Tool calls that take screenshots or move the mouse without clicking don't need confirmation either. The threshold is: "could this break something the user can't undo in one minute?"

Use the bash tool, computer tool, or str_replace_based_edit_tool as needed.`,
};

/**
 * Resolve a persona name to its prompt text. Checks user overrides
 * first, then bundled. Throws if not found.
 */
export async function resolvePersona(name: string): Promise<PersonaResolution> {
  // User override — ~/.hands/personas/<name>.md takes precedence.
  const userPath = join(homedir(), '.hands', 'personas', `${name}.md`);
  try {
    const content = await readFile(userPath, 'utf-8');
    return { prompt: content.trim(), source: 'user-file', label: name };
  } catch { /* fall through to bundled */ }

  if (name in BUNDLED) {
    return { prompt: BUNDLED[name]!, source: 'bundled', label: name };
  }

  const known = listBundledNames().join(', ');
  throw new Error(
    `Persona '${name}' not found. Looked at ${userPath} (no such file) and the bundled set [${known}]. ` +
      `Add a ~/.hands/personas/${name}.md or pick one of the bundled names.`,
  );
}

/**
 * Resolve a path to a system prompt file. Bypasses persona lookup.
 */
export async function resolveSystemPromptFile(path: string): Promise<PersonaResolution> {
  const content = await readFile(path, 'utf-8');
  return { prompt: content.trim(), source: 'explicit-path', label: path };
}

/**
 * The list of bundled persona names. Exported for use in error
 * messages and `hands persona ls` (when that command lands).
 */
export function listBundledNames(): string[] {
  return Object.keys(BUNDLED);
}
