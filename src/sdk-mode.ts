import Anthropic from '@anthropic-ai/sdk';
import { getScreenSize } from './platform/screen-info.js';
import { takeScreenshot } from './platform/screenshot.js';
import { mouseClick, mouseMove, mouseDoubleClick, mouseScroll } from './platform/mouse.js';
import { keyboardType, keyboardKey } from './platform/keyboard.js';
import * as output from './util/output.js';
import type { AgentConfig } from './util/config.js';
import { checkCommand } from './util/guardrails.js';
import { appendAudit } from './util/audit.js';
import { buildSdkSystemPrompt, normalizePlatform } from './system-prompt.js';

interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

// Pricing per million tokens (claude-sonnet-4-6)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

// Screenshot resize target (must match screenshot.ts resize logic)
const SCREENSHOT_MAX_WIDTH = 1280;

export interface SdkModeOptions {
  /** When true, every tool call is logged to audit + stubbed — no shell, mouse, keyboard, or screenshot actually fires. Agent still sees "success" results so the loop continues. */
  dryRun?: boolean | undefined;
  /** When set, replaces the default OS-aware system prompt with this exact string. Used by --persona / --system-prompt to swap in custom prompt content. */
  systemPromptOverride?: string | undefined;
}

export async function runSdkMode(prompt: string, config: AgentConfig, opts: SdkModeOptions = {}): Promise<RunResult> {
  const client = new Anthropic({ apiKey: config.apiKey });
  const { width: realWidth, height: realHeight } = await getScreenSize();
  const model = config.model;
  const systemPrompt = opts.systemPromptOverride ?? buildSdkSystemPrompt(normalizePlatform(process.platform));

  // Calculate the display dimensions we tell Claude (matches screenshot size)
  const scaleFactor = Math.min(1.0, SCREENSHOT_MAX_WIDTH / realWidth);
  const width = Math.round(realWidth * scaleFactor);
  const height = Math.round(realHeight * scaleFactor);

  output.header('SDK Mode — Computer Use');
  output.info(`Model: ${model} | Screen: ${realWidth}x${realHeight} → ${width}x${height}`);
  output.info(`Budget: $${config.maxBudgetUsd.toFixed(2)} | Max turns: ${config.maxTurns}`);

  // Take initial screenshot
  output.action('screenshot', 'Capturing initial screen...');
  const initialSs = await takeScreenshot();
  const ssMediaType = initialSs.mediaType;

  const tools: Anthropic.Beta.BetaTool[] = [
    {
      type: 'computer_20251124' as unknown as 'computer_20241022',
      name: 'computer',
      display_width_px: width,
      display_height_px: height,
      display_number: 1,
    } as unknown as Anthropic.Beta.BetaTool,
    {
      type: 'bash_20250124' as unknown as 'bash_20241022',
      name: 'bash',
    } as unknown as Anthropic.Beta.BetaTool,
    {
      type: 'text_editor_20250728' as unknown as 'text_editor_20241022',
      name: 'str_replace_based_edit_tool',
    } as unknown as Anthropic.Beta.BetaTool,
  ];

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: ssMediaType, data: initialSs.data },
        },
        { type: 'text', text: prompt },
      ],
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let turns = 0;
  let finalText = '';

  while (turns < config.maxTurns) {
    turns++;
    const pricing = PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
    const currentCost = (totalInput * pricing.input + totalOutput * pricing.output) / 1_000_000;

    if (currentCost >= config.maxBudgetUsd) {
      output.warn(`Budget limit reached ($${currentCost.toFixed(4)} / $${config.maxBudgetUsd.toFixed(2)})`);
      break;
    }

    output.step(turns, config.maxTurns, `Turn ${turns}...`);

    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      tools,
      messages,
      system: systemPrompt,
      betas: ['computer-use-2025-11-24'],
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    // Process response content blocks
    const toolResults: Anthropic.Beta.BetaMessageParam[] = [];
    let hasToolUse = false;

    for (const block of response.content) {
      if (block.type === 'text') {
        finalText = block.text;
        output.info(block.text.length > 200 ? block.text.slice(0, 200) + '...' : block.text);
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        let result: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
        try {
          result = await executeComputerAction(block.name, block.input as Record<string, unknown>, scaleFactor, { dryRun: opts.dryRun });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          output.warn(`Action failed: ${errMsg}`);
          result = [{ type: 'text', text: `Error executing action: ${errMsg}` }];
        }
        toolResults.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            } as unknown as Anthropic.Beta.BetaContentBlockParam,
          ],
        });
      }
    }

    // Add assistant response to messages
    messages.push({ role: 'assistant', content: response.content });

    if (!hasToolUse || response.stop_reason === 'end_turn') {
      break;
    }

    // Add tool results
    for (const tr of toolResults) {
      messages.push(tr);
    }

    // Trim old screenshots to save context (keep last 5)
    trimScreenshots(messages, 5);
  }

  const pricing = PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
  const costUsd = (totalInput * pricing.input + totalOutput * pricing.output) / 1_000_000;

  return { text: finalText, inputTokens: totalInput, outputTokens: totalOutput, costUsd, turns };
}

/**
 * Audit + dry-run wrapper around the real tool dispatcher. Every call
 * (real or dry-run) is appended to `~/.hands/audit.jsonl` with timing
 * and outcome. When `opts.dryRun` is set, no shell / mouse / keyboard
 * / screenshot actually fires — the agent sees a success stub so the
 * loop continues, but the log shows the call was suppressed.
 */
async function executeComputerAction(
  toolName: string,
  input: Record<string, unknown>,
  scaleFactor: number,
  opts: { dryRun?: boolean | undefined } = {},
): Promise<Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>> {
  const action = input['action'] as string | undefined;
  const auditArgs = summarizeToolArgs(toolName, input);
  const start = Date.now();

  if (opts.dryRun) {
    const stub = dryRunStub(toolName, action, input);
    output.action(toolName, `[dry-run] ${action ?? describeCall(toolName, input)}`);
    await appendAudit({ tool: toolName, action, args: auditArgs, durationMs: 0, ok: true, dryRun: true });
    return [{ type: 'text', text: stub }];
  }

  try {
    const result = await executeComputerActionInner(toolName, input, scaleFactor);
    await appendAudit({ tool: toolName, action, args: auditArgs, durationMs: Date.now() - start, ok: true });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendAudit({ tool: toolName, action, args: auditArgs, durationMs: Date.now() - start, ok: false, error: msg.slice(0, 200) });
    throw err;
  }
}

/** What a tool call would do, rendered as a short human string. */
function dryRunStub(toolName: string, action: string | undefined, input: Record<string, unknown>): string {
  if (toolName === 'computer' && action) {
    switch (action) {
      case 'screenshot': return '[dry-run] would take screenshot';
      case 'left_click':
      case 'right_click':
      case 'double_click': {
        const coord = input['coordinate'] as [number, number] | undefined;
        return `[dry-run] would ${action.replace('_', ' ')} at (${coord?.[0] ?? '?'}, ${coord?.[1] ?? '?'})`;
      }
      case 'mouse_move': {
        const coord = input['coordinate'] as [number, number] | undefined;
        return `[dry-run] would move mouse to (${coord?.[0] ?? '?'}, ${coord?.[1] ?? '?'})`;
      }
      case 'type': {
        const text = (input['text'] as string | undefined) ?? '';
        return `[dry-run] would type: ${text.length > 60 ? text.slice(0, 60) + '...' : text}`;
      }
      case 'key':
        return `[dry-run] would press key: ${input['text']}`;
      case 'scroll': {
        const coord = input['coordinate'] as [number, number] | undefined;
        return `[dry-run] would scroll at (${coord?.[0] ?? '?'}, ${coord?.[1] ?? '?'})`;
      }
      default:
        return `[dry-run] would invoke computer action: ${action}`;
    }
  }
  if (toolName === 'bash') {
    const cmd = (input['command'] as string | undefined) ?? '';
    return `[dry-run] would execute: ${cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd}`;
  }
  return `[dry-run] would invoke ${toolName}`;
}

/** Short, lossy-ok summary of tool args for the audit log. Strips image bytes, truncates long strings. */
export function summarizeToolArgs(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'image' || k === 'data' || k === 'source') continue;  // never log base64 image bytes
    if (typeof v === 'string') {
      out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Describe a non-computer tool call when `action` isn't present. */
function describeCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') {
    const cmd = input['command'] as string | undefined;
    return cmd ? cmd.slice(0, 60) : 'bash';
  }
  return toolName;
}

async function executeComputerActionInner(
  toolName: string,
  input: Record<string, unknown>,
  scaleFactor: number,
): Promise<Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>> {
  const action = input['action'] as string | undefined;

  // Scale coordinates from screenshot space back to real screen space
  const scaleCoord = (coord: [number, number]): [number, number] =>
    [Math.round(coord[0] / scaleFactor), Math.round(coord[1] / scaleFactor)];

  if (toolName === 'computer' && action) {
    output.action('computer', action);

    switch (action) {
      case 'screenshot': {
        const ss = await takeScreenshot();
        return [{ type: 'image', source: { type: 'base64', media_type: ss.mediaType, data: ss.data } }];
      }
      case 'left_click': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseClick(x, y, 'left');
        return [
          { type: 'text', text: `Clicked at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). Use screenshot action to verify if needed.` },
        ];
      }
      case 'right_click': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseClick(x, y, 'right');
        return [
          { type: 'text', text: `Right-clicked at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). Use screenshot action to verify if needed.` },
        ];
      }
      case 'double_click': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseDoubleClick(x, y);
        return [
          { type: 'text', text: `Double-clicked at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). Use screenshot action to verify if needed.` },
        ];
      }
      case 'mouse_move': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseMove(x, y);
        return [{ type: 'text', text: `Moved mouse to (${raw[0]}, ${raw[1]}) → screen (${x}, ${y})` }];
      }
      case 'type': {
        const text = input['text'] as string;
        await keyboardType(text);
        return [
          { type: 'text', text: `Typed: "${text.length > 50 ? text.slice(0, 50) + '...' : text}". Use screenshot action to verify if needed.` },
        ];
      }
      case 'key': {
        const key = input['text'] as string;
        await keyboardKey(key);
        return [
          { type: 'text', text: `Pressed: ${key}. Use screenshot action to verify if needed.` },
        ];
      }
      case 'scroll': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        const direction = (input['scroll_direction'] as string) === 'up' ? 'up' : 'down' as const;
        const amount = (input['scroll_amount'] as number) ?? 3;
        await mouseScroll(x, y, direction, amount);
        return [
          { type: 'text', text: `Scrolled ${direction} at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). Use screenshot action to verify if needed.` },
        ];
      }
      default:
        return [{ type: 'text', text: `Unknown computer action: ${action}` }];
    }
  } else if (toolName === 'bash') {
    const command = input['command'] as string;
    output.action('bash', command);

    // Guardrail check — block dangerous commands
    const guard = checkCommand(command);
    if (guard.blocked) {
      return [{ type: 'text', text: `GUARDRAIL BLOCKED: ${guard.reason}. This command is not allowed. Use a safer approach.` }];
    }

    const { execSync } = await import('node:child_process');
    try {
      const result = execSync(command, { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
      return [{ type: 'text', text: result }];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ type: 'text', text: `Error: ${msg}` }];
    }
  } else if (toolName === 'str_replace_based_edit_tool') {
    output.action('text_editor', input['command'] as string);
    // Delegate to bash for file operations
    const { execSync } = await import('node:child_process');
    try {
      if (input['command'] === 'view') {
        const result = execSync(`cat "${input['path']}"`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        return [{ type: 'text', text: result }];
      }
      return [{ type: 'text', text: 'Text editor operations handled via bash' }];
    } catch (err) {
      return [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }];
    }
  }

  return [{ type: 'text', text: `Unknown tool: ${toolName}` }];
}

function trimScreenshots(messages: Anthropic.Beta.BetaMessageParam[], keepLast: number): void {
  let screenshotCount = 0;

  // Count screenshots from the end
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'image') {
          screenshotCount++;
          if (screenshotCount > keepLast) {
            // Replace with placeholder
            const mutable = block as unknown as Record<string, unknown>;
            mutable['type'] = 'text';
            mutable['text'] = '[screenshot omitted]';
            delete mutable['source'];
          }
        }
      }
    }
  }
}
