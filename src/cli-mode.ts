import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import * as output from './util/output.js';
import type { AgentConfig } from './util/config.js';
import { VoiceInput } from './voice/index.js';
import { buildCliSystemPrompt, normalizePlatform, type SupportedPlatform } from './system-prompt.js';
import { resolveClaudeInvocation } from './platform/claude-cli.js';
import type { PersonaResolution } from './personas.js';
import {
  StreamJsonParser, pendingToolCall, auditEntryFor, flushPendingAudits,
  type StreamEvent, type ResultEvent, type PendingToolCall,
} from './cli-stream.js';
import { appendAudit } from './util/audit.js';

interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /** Claude CLI session id, when the stream surfaced one. */
  sessionId?: string | undefined;
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
  // fileURLToPath instead of import.meta.dirname — the latter only
  // exists from Node 20.11, while engines allows >=20.0.0.
  const mcpServerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');

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

  const tick = () => {
    elapsed = Math.floor((Date.now() - startTime) / 1000);
    const spinner = chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    const time = chalk.dim(`${elapsed}s`);
    process.stderr.write(`\r${spinner} ${chalk.white(currentLabel)} ${time}  `);
    frame++;
  };

  let interval: NodeJS.Timeout | null = setInterval(tick, 80);

  return {
    // update() restarts a stopped spinner — the action-line path calls
    // stop() to print a line, then update() to resume. A previous
    // version never restarted the interval, so the spinner froze after
    // the first action for the rest of the task.
    update(newLabel: string) {
      currentLabel = newLabel;
      if (!interval) interval = setInterval(tick, 80);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
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

export interface ClaudeArgsOptions {
  prefixArgs: string[];
  prompt: string;
  systemPrompt: string;
  maxTurns: number;
  mcpConfigPath: string;
}

/**
 * Argv for the `claude` child. Pure — exported for tests so the flag
 * contract (stream-json + verbose + skip-permissions ordering) is
 * pinned without spawning anything.
 */
export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  return [
    ...o.prefixArgs,
    '-p', o.prompt,
    '--append-system-prompt', o.systemPrompt,
    // stream-json (not json): we want the live event feed — real
    // tool_use blocks for action lines and the audit log, plus the
    // session id — instead of one opaque envelope at exit.
    '--output-format', 'stream-json',
    // Older claude versions rejected stream-json in print mode without
    // --verbose; current ones accept it either way. Always pass it.
    '--verbose',
    '--max-turns', String(o.maxTurns),
    '--mcp-config', o.mcpConfigPath,
    '--dangerously-skip-permissions',
  ];
}

async function spawnClaude(prompt: string, config: AgentConfig, mcpConfigPath: string, memory: SessionMemory, persona: PersonaResolution | undefined): Promise<RunResult> {
  const invocation = await resolveClaudeInvocation();
  return new Promise((resolvePromise, reject) => {
    const sessionContext = buildSessionContext(memory);
    const systemPrompt = composeCliAppendPrompt(normalizePlatform(process.platform), sessionContext, persona);

    const args = buildClaudeArgs({
      prefixArgs: invocation.prefixArgs,
      prompt,
      systemPrompt,
      maxTurns: config.maxTurns,
      mcpConfigPath,
    });

    const child = spawn(invocation.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDECODE: '',
      },
    });

    const spinner = createSpinner('Thinking...');
    const parser = new StreamJsonParser();
    const pending = new Map<string, PendingToolCall>();
    let sessionId: string | undefined;
    let finalResult: ResultEvent | undefined;
    let lastAssistantText = '';
    let actionCount = 0;
    let stderrTail = '';
    // Audit writes are chained so entries land in stream order even
    // though each append is async. Never awaited on the hot path — the
    // audit log is diagnostic, not authoritative.
    let auditChain: Promise<void> = Promise.resolve();

    const handleEvent = (event: StreamEvent): void => {
      switch (event.kind) {
        case 'init':
          sessionId = event.sessionId;
          break;
        case 'tool_use': {
          actionCount++;
          const call = pendingToolCall(event, Date.now());
          if (event.id) pending.set(event.id, call);
          spinner.stop();
          output.action('→', call.summary);
          spinner.update(`Working... (action ${actionCount})`);
          break;
        }
        case 'tool_result': {
          const call = pending.get(event.toolUseId);
          if (call) {
            pending.delete(event.toolUseId);
            const entry = auditEntryFor(call, event.isError, Date.now());
            auditChain = auditChain.then(() => appendAudit(entry));
          }
          break;
        }
        case 'text':
          lastAssistantText = event.text;
          break;
        case 'result':
          finalResult = event;
          if (event.sessionId) sessionId = event.sessionId;
          break;
      }
    };

    child.stdout.on('data', (data: Buffer) => {
      for (const event of parser.push(data.toString())) handleEvent(event);
    });

    // stderr is --verbose progress noise; keep a short tail purely for
    // the error message when the child dies without a result event.
    child.stderr.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-500);
    });

    child.on('close', (code) => {
      for (const event of parser.flush()) handleEvent(event);
      spinner.stop();

      for (const entry of flushPendingAudits(pending.values(), Date.now())) {
        auditChain = auditChain.then(() => appendAudit(entry));
      }

      if (finalResult) {
        resolvePromise({
          text: finalResult.text || lastAssistantText,
          inputTokens: finalResult.inputTokens,
          outputTokens: finalResult.outputTokens,
          costUsd: finalResult.costUsd,
          turns: finalResult.turns,
          sessionId,
        });
        return;
      }

      if (code !== 0) {
        const detail = stderrTail.trim().split('\n').pop();
        reject(new Error(`Claude exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }

      resolvePromise({
        text: lastAssistantText || 'Done',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: actionCount,
        sessionId,
      });
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
