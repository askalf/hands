import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface VoiceOptions {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  silenceThresholdDb: number;
  silenceDurationMs: number;
}

export interface AgentConfig {
  authMode: 'api_key' | 'oauth';
  apiKey?: string | undefined;
  model: string;
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
  model: 'claude-sonnet-4-6',
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
