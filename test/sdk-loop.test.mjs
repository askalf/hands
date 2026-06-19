// Integration tests for the SDK-mode agent loop — the code that
// executes model output had zero tests before this file. Uses the
// testClient/testScreen hooks + dryRun so no API key, display, shell,
// or input device is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSdkMode } from '../dist/sdk-mode.js';
import { GuardController } from '../dist/util/guard.js';

// Redirect ~/.hands audit writes into a temp dir (audit.ts re-evaluates
// the home dir per call — same pattern as the audit tests).
const fakeHome = mkdtempSync(join(tmpdir(), 'hands-sdk-loop-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
// Silence the loop's console output — heavy stdout from inside a
// node:test child can corrupt the runner's serialized protocol stream
// ("Unable to deserialize cloned data") on some Node 22 builds.
process.env.HANDS_QUIET = '1';

const CONFIG = {
  authMode: 'api_key',
  apiKey: 'sk-test-not-real',
  model: 'claude-sonnet-4-6',
  maxBudgetUsd: 5,
  maxTurns: 10,
};

const SCREEN = {
  width: 2560,
  height: 1440,
  screenshot: async () => ({ data: 'QUFBQQ==', mediaType: 'image/png' }),
};

function scriptedClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(req);
          return responses[Math.min(requests.length - 1, responses.length - 1)];
        },
      },
    },
  };
}

function scriptedGuard(answers) {
  const asked = [];
  let i = 0;
  const guard = new GuardController({
    ask: async (prompt) => { asked.push(prompt); return answers[i++] ?? 'q'; },
    out: () => {},
  });
  return { guard, asked };
}

test('agent loop: --guard denies a bash call → executor skipped, model sees the denial', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_b', name: 'bash', input: { command: 'echo hi' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'ok, stopping' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const { guard, asked } = scriptedGuard(['d']);
  // No dryRun: a denied call returns before the executor, so nothing fires on the host.
  const result = await runSdkMode('delete stuff', CONFIG, { testClient: client, testScreen: SCREEN, guard });
  assert.equal(guard.denied, 1);
  assert.equal(asked.length, 1, 'bash is state-changing → exactly one prompt');
  assert.equal(result.text, 'ok, stopping');
  const second = client.requests[1];
  const tr = second.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  assert.ok(tr, 'denial must come back as a tool_result');
  const text = tr.content[0].content.map((c) => c.text).join(' ');
  assert.match(text, /DENIED/);
});

test('agent loop: --guard does not prompt for read-only actions (screenshot)', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_s', name: 'computer', input: { action: 'screenshot' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const { guard, asked } = scriptedGuard([]);
  const result = await runSdkMode('look at the screen', CONFIG, { dryRun: true, testClient: client, testScreen: SCREEN, guard });
  assert.equal(asked.length, 0, 'screenshot is read-only → no prompt');
  assert.equal(guard.allowed, 0);
  assert.equal(result.text, 'done');
});

test('agent loop: --guard quit aborts the run before the next API call', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_b', name: 'bash', input: { command: 'echo hi' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'should not reach' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const { guard } = scriptedGuard(['q']);
  const result = await runSdkMode('do the risky thing', CONFIG, { testClient: client, testScreen: SCREEN, guard });
  assert.equal(client.requests.length, 1, 'aborted before the second API call');
  assert.match(result.text, /aborted/i);
});

test('agent loop: --warden deny → executor skipped, model sees the block', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_b', name: 'bash', input: { command: 'rm -rf /' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'understood, stopping' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  let gated = 0;
  const warden = { gate: async () => { gated++; return { action: 'deny', reason: 'warden BLOCKED this black action.' }; } };
  const result = await runSdkMode('wipe the disk', CONFIG, { testClient: client, testScreen: SCREEN, warden });
  assert.equal(gated, 1, 'warden gate runs before dispatch');
  assert.equal(result.text, 'understood, stopping');
  const second = client.requests[1];
  const tr = second.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  assert.ok(tr, 'block must come back as a tool_result');
  assert.match(tr.content[0].content[0].text, /BLOCKED/);
});

test('agent loop: --warden abort ends the run before the next API call', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_b', name: 'bash', input: { command: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'should not reach' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const warden = { gate: async () => ({ action: 'abort' }) };
  const result = await runSdkMode('do the risky thing', CONFIG, { testClient: client, testScreen: SCREEN, warden });
  assert.equal(client.requests.length, 1, 'aborted before the second API call');
  assert.match(result.text, /aborted/i);
});

test('agent loop: --verify registers the tool + instruction and feeds VERIFIED back', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tv', name: 'verify', input: { claim: 'node runs', command: 'node -e "process.exit(0)"' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'verified, done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const result = await runSdkMode('do a thing', CONFIG, { testClient: client, testScreen: SCREEN, verify: true });
  assert.ok(client.requests[0].tools.some((t) => t.name === 'verify'), 'verify tool is registered');
  assert.match(client.requests[0].system, /SELF-VERIFICATION/, 'self-verify instruction is in the system prompt');
  const tr = client.requests[1].messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  assert.match(tr.content[0].content[0].text, /VERIFIED/);
  assert.equal(result.text, 'verified, done');
});

test('agent loop: --verify reports a FAILED check so the agent can fix it', async () => {
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tv', name: 'verify', input: { claim: 'exits zero', command: 'node -e "process.exit(2)"' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'will fix' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  await runSdkMode('do a thing', CONFIG, { testClient: client, testScreen: SCREEN, verify: true });
  const tr = client.requests[1].messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  assert.match(tr.content[0].content[0].text, /FAILED/);
});

test('agent loop: tool_use turn → tool_result fed back → end_turn finishes', async () => {
  const client = scriptedClient([
    {
      content: [
        { type: 'text', text: 'clicking the button' },
        { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'left_click', coordinate: [10, 10] } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    {
      content: [{ type: 'text', text: 'all done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 30 },
    },
  ]);

  const result = await runSdkMode('click the button', CONFIG, {
    dryRun: true,
    testClient: client,
    testScreen: SCREEN,
  });

  assert.equal(result.text, 'all done');
  assert.equal(result.turns, 2);
  assert.equal(result.inputTokens, 220);
  assert.equal(result.outputTokens, 80);
  assert.ok(result.costUsd > 0);

  // Two API calls; the second carries the tool_result for tu_1
  assert.equal(client.requests.length, 2);
  const second = client.requests[1];
  const toolResultMsg = second.messages.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  );
  assert.ok(toolResultMsg, 'second request must include a tool_result message');
  assert.equal(toolResultMsg.content[0].tool_use_id, 'tu_1');

  // The request shape the API contract depends on
  assert.equal(second.model, 'claude-sonnet-4-6');
  assert.deepEqual(second.betas, ['computer-use-2025-11-24']);
  assert.ok(second.tools.some((t) => t.name === 'computer' && t.enable_zoom === true));
  assert.ok(typeof second.system === 'string' && second.system.length > 0);
});

test('agent loop: budget cap halts before the next API call', async () => {
  const client = scriptedClient([
    {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'screenshot' } },
      ],
      stop_reason: 'tool_use',
      // Enormous usage so cost blows past the budget after turn 1
      usage: { input_tokens: 10_000_000, output_tokens: 10_000_000 },
    },
  ]);

  const result = await runSdkMode('do something', { ...CONFIG, maxBudgetUsd: 0.01 }, {
    dryRun: true,
    testClient: client,
    testScreen: SCREEN,
  });

  assert.equal(client.requests.length, 1, 'no second API call once over budget');
  assert.ok(result.costUsd > 0.01);
});

test('agent loop: maxTurns caps a model that never stops calling tools', async () => {
  const client = scriptedClient([
    {
      content: [
        { type: 'tool_use', id: 'tu_loop', name: 'computer', input: { action: 'screenshot' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  ]);

  const result = await runSdkMode('loop forever', { ...CONFIG, maxTurns: 3 }, {
    dryRun: true,
    testClient: client,
    testScreen: SCREEN,
  });

  assert.equal(result.turns, 3);
  assert.equal(client.requests.length, 3);
});
