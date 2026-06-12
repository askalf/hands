// Unit tests for the stream-json parser behind Claude Login mode's
// action lines + audit trail. Pure functions — no child_process, no
// claude CLI dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStreamLine, StreamJsonParser, describeToolUse,
  summarizeCliToolArgs, pendingToolCall, auditEntryFor, flushPendingAudits,
} from '../dist/cli-stream.js';
import { buildClaudeArgs } from '../dist/cli-mode.js';

const INIT_LINE = JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'sess-123', model: 'claude-sonnet-4-6',
});

const TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'Opening notepad now.' },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'Start-Process notepad' } },
    ],
  },
});

const TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', is_error: false, content: 'ok' },
    ],
  },
});

const RESULT_LINE = JSON.stringify({
  type: 'result', subtype: 'success', session_id: 'sess-123',
  result: 'Notepad is open.', total_cost_usd: 0.012, num_turns: 3,
  usage: { input_tokens: 900, output_tokens: 120 },
});

test('parseStreamLine — init event carries session id', () => {
  const events = parseStreamLine(INIT_LINE);
  assert.deepEqual(events, [{ kind: 'init', sessionId: 'sess-123' }]);
});

test('parseStreamLine — assistant message yields text + tool_use events', () => {
  const events = parseStreamLine(TOOL_USE_LINE);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: 'text', text: 'Opening notepad now.' });
  assert.deepEqual(events[1], {
    kind: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'Start-Process notepad' },
  });
});

test('parseStreamLine — user message yields tool_result with error flag', () => {
  assert.deepEqual(parseStreamLine(TOOL_RESULT_LINE), [
    { kind: 'tool_result', toolUseId: 'toolu_01', isError: false },
  ]);
  const errLine = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_02', is_error: true }] },
  });
  assert.deepEqual(parseStreamLine(errLine), [
    { kind: 'tool_result', toolUseId: 'toolu_02', isError: true },
  ]);
});

test('parseStreamLine — result envelope', () => {
  const [event] = parseStreamLine(RESULT_LINE);
  assert.equal(event.kind, 'result');
  assert.equal(event.ok, true);
  assert.equal(event.text, 'Notepad is open.');
  assert.equal(event.sessionId, 'sess-123');
  assert.equal(event.costUsd, 0.012);
  assert.equal(event.turns, 3);
  assert.equal(event.inputTokens, 900);
  assert.equal(event.outputTokens, 120);
});

test('parseStreamLine — error-subtype result reports ok=false', () => {
  const [event] = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }));
  assert.equal(event.kind, 'result');
  assert.equal(event.ok, false);
});

test('parseStreamLine — unknown types, malformed JSON, and non-JSON lines yield nothing', () => {
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'api_retry' })), []);
  assert.deepEqual(parseStreamLine('{"type": "assistant", "message": '), []);
  assert.deepEqual(parseStreamLine('plain text progress line'), []);
  assert.deepEqual(parseStreamLine(''), []);
  assert.deepEqual(parseStreamLine('null'), []);
});

test('StreamJsonParser — reassembles lines split across chunk boundaries', () => {
  const parser = new StreamJsonParser();
  const whole = INIT_LINE + '\n' + TOOL_USE_LINE + '\n';
  const cut = INIT_LINE.length + 1 + Math.floor(TOOL_USE_LINE.length / 2);
  const first = parser.push(whole.slice(0, cut));
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'init');
  const second = parser.push(whole.slice(cut));
  assert.equal(second.length, 2);
  assert.equal(second[1].kind, 'tool_use');
  assert.deepEqual(parser.flush(), []);
});

test('StreamJsonParser — flush drains a final line with no trailing newline', () => {
  const parser = new StreamJsonParser();
  assert.deepEqual(parser.push(RESULT_LINE), []); // no newline yet — still buffered
  const events = parser.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'result');
});

test('describeToolUse — MCP names split into server + action', () => {
  const d = describeToolUse('mcp__askalf-computer__screenshot', {});
  assert.equal(d.tool, 'askalf-computer');
  assert.equal(d.action, 'screenshot');
  assert.equal(d.summary, 'askalf-computer: screenshot');
});

test('describeToolUse — Bash shows the command, redacted and clipped', () => {
  const d = describeToolUse('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" https://x' });
  assert.equal(d.tool, 'bash');
  assert.match(d.summary, /^bash: curl/);
  assert.doesNotMatch(d.summary, /abcdefghijklmnopqrstuvwx/);
  const long = describeToolUse('Bash', { command: 'x'.repeat(300) });
  assert.ok(long.summary.length < 140);
});

test('describeToolUse — file tools show the path, unknown tools fall back to first string arg', () => {
  assert.equal(describeToolUse('Write', { file_path: '/tmp/a.txt', content: 'hi' }).summary, 'write: /tmp/a.txt');
  assert.equal(describeToolUse('SomeNewTool', { target: 'thing' }).summary, 'SomeNewTool: thing');
  assert.equal(describeToolUse('SomeNewTool', { count: 3 }).summary, 'SomeNewTool');
});

test('summarizeCliToolArgs — drops image bytes, scrubs secrets, truncates', () => {
  const out = summarizeCliToolArgs({
    command: 'echo sk-ant-abcdefghijklmnop',
    data: 'AAAA'.repeat(5000),
    long: 'y'.repeat(300),
    n: 7,
    flag: true,
    coords: [10, 20],
  });
  assert.equal(out.data, undefined);
  assert.doesNotMatch(String(out.command), /sk-ant-abcdefghijklmnop/);
  assert.equal(String(out.long).length, 201); // 200 + ellipsis
  assert.equal(out.n, 7);
  assert.equal(out.flag, true);
  assert.deepEqual(out.coords, [10, 20]);
});

test('auditEntryFor — completed pair → ok entry with duration and cli mode', () => {
  const [use] = parseStreamLine(TOOL_USE_LINE).filter((e) => e.kind === 'tool_use');
  const call = pendingToolCall(use, 1000);
  const entry = auditEntryFor(call, false, 1450);
  assert.equal(entry.tool, 'bash');
  assert.equal(entry.ok, true);
  assert.equal(entry.durationMs, 450);
  assert.equal(entry.mode, 'cli');
  assert.equal(entry.error, undefined);
  assert.equal(entry.args.command, 'Start-Process notepad');
});

test('auditEntryFor — is_error result → ok=false with reason', () => {
  const [use] = parseStreamLine(TOOL_USE_LINE).filter((e) => e.kind === 'tool_use');
  const entry = auditEntryFor(pendingToolCall(use, 0), true, 10);
  assert.equal(entry.ok, false);
  assert.match(entry.error, /is_error/);
});

test('flushPendingAudits — unresolved calls land as not-ok interrupted entries', () => {
  const [use] = parseStreamLine(TOOL_USE_LINE).filter((e) => e.kind === 'tool_use');
  const entries = flushPendingAudits([pendingToolCall(use, 100)], 600);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].mode, 'cli');
  assert.match(entries[0].error, /no tool_result/);
  assert.equal(entries[0].durationMs, 500);
});

test('buildClaudeArgs — pins the stream-json flag contract', () => {
  const args = buildClaudeArgs({
    prefixArgs: ['C:\\path\\to\\cli.js'],
    prompt: 'open notepad',
    systemPrompt: 'SYS',
    maxTurns: 50,
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.equal(args[0], 'C:\\path\\to\\cli.js');
  assert.deepEqual(args.slice(1, 3), ['-p', 'open notepad']);
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.equal(args[args.indexOf('--max-turns') + 1], '50');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/tmp/mcp.json');
  assert.equal(args[args.length - 1], '--dangerously-skip-permissions');
});
