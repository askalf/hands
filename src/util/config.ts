import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface VoiceOptions {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  silenceThresholdDb: number;
  silenceDurationMs: number;
}

/** Reasoning effort levels the `claude` CLI accepts for `--effort`. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

export interface AgentConfig {
  authMode: 'api_key' | 'oauth';
  apiKey?: string | undefined;
  model: string;
  /**
   * Reasoning effort for spawned `claude` children. Pinned rather than
   * inherited: without `--effort` the child picks up whatever the human's
   * interactive `effortLevel` happens to be, and thinking blocks are the
   * single largest contributor to a session's context — which is re-read
   * on every subsequent turn.
   */
  effort: EffortLevel;
  maxBudgetUsd: number;
  maxTurns: number;
  voice?: VoiceOptions;
  /** Auto-crystallize: promote 3×-repeated tasks into macros automatically. Default true; HANDS_NO_LEARN=1 also disables. */
  learn?: boolean;
}

const CONFIG_DIR = join(homedir(), '.hands');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: AgentConfig = {
  authMode: 'oauth',
  // claude-sonnet-5 (was claude-sonnet-4-6 — one generation behind). Verified
  // live in oauth mode before this change (real response, $0 via subscription).
  model: 'claude-sonnet-5',
  // Dispatch work is mostly mechanical; medium keeps thinking (and so the
  // per-turn context every later turn re-reads) down. Raise per-run with
  // `hands run --effort high`, or persist with `hands config --effort high`.
  effort: 'medium',
  maxBudgetUsd: 5.0,
  maxTurns: 50,
};

export async function loadConfig(): Promise<AgentConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: Partial<AgentConfig>): Promise<AgentConfig> {
  const current = await loadConfig();
  const merged = { ...current, ...config };
  // config.json can hold the Anthropic API key — owner-only on POSIX.
  // `mode` only applies at creation, so also chmod on every save to
  // repair dirs/files created by versions that didn't set it.
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      await chmod(CONFIG_DIR, 0o700);
      await chmod(CONFIG_PATH, 0o600);
    } catch {
      // Best-effort — never fail a config save over a perms repair.
    }
  }
  return merged;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
