import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import * as output from './util/output.js';
import type { AgentConfig } from './util/config.js';
import { VoiceInput } from './voice/index.js';
import { buildCliSystemPrompt, normalizePlatform, type SupportedPlatform } from './system-prompt.js';
import { resolveClaudeInvocation } from './platform/claude-cli.js';
import type { PersonaResolution } from './personas.js';

interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

interface SessionMemory {
  history: Array<{
    task: string;
    result: string;
    turns: number;
    success: boolean;
  }>;
  lessons: string[];
}

export interface CliModeOptions {
  voice?: boolean | undefined;
  /** When set, replaces the default OS-aware system-prompt content with the persona's text. The persona prompt is still appended via `claude --append-system-prompt`, so it stacks on Claude Code's built-in prompt rather than replacing it (CLI mode has no hook to fully replace). Session context (history + lessons) is preserved either way. */
  persona?: PersonaResolution | undefined;
}

/**
 * Compose the string we hand to `claude --append-system-prompt`.
 * Pure function — pulled out of `spawnClaude` so the persona-vs-default
 * branching is unit-testable without spawning a child process.
 *
 * Two paths:
 *   - No persona: hands' default OS-aware prompt + session context
 *     (existing behavior, unchanged).
 *   - Persona set: persona prompt + session context. The OS-aware
 *     block is dropped on the operator's behalf — the persona is the
 *     statement of intent, and Claude Code's built-in prompt already
 *     covers basic computer-use orchestration.
 */
export function composeCliAppendPrompt(
  platform: SupportedPlatform,
  sessionContext: string,
  persona: PersonaResolution | undefined,
): string {
  if (!persona) {
    return buildCliSystemPrompt(platform, sessionContext);
  }
  return sessionContext ? `${persona.prompt}\n\n${sessionContext}` : persona.prompt;
}

export async function runCliMode(prompt: string, config: AgentConfig, options: CliModeOptions = {}): Promise<RunResult> {
  output.header('AskAlf Agent — Computer Control');
  output.info('Using Claude subscription (no per-token costs)');
  if (options.voice) {
    output.info('Voice mode enabled — speak your commands');
  }
  output.info('Type "exit" or Ctrl+C to quit\n');

  const voiceInput = options.voice ? new VoiceInput(config.voice) : null;

  // Write MCP config pointing to our stdio server
  const mcpConfigPath = join(tmpdir(), `askalf-mcp-${randomBytes(4).toString('hex')}.json`);
  const mcpServerPath = resolve(import.meta.dirname, 'mcp-server.js');

  const mcpConfig = {
    mcpServers: {
      'askalf-computer': {
        command: 'node',
        args: [mcpServerPath],
      },
    },
  };

  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let totalTurns = 0;
  let currentPrompt = prompt;
  const sessionMemory: SessionMemory = { history: [], lessons: [] };

  try {
    // Interactive loop
    while (true) {
      output.info(`\n→ ${currentPrompt}\n`);

      const result = await spawnClaude(currentPrompt, config, mcpConfigPath, sessionMemory, options.persona);
      totalTurns += result.turns;

      // Record what happened for future turns
      sessionMemory.history.push({
        task: currentPrompt,
        result: result.text.slice(0, 200),
        turns: result.turns,
        success: result.turns < config.maxTurns && !!result.text,
      });

      // If it took too many turns, record as a lesson
      if (result.turns > 10) {
        sessionMemory.lessons.push(
          `Task "${currentPrompt}" took ${result.turns} turns — look for a more direct approach next time.`,
        );
      }

      if (result.text) {
        output.success(result.text.length > 500 ? result.text.slice(0, 500) + '...' : result.text);
      }

      output.info(`(${result.turns} turns)\n`);

      // Prompt for next task
      let next: string;
      if (voiceInput) {
        console.log('\x1b[36m❯ What next?\x1b[0m');
        try {
          next = await voiceInput.listen();
        } catch {
          output.warn('Voice input failed, falling back to keyboard');
          next = await new Promise<string>((res) => {
            rl.question('\x1b[36m❯ What next? (keyboard)\x1b[0m ', (answer) => {
              res(answer.trim());
            });
          });
        }
      } else {
        next = await new Promise<string>((res) => {
          rl.question('\x1b[36m❯ What next?\x1b[0m ', (answer) => {
            res(answer.trim());
          });
        });
      }

      if (!next || next.toLowerCase() === 'exit' || next.toLowerCase() === 'quit') {
        output.info('Session ended.');
        break;
      }

      currentPrompt = next;
    }
  } catch (err) {
    // Handle Ctrl+C gracefully
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      output.info('\nSession ended.');
    } else {
      throw err;
    }
  } finally {
    rl.close();
    try { await unlink(mcpConfigPath); } catch { /* ignore */ }
  }

  return {
    text: 'Session ended',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: totalTurns,
  };
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(label: string) {
  let frame = 0;
  let currentLabel = label;
  let elapsed = 0;
  const startTime = Date.now();

  const interval = setInterval(() => {
    elapsed = Math.floor((Date.now() - startTime) / 1000);
    const spinner = chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    const time = chalk.dim(`${elapsed}s`);
    process.stderr.write(`\r${spinner} ${chalk.white(currentLabel)} ${time}  `);
    frame++;
  }, 80);

  return {
    update(newLabel: string) {
      currentLabel = newLabel;
    },
    stop() {
      clearInterval(interval);
      process.stderr.write('\r' + ' '.repeat(80) + '\r'); // clear line
    },
  };
}

function buildSessionContext(memory: SessionMemory): string {
  const parts: string[] = [];

  if (memory.history.length > 0) {
    const recent = memory.history.slice(-5); // last 5 tasks
    parts.push('## Session History (previous tasks in this session)');
    for (const h of recent) {
      parts.push(`- Task: "${h.task}" → ${h.success ? 'SUCCESS' : 'FAILED'} (${h.turns} turns): ${h.result}`);
    }
  }

  if (memory.lessons.length > 0) {
    parts.push('');
    parts.push('## Lessons Learned This Session — DO NOT REPEAT PAST MISTAKES');
    for (const l of memory.lessons) {
      parts.push(`- ${l}`);
    }
  }

  return parts.join('\n');
}

async function spawnClaude(prompt: string, config: AgentConfig, mcpConfigPath: string, memory: SessionMemory, persona: PersonaResolution | undefined): Promise<RunResult> {
  const invocation = await resolveClaudeInvocation();
  return new Promise((resolvePromise, reject) => {
    const sessionContext = buildSessionContext(memory);
    const systemPrompt = composeCliAppendPrompt(normalizePlatform(process.platform), sessionContext, persona);

    const args = [
      ...invocation.prefixArgs,
      '-p', prompt,
      '--append-system-prompt', systemPrompt,
      '--output-format', 'json',
      '--max-turns', String(config.maxTurns),
      '--mcp-config', mcpConfigPath,
      '--dangerously-skip-permissions',
    ];

    const child = spawn(invocation.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDECODE: '',
      },
    });

    const spinner = createSpinner('Thinking...');
    let stdout = '';
    let actionCount = 0;

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      for (const segment of line.split('\n')) {
        const s = segment.trim();
        if (!s) continue;

        // Detect tool use and update spinner with action context
        if (s.includes('tool_use') || s.includes('askalf-computer')) {
          actionCount++;
          if (s.includes('screenshot')) {
            spinner.update('Taking screenshot...');
          } else if (s.includes('Bash') || s.includes('bash') || s.includes('powershell')) {
            spinner.update('Running command...');
          } else {
            spinner.update(`Working... (action ${actionCount})`);
          }
        }

        // Show meaningful actions on their own line
        if (s.includes('screenshot') || s.includes('mouse') || s.includes('keyboard') ||
            s.includes('click') || s.includes('type') || s.includes('scroll') ||
            s.includes('tool_use') || s.includes('askalf-computer')) {
          spinner.stop();
          output.action('→', s.length > 120 ? s.slice(0, 120) + '...' : s);
          spinner.update(`Working... (action ${actionCount})`);
        }
      }
    });

    child.on('close', (code) => {
      spinner.stop();

      if (code !== 0 && !stdout) {
        reject(new Error(`Claude exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolvePromise({
          text: parsed.result ?? parsed.content ?? '',
          inputTokens: parsed.usage?.input_tokens ?? parsed.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? parsed.output_tokens ?? 0,
          costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? 0,
          turns: parsed.num_turns ?? 0,
        });
      } catch {
        resolvePromise({
          text: stdout.slice(0, 500) || 'Done',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          turns: 0,
        });
      }
    });

    child.on('error', (err) => {
      spinner.stop();
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          'Claude CLI not found. Install: npm i -g @anthropic-ai/claude-code\n' +
          'Then authenticate: claude auth login'
        ));
      } else {
        reject(err);
      }
    });
  });
}
