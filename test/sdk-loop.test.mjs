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

// Redirect ~/.hands audit writes into a temp dir (audit.ts re-evaluates
// the home dir per call — same pattern as the audit tests).
const fakeHome = mkdtempSync(join(tmpdir(), 'hands-sdk-loop-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

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
