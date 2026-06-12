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
import { saveLastSession } from './util/session-state.js';

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
  /** Resume an existing claude session (`hands run --continue`). The child is spawned from `cwd` because the claude CLI scopes session lookup to the directory the session started in. */
  resume?: { sessionId: string; cwd: string } | undefined;
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

/**
 * Claude Code settings for the child process: a PreToolUse hook on the
 * Bash tool that runs hands' hard-block guardrails (dist/hook-pre-tool-use.js).
 * Hook commands are parsed by a shell, so both paths are double-quoted —
 * npm global installs land under paths with spaces on every platform
 * ("Program Files", "Application Support"). Pure — exported for tests.
 */
export function buildHookSettings(nodePath: string, hookScriptPath: string): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: `"${nodePath}" "${hookScriptPath}"` },
          ],
        },
      ],
    },
  };
}

export async function runCliMode(prompt: string | undefined, config: AgentConfig, options: CliModeOptions = {}): Promise<RunResult> {
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

  // Settings file wiring the guardrail hook into the claude child.
  // PreToolUse hooks fire even under --dangerously-skip-permissions,
  // so this is the enforcement layer CLI mode never had.
  const settingsPath = join(tmpdir(), `askalf-settings-${randomBytes(4).toString('hex')}.json`);
  const hookScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'hook-pre-tool-use.js');
  await writeFile(settingsPath, JSON.stringify(buildHookSettings(process.execPath, hookScriptPath), null, 2));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let totalTurns = 0;
  let currentPrompt: string | undefined = prompt;
  // The claude session we're carrying the conversation in. Seeded by
  // --continue; otherwise captured from the first task's stream.
  let activeSessionId: string | undefined = options.resume?.sessionId;
  const spawnCwd = options.resume?.cwd;
  const sessionMemory: SessionMemory = { history: [], lessons: [] };

  const askNext = async (): Promise<string> => {
    if (voiceInput) {
      console.log('\x1b[36m❯ What next?\x1b[0m');
      try {
        return await voiceInput.listen();
      } catch {
        output.warn('Voice input failed, falling back to keyboard');
        return new Promise<string>((res) => {
          rl.question('\x1b[36m❯ What next? (keyboard)\x1b[0m ', (answer) => {
            res(answer.trim());
          });
        });
      }
    }
    return new Promise<string>((res) => {
      rl.question('\x1b[36m❯ What next?\x1b[0m ', (answer) => {
        res(answer.trim());
      });
    });
  };

  try {
    // Interactive loop. `hands run --continue` without a prompt enters
    // here with currentPrompt undefined and asks first.
    while (true) {
      if (!currentPrompt) {
        const next = await askNext();
        if (!next || next.toLowerCase() === 'exit' || next.toLowerCase() === 'quit') {
          output.info('Session ended.');
          break;
        }
        currentPrompt = next;
      }

      output.info(`\n→ ${currentPrompt}\n`);

      const result = await spawnClaude(currentPrompt, config, {
        mcpConfigPath,
        settingsPath,
        // With a live session id, claude itself holds the real
        // conversation — the hand-rolled summary injection is only the
        // fallback for streams that never surfaced an id (old claude
        // versions, parse failure).
        memory: activeSessionId ? undefined : sessionMemory,
        persona: options.persona,
        resumeSessionId: activeSessionId,
        cwd: spawnCwd,
      });
      totalTurns += result.turns;

      if (result.sessionId) {
        activeSessionId = result.sessionId;
        void saveLastSession({
          sessionId: result.sessionId,
          cwd: spawnCwd ?? process.cwd(),
          task: currentPrompt,
          ts: Date.now(),
        });
      }

      // Record what happened — only consulted on the fallback path.
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

      currentPrompt = undefined;
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
    try { await unlink(settingsPath); } catch { /* ignore */ }
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
  /** Settings file carrying the PreToolUse guardrail hook. */
  settingsPath?: string | undefined;
  /** Continue an existing claude session instead of starting fresh. */
  resumeSessionId?: string | undefined;
}

/**
 * Argv for the `claude` child. Pure — exported for tests so the flag
 * contract (stream-json + verbose + skip-permissions ordering) is
 * pinned without spawning anything.
 */
export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  return [
    ...o.prefixArgs,
    // --resume must ride along with every other flag re-passed: the
    // claude CLI does not persist --append-system-prompt, --mcp-config,
    // or permission flags across resumes.
    ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
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
    ...(o.settingsPath ? ['--settings', o.settingsPath] : []),
    // Hooks fire (and can deny) even with permissions skipped — the
    // guardrail hook in settingsPath is what makes this flag safe-ish.
    '--dangerously-skip-permissions',
  ];
}

interface SpawnClaudeOptions {
  mcpConfigPath: string;
  settingsPath: string;
  /** Session-summary fallback — omitted when a real claude session carries the conversation. */
  memory?: SessionMemory | undefined;
  persona?: PersonaResolution | undefined;
  resumeSessionId?: string | undefined;
  /** Spawn directory override — claude scopes session lookup to the dir a session started in. */
  cwd?: string | undefined;
}

async function spawnClaude(prompt: string, config: AgentConfig, opts: SpawnClaudeOptions): Promise<RunResult> {
  const invocation = await resolveClaudeInvocation();
  return new Promise((resolvePromise, reject) => {
    const sessionContext = opts.memory ? buildSessionContext(opts.memory) : '';
    const systemPrompt = composeCliAppendPrompt(normalizePlatform(process.platform), sessionContext, opts.persona);

    const args = buildClaudeArgs({
      prefixArgs: invocation.prefixArgs,
      prompt,
      systemPrompt,
      maxTurns: config.maxTurns,
      mcpConfigPath: opts.mcpConfigPath,
      settingsPath: opts.settingsPath,
      resumeSessionId: opts.resumeSessionId,
    });

    const child = spawn(invocation.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
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
