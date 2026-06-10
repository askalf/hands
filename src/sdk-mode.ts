import Anthropic from '@anthropic-ai/sdk';
import { getScreenSize } from './platform/screen-info.js';
import { takeScreenshot } from './platform/screenshot.js';
import {
  mouseClick, mouseMove, mouseDoubleClick, mouseTripleClick, mouseScroll,
  mouseButtonEvent, mouseDrag,
  type ScrollDirection, type ModifierKey,
} from './platform/mouse.js';
import { keyboardType, keyboardKey, keyboardHoldKey } from './platform/keyboard.js';
import * as output from './util/output.js';
import type { AgentConfig } from './util/config.js';
import { checkCommand } from './util/guardrails.js';
import { appendAudit } from './util/audit.js';
import { buildSdkSystemPrompt, normalizePlatform } from './system-prompt.js';
import { readPage } from './tools/read-page.js';
import { findFiles } from './tools/find-files.js';

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
  // A stored key wins; otherwise let the SDK resolve ANTHROPIC_API_KEY /
  // ANTHROPIC_AUTH_TOKEN from the environment itself — that's the
  // documented dario flow (`export ANTHROPIC_API_KEY=dario`), which a
  // previous version broke by always passing config.apiKey explicitly.
  const client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : new Anthropic();
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
      // Opt into the zoom action (2025-11-24 tool only) — region
      // captures come back at full resolution via takeScreenshot.
      enable_zoom: true,
    } as unknown as Anthropic.Beta.BetaTool,
    {
      type: 'bash_20250124' as unknown as 'bash_20241022',
      name: 'bash',
    } as unknown as Anthropic.Beta.BetaTool,
    {
      type: 'text_editor_20250728' as unknown as 'text_editor_20241022',
      name: 'str_replace_based_edit_tool',
    } as unknown as Anthropic.Beta.BetaTool,
    // Custom tool — fetch a URL and return cleaned HTML for the agent
    // to read directly. Faster, cheaper, and more reliable than
    // navigating to the URL with the computer tool. See
    // src/tools/read-page.ts.
    {
      name: 'read_page',
      description: 'Fetch a web page and return its content for reading. Use this INSTEAD OF the computer tool whenever you need to read content from a URL — it\'s much faster (no browser cold-start), cheaper (no screenshot tokens), and more reliable (no JavaScript needed for static content). Returns the cleaned HTML body with all links resolved to absolute URLs, plus extracted page metadata. For pure single-page-application URLs (empty HTML body, content fetched via JS), returns metadata only with a marker — those need the computer tool. Always prefer this tool for: reading articles, browsing documentation, checking GitHub READMEs, viewing news pages, fetching JSON APIs, reading RSS feeds. Only use the computer tool for URLs when you specifically need to interact (click, fill forms, scroll a JS-rendered page).',
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch. Must be http: or https:.',
          },
        },
        required: ['url'],
      },
    } as unknown as Anthropic.Beta.BetaTool,
    // Custom tool — recursively list / search files in a directory
    // tree without spawning N bash turns. See src/tools/find-files.ts.
    {
      name: 'find_files',
      description: 'Recursively list or search files under a directory. Use this INSTEAD OF chaining `bash ls` + `cat` + `grep` calls — one find_files turn replaces 3-10 bash turns. Two modes: (1) list mode — pass `name_pattern` (basename glob like `*.ts` or `test_*.py`) to enumerate matching files with sizes; (2) grep mode — also pass `grep` (regex) to return file:line:content matches across matching files. Skips noisy dirs by default (node_modules, .git, dist, build, .next, .cache, venv, target, __pycache__). For: locating a file by name, finding all files of a type, searching for a symbol or string across the codebase, surveying a directory the user just mentioned. Use the str_replace_based_edit_tool or bash to actually open / read full file content once find_files has located it.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Root directory to walk. Defaults to current working directory.',
          },
          name_pattern: {
            type: 'string',
            description: 'Basename glob to filter files (e.g. "*.ts", "test_*.py", "{a,b}.md"). Supports * (any chars), ? (single char), {a,b} (alternation). Matched against file basename only, not the full path. Omit to match all files.',
          },
          grep: {
            type: 'string',
            description: 'Optional regex to search for inside the matched files. When set, returns file:line:content matches instead of a file list. Standard JS regex syntax.',
          },
          max_depth: {
            type: 'number',
            description: 'Max directory depth to walk. Default 10.',
          },
          max_results: {
            type: 'number',
            description: 'Max files (list mode) or matches (grep mode) to return. Default 50.',
          },
        },
        required: [],
      },
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
          if (block.name === 'read_page') {
            result = await executeReadPage(block.input as Record<string, unknown>, { dryRun: opts.dryRun });
          } else if (block.name === 'find_files') {
            result = await executeFindFiles(block.input as Record<string, unknown>, { dryRun: opts.dryRun });
          } else {
            result = await executeComputerAction(block.name, block.input as Record<string, unknown>, scaleFactor, { dryRun: opts.dryRun });
          }
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
  if (toolName === 'read_page') {
    const url = input['url'] as string | undefined;
    return url ? url.slice(0, 80) : 'read_page';
  }
  if (toolName === 'find_files') {
    const path = (input['path'] as string | undefined) ?? '.';
    const pat = input['name_pattern'] as string | undefined;
    const grep = input['grep'] as string | undefined;
    const parts = [path];
    if (pat) parts.push(`name=${pat}`);
    if (grep) parts.push(`grep=/${grep}/`);
    return parts.join(' ');
  }
  return toolName;
}

/**
 * Dispatcher for the `read_page` custom tool. Same audit + dry-run
 * shape as `executeComputerAction`, but the underlying call is
 * `readPage` from `tools/read-page.ts`.
 *
 * Dry-run for read_page is a no-op fetch-skip — we return a stub
 * acknowledging the call but don't actually hit the network. The
 * agent sees a "would have fetched X" message so its loop continues.
 * (Network fetch is not destructive, but consistency with bash /
 * computer dry-run semantics matters more than allowing read-only
 * fetches through dry-run.)
 */
async function executeReadPage(
  input: Record<string, unknown>,
  opts: { dryRun?: boolean | undefined } = {},
): Promise<Array<{ type: string; text?: string }>> {
  const url = input['url'] as string | undefined;
  if (!url || typeof url !== 'string') {
    await appendAudit({ tool: 'read_page', args: { url }, durationMs: 0, ok: false, error: 'missing url' });
    return [{ type: 'text', text: 'Error: read_page requires a `url` string argument.' }];
  }

  const auditArgs = { url };

  if (opts.dryRun) {
    output.action('read_page', `[dry-run] ${url}`);
    await appendAudit({ tool: 'read_page', args: auditArgs, durationMs: 0, ok: true, dryRun: true });
    return [{ type: 'text', text: `[dry-run] Would fetch ${url}. Returning stub. To actually read pages, run hands without --dry-run.` }];
  }

  output.action('read_page', url);
  const start = Date.now();
  try {
    const result = await readPage(url);
    const durationMs = Date.now() - start;
    await appendAudit({
      tool: 'read_page',
      args: auditArgs,
      durationMs,
      ok: true,
      // Stash a short shape signal in `error` field is wrong — but we
      // don't have a separate metadata field on AuditEntry. Skip; the
      // tool result itself is the canonical record of what the agent
      // saw.
    });
    return [{ type: 'text', text: result.text }];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendAudit({
      tool: 'read_page',
      args: auditArgs,
      durationMs: Date.now() - start,
      ok: false,
      error: msg.slice(0, 200),
    });
    return [{ type: 'text', text: `Error fetching ${url}: ${msg}` }];
  }
}

/**
 * Dispatcher for the `find_files` custom tool. Audit + dry-run shape
 * mirrors `executeReadPage`. Read-only by construction — dry-run still
 * skips the walk so behavior is consistent with the other tools when
 * the user asks for a no-side-effects rehearsal.
 */
async function executeFindFiles(
  input: Record<string, unknown>,
  opts: { dryRun?: boolean | undefined } = {},
): Promise<Array<{ type: string; text?: string }>> {
  const path = input['path'] as string | undefined;
  const namePattern = input['name_pattern'] as string | undefined;
  const grep = input['grep'] as string | undefined;
  const maxDepth = input['max_depth'] as number | undefined;
  const maxResults = input['max_results'] as number | undefined;

  const auditArgs: Record<string, unknown> = {};
  if (path !== undefined) auditArgs['path'] = path;
  if (namePattern !== undefined) auditArgs['name_pattern'] = namePattern;
  if (grep !== undefined) auditArgs['grep'] = grep;
  if (maxDepth !== undefined) auditArgs['max_depth'] = maxDepth;
  if (maxResults !== undefined) auditArgs['max_results'] = maxResults;

  const summary = describeCall('find_files', input);

  if (opts.dryRun) {
    output.action('find_files', `[dry-run] ${summary}`);
    await appendAudit({ tool: 'find_files', args: auditArgs, durationMs: 0, ok: true, dryRun: true });
    return [{ type: 'text', text: `[dry-run] Would search ${summary}. Run without --dry-run to actually walk.` }];
  }

  output.action('find_files', summary);
  const start = Date.now();
  try {
    const callOpts: Record<string, unknown> = {};
    if (path !== undefined) callOpts['path'] = path;
    if (namePattern !== undefined) callOpts['namePattern'] = namePattern;
    if (grep !== undefined) callOpts['grep'] = grep;
    if (maxDepth !== undefined) callOpts['maxDepth'] = maxDepth;
    if (maxResults !== undefined) callOpts['maxResults'] = maxResults;
    const result = await findFiles(callOpts as Parameters<typeof findFiles>[0]);
    await appendAudit({ tool: 'find_files', args: auditArgs, durationMs: Date.now() - start, ok: true });
    return [{ type: 'text', text: result.text }];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendAudit({
      tool: 'find_files',
      args: auditArgs,
      durationMs: Date.now() - start,
      ok: false,
      error: msg.slice(0, 200),
    });
    return [{ type: 'text', text: `Error in find_files: ${msg}` }];
  }
}

/**
 * The full computer_20251124 action set. Exported for tests — the
 * dispatcher must handle every entry (a previous version declared the
 * 2025-11-24 tool but implemented only the 2024-10-22 actions, so the
 * model burned turns on capabilities that returned "Unknown action").
 */
export const SUPPORTED_COMPUTER_ACTIONS = [
  'screenshot', 'zoom',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_mouse_down', 'left_mouse_up', 'left_click_drag', 'mouse_move',
  'type', 'key', 'hold_key', 'wait', 'scroll',
] as const;

/** Validate the computer-use `text` modifier param (shift/ctrl/alt/super). Exported for tests. */
export function parseModifier(text: unknown): ModifierKey | undefined {
  return text === 'shift' || text === 'ctrl' || text === 'alt' || text === 'super' ? text : undefined;
}

/**
 * Map a zoom `region` [x1, y1, x2, y2] from screenshot space to a real-
 * pixel [x, y, width, height] capture rect. Exported for tests.
 */
export function scaleZoomRegion(
  region: [number, number, number, number],
  scaleFactor: number,
): [number, number, number, number] | undefined {
  const [x1, y1, x2, y2] = region.map((v) => Math.round(v / scaleFactor)) as [number, number, number, number];
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return undefined;
  return [x1, y1, w, h];
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

  const verify = 'Use screenshot action to verify if needed.';

  if (toolName === 'computer' && action) {
    output.action('computer', action);

    switch (action) {
      case 'screenshot': {
        const ss = await takeScreenshot();
        return [{ type: 'image', source: { type: 'base64', media_type: ss.mediaType, data: ss.data } }];
      }
      case 'zoom': {
        const region = input['region'] as [number, number, number, number] | undefined;
        if (!Array.isArray(region) || region.length !== 4) {
          return [{ type: 'text', text: 'Error: zoom requires a region parameter [x1, y1, x2, y2].' }];
        }
        const rect = scaleZoomRegion(region, scaleFactor);
        if (!rect) {
          return [{ type: 'text', text: 'Error: zoom region is empty — [x1, y1, x2, y2] must describe a positive-area rectangle.' }];
        }
        const ss = await takeScreenshot({ region: rect });
        return [
          { type: 'text', text: `Zoomed view of region [${region.join(', ')}] at full resolution:` },
          { type: 'image', source: { type: 'base64', media_type: ss.mediaType, data: ss.data } },
        ];
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
        const modifier = parseModifier(input['text']);
        await mouseClick(x, y, button, modifier);
        const modNote = modifier ? ` holding ${modifier}` : '';
        return [
          { type: 'text', text: `${button === 'left' ? 'Clicked' : button === 'right' ? 'Right-clicked' : 'Middle-clicked'}${modNote} at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). ${verify}` },
        ];
      }
      case 'double_click': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseDoubleClick(x, y);
        return [{ type: 'text', text: `Double-clicked at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). ${verify}` }];
      }
      case 'triple_click': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseTripleClick(x, y);
        return [{ type: 'text', text: `Triple-clicked at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). ${verify}` }];
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        await mouseButtonEvent(x, y, action === 'left_mouse_down' ? 'down' : 'up');
        return [{ type: 'text', text: `Left mouse ${action === 'left_mouse_down' ? 'pressed' : 'released'} at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}).` }];
      }
      case 'left_click_drag': {
        const rawStart = input['start_coordinate'] as [number, number];
        const rawEnd = input['coordinate'] as [number, number];
        const [sx, sy] = scaleCoord(rawStart);
        const [ex, ey] = scaleCoord(rawEnd);
        await mouseDrag(sx, sy, ex, ey);
        return [
          { type: 'text', text: `Dragged from (${rawStart[0]}, ${rawStart[1]}) to (${rawEnd[0]}, ${rawEnd[1]}) → screen (${sx}, ${sy})→(${ex}, ${ey}). ${verify}` },
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
          { type: 'text', text: `Typed: "${text.length > 50 ? text.slice(0, 50) + '...' : text}". ${verify}` },
        ];
      }
      case 'key': {
        const key = input['text'] as string;
        await keyboardKey(key);
        return [{ type: 'text', text: `Pressed: ${key}. ${verify}` }];
      }
      case 'hold_key': {
        const key = input['text'] as string;
        const duration = (input['duration'] as number) ?? 1;
        await keyboardHoldKey(key, duration);
        return [{ type: 'text', text: `Held ${key} for ${Math.min(10, Math.max(0.1, duration))}s. ${verify}` }];
      }
      case 'wait': {
        const requested = (input['duration'] as number) ?? 1;
        const duration = Math.min(30, Math.max(0, requested));
        await new Promise((r) => setTimeout(r, duration * 1000));
        return [{ type: 'text', text: `Waited ${duration}s.` }];
      }
      case 'scroll': {
        const raw = input['coordinate'] as [number, number];
        const [x, y] = scaleCoord(raw);
        const rawDir = input['scroll_direction'] as string;
        const direction: ScrollDirection =
          rawDir === 'up' || rawDir === 'left' || rawDir === 'right' ? rawDir : 'down';
        const amount = (input['scroll_amount'] as number) ?? 3;
        const modifier = parseModifier(input['text']);
        await mouseScroll(x, y, direction, amount, modifier);
        const modNote = modifier ? ` holding ${modifier}` : '';
        return [
          { type: 'text', text: `Scrolled ${direction}${modNote} at (${raw[0]}, ${raw[1]}) → screen (${x}, ${y}). ${verify}` },
        ];
      }
      default:
        return [{ type: 'text', text: `Unknown computer action: ${action}. Supported: ${SUPPORTED_COMPUTER_ACTIONS.join(', ')}.` }];
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
    const command = input['command'] as string;
    const path = input['path'] as string;
    output.action('text_editor', `${command} ${path ?? ''}`.trim());
    // File operations run through node:fs directly — NEVER through a shell.
    // (A previous version shelled out to `cat "<path>"`, which let a path
    // containing shell metacharacters inject commands and bypass the bash
    // guardrail. fs takes the path as a literal value, so there is no shell
    // to inject into.)
    const fs = await import('node:fs/promises');
    try {
      if (command === 'view') {
        const content = await fs.readFile(path, 'utf-8');
        const range = input['view_range'] as [number, number] | undefined;
        if (Array.isArray(range) && range.length === 2) {
          const lines = content.split('\n');
          const [start, end] = range;
          const slice = lines.slice(Math.max(0, start - 1), end === -1 ? undefined : end);
          return [{ type: 'text', text: slice.join('\n') }];
        }
        return [{ type: 'text', text: content }];
      }
      if (command === 'create') {
        await fs.writeFile(path, (input['file_text'] as string) ?? '', 'utf-8');
        return [{ type: 'text', text: `Created ${path}` }];
      }
      if (command === 'str_replace') {
        const oldStr = input['old_str'] as string;
        const newStr = (input['new_str'] as string) ?? '';
        const content = await fs.readFile(path, 'utf-8');
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) return [{ type: 'text', text: `Error: old_str not found in ${path}.` }];
        if (occurrences > 1) return [{ type: 'text', text: `Error: old_str matched ${occurrences} times in ${path}; make it unique (include surrounding context).` }];
        await fs.writeFile(path, content.replace(oldStr, newStr), 'utf-8');
        return [{ type: 'text', text: `Replaced 1 occurrence in ${path}.` }];
      }
      if (command === 'insert') {
        const insertLine = (input['insert_line'] as number) ?? 0;
        const newStr = (input['new_str'] as string) ?? '';
        const content = await fs.readFile(path, 'utf-8');
        const lines = content.split('\n');
        lines.splice(Math.max(0, insertLine), 0, newStr);
        await fs.writeFile(path, lines.join('\n'), 'utf-8');
        return [{ type: 'text', text: `Inserted text after line ${insertLine} in ${path}.` }];
      }
      return [{ type: 'text', text: `Unsupported text editor command: ${command}. Supported: view, create, str_replace, insert.` }];
    } catch (err) {
      return [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }];
    }
  }

  return [{ type: 'text', text: `Unknown tool: ${toolName}` }];
}

/**
 * Replace all but the newest `keepLast` screenshots with a text
 * placeholder, in place. Screenshots live in two shapes: a top-level
 * `image` block on the initial user message, and `image` blocks nested
 * inside `tool_result` content on every later turn — the walk has to
 * descend into `tool_result` or the per-turn screenshots (the ones that
 * actually accumulate) are never trimmed. Exported for tests.
 */
export function trimScreenshots(messages: Anthropic.Beta.BetaMessageParam[], keepLast: number): void {
  let screenshotCount = 0;

  const visit = (block: unknown): void => {
    if (typeof block !== 'object' || block === null || !('type' in block)) return;
    const mutable = block as Record<string, unknown>;
    if (mutable['type'] === 'image') {
      screenshotCount++;
      if (screenshotCount > keepLast) {
        mutable['type'] = 'text';
        mutable['text'] = '[screenshot omitted]';
        delete mutable['source'];
      }
    } else if (mutable['type'] === 'tool_result' && Array.isArray(mutable['content'])) {
      const nested = mutable['content'] as unknown[];
      for (let i = nested.length - 1; i >= 0; i--) visit(nested[i]);
    }
  };

  // Walk newest-first so the kept screenshots are the most recent ones
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) visit(msg.content[j]);
    }
  }
}
