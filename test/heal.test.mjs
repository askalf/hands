// Self-healing replay (heal.ts) — the pure prompt/verdict/rewrite logic,
// plus the healer wired through the real SDK loop via the testClient /
// testScreen hooks (no API key, display, or input device touched; the one
// bash command a scripted repair fires is a harmless echo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect ~/.hands reads/writes (config, audit) into a temp dir — same
// pattern as the audit and sdk-loop tests.
const fakeHome = mkdtempSync(join(tmpdir(), 'hands-heal-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HANDS_QUIET = '1';

const { buildHealPrompt, parseHealVerdict, applyRepairs, createHealer, HEAL_MAX_TURNS, buildDistillPrompt, parseDistillReply } = await import('../dist/heal.js');
const { stepHasPlaceholder } = await import('../dist/macros.js');

const MACRO = {
  name: 'nightly',
  prompt: 'pull main and run the tests',
  steps: [
    { tool: 'bash', input: { command: 'git pull' } },
    { tool: 'bash', input: { command: 'npm test' } },
    { tool: 'click_element', input: { name: 'Save' } },
  ],
};

// ── buildHealPrompt ─────────────────────────────────────────────────

test('buildHealPrompt: marks done/failed/pending steps and carries the error + verdict contract', () => {
  const p = buildHealPrompt(MACRO, 1, 'Command failed: npm test (exit 1)');
  assert.match(p, /"nightly"/);
  assert.match(p, /pull main and run the tests/);
  assert.match(p, /✓ 1\. bash: git pull/);
  assert.match(p, /▶ 2\. bash: npm test/);
  assert.match(p, /○ 3\. click element: "Save"/);
  assert.match(p, /Command failed: npm test/);
  // The failed step's FULL input rides along (previews truncate at 80 chars).
  assert.match(p, /\{"command":"npm test"\}/);
  // The machine-checkable verdict contract.
  assert.match(p, /REPAIRED/);
  assert.match(p, /COULD-NOT-REPAIR/);
  // Scope rule: repair only the failed step.
  assert.match(p, /Do ONLY this step's work/);
});

test('buildHealPrompt: truncates an oversized failing input and error', () => {
  const macro = {
    name: 'big',
    steps: [{ tool: 'str_replace_based_edit_tool', input: { command: 'create', path: '/tmp/x', file_text: 'A'.repeat(5000) } }],
  };
  const p = buildHealPrompt(macro, 0, 'E'.repeat(2000));
  assert.match(p, /… \(truncated\)/);
  assert.ok(p.length < 5000, 'prompt stays bounded');
});

// ── parseHealVerdict ────────────────────────────────────────────────

test('parseHealVerdict: REPAIRED at the tail → true', () => {
  assert.equal(parseHealVerdict('Ran the fixed command and verified it.\n\nREPAIRED'), true);
});

test('parseHealVerdict: COULD-NOT-REPAIR wins even if REPAIRED appears nearby', () => {
  assert.equal(parseHealVerdict('I tried to get it REPAIRED but failed.\nCOULD-NOT-REPAIR'), false);
});

test('parseHealVerdict: no sentinel → false (an aborted or wandering run is not a repair)', () => {
  assert.equal(parseHealVerdict('Run aborted by operator before completion.'), false);
  assert.equal(parseHealVerdict(''), false);
});

test('parseHealVerdict: a mid-transcript mention outside the tail does not count', () => {
  assert.equal(parseHealVerdict('REPAIRED is what I will say when done. ' + 'x'.repeat(300)), false);
});

// ── applyRepairs ────────────────────────────────────────────────────

test('applyRepairs: replaces one failed step with N replacement steps', () => {
  const out = applyRepairs(MACRO, [{ index: 1, steps: [
    { tool: 'bash', input: { command: 'npm ci' } },
    { tool: 'bash', input: { command: 'npm test' } },
  ] }]);
  assert.equal(out.steps.length, 4);
  assert.equal(out.steps[1].input.command, 'npm ci');
  assert.equal(out.steps[2].input.command, 'npm test');
  assert.equal(out.steps[3].tool, 'click_element');
  // Pure: the input macro is untouched.
  assert.equal(MACRO.steps.length, 3);
});

test('applyRepairs: multiple repairs use ORIGINAL indices — an expansion cannot shift a later one', () => {
  const out = applyRepairs(MACRO, [
    { index: 0, steps: [{ tool: 'bash', input: { command: 'git fetch' } }, { tool: 'bash', input: { command: 'git merge' } }] },
    { index: 2, steps: [{ tool: 'click_element', input: { name: 'Save As' } }] },
  ]);
  assert.deepEqual(out.steps.map((s) => s.input.command ?? s.input.name),
    ['git fetch', 'git merge', 'npm test', 'Save As']);
});

test('applyRepairs: an empty replacement list drops the step', () => {
  const out = applyRepairs(MACRO, [{ index: 1, steps: [] }]);
  assert.equal(out.steps.length, 2);
});

// ── stepHasPlaceholder ──────────────────────────────────────────────

test('stepHasPlaceholder: detects {{param}} in parameterizable fields only', () => {
  assert.equal(stepHasPlaceholder({ tool: 'bash', input: { command: 'deploy {{env=staging}}' } }), true);
  assert.equal(stepHasPlaceholder({ tool: 'bash', input: { command: 'git pull' } }), false);
  assert.equal(stepHasPlaceholder({ tool: 'click_element', input: { name: '{{button}}' } }), true);
  // A non-parameterizable field never counts.
  assert.equal(stepHasPlaceholder({ tool: 'computer', action: 'left_click', input: { coordinate: [1, 2], note: '{{x}}' } }), false);
});

// ── createHealer / heal (through the real SDK loop) ─────────────────

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

const SCREEN = {
  width: 2560,
  height: 1440,
  screenshot: async () => ({ data: 'QUFBQQ==', mediaType: 'image/png' }),
};

test('createHealer: throws a fix-it error when no SDK credentials exist', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  await assert.rejects(
    () => createHealer({ noDario: true }),
    /no API key is configured/,
  );
});

test('heal: a scripted repair records the replacement step and reports REPAIRED', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'echo healed-ok' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'Re-ran the command with the fix and verified it. REPAIRED' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const healer = await createHealer({ noDario: true, testHooks: { testClient: client, testScreen: SCREEN } });
  try {
    const outcome = await healer.heal(MACRO, 1, 'Command failed: npm test (exit 1)');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.steps.length, 1);
    assert.deepEqual(outcome.steps[0], { tool: 'bash', input: { command: 'echo healed-ok' } });
    assert.ok(outcome.turns >= 2);
    // The healer's task is the repair prompt, not the macro's original task.
    const first = client.requests[0];
    const userText = first.messages[0].content.find((b) => b.type === 'text').text;
    assert.match(userText, /▶ 2\. bash: npm test/);
    // The repair budget is clamped — a drifted macro can't burn a full run per step.
    assert.ok(first.max_tokens > 0);
  } finally {
    healer.close();
  }
});

test('heal: a FAILED probe command is not captured — only the successful fix becomes the repair', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const client = scriptedClient([
    // Turn 1: an exploratory command that exits non-zero — must NOT be recorded.
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'node -e "process.exit(1)"' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    // Turn 2: the actual fix.
    { content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: { command: 'echo healed-ok' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'Verified. REPAIRED' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const healer = await createHealer({ noDario: true, testHooks: { testClient: client, testScreen: SCREEN } });
  try {
    const outcome = await healer.heal(MACRO, 1, 'boom');
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.steps, [{ tool: 'bash', input: { command: 'echo healed-ok' } }],
      'a failed command must never crystallize into a replay step');
    // The failure still reaches the model as an error tool_result, so it can adapt.
    const secondReq = client.requests[1];
    const tr = secondReq.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    assert.match(tr.content[0].content.map((c) => c.text).join(' '), /Error executing action/);
  } finally {
    healer.close();
  }
});

test('heal: a COULD-NOT-REPAIR verdict comes back ok:false with no committable steps', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const client = scriptedClient([
    { content: [{ type: 'text', text: 'The target file no longer exists anywhere. COULD-NOT-REPAIR' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const healer = await createHealer({ noDario: true, testHooks: { testClient: client, testScreen: SCREEN } });
  try {
    const outcome = await healer.heal(MACRO, 0, 'boom');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.steps.length, 0);
  } finally {
    healer.close();
  }
});

test('HEAL_MAX_TURNS: repairs are bounded well under a default full run', () => {
  assert.ok(HEAL_MAX_TURNS <= 20);
});

// ── repair distillation ─────────────────────────────────────────────

const TRAJECTORY = [
  { tool: 'bash', input: { command: 'powershell -Command "Get-ChildItem C:\\demo"' } },
  { tool: 'bash', input: { command: 'type "C:\\demo\\report.txt"' } },
];

test('buildDistillPrompt: numbers the trajectory, states the replay contract, asks for JSON', () => {
  const p = buildDistillPrompt(MACRO, 1, TRAJECTORY);
  assert.match(p, /1\. bash: powershell -Command "Get-ChildItem/);
  assert.match(p, /2\. bash: type "C:\\demo\\report\.txt"/);
  assert.match(p, /REPLAYED VERBATIM/);
  assert.match(p, /\{"keep":\[2,3\]\}/);
  assert.match(p, /Keep every action you are unsure about/);
});

test('parseDistillReply: object form, bare array, prose around JSON, dedupe + order', () => {
  assert.deepEqual(parseDistillReply('{"keep":[2]}', 2), [1]);
  assert.deepEqual(parseDistillReply('[1, 2]', 2), [0, 1]);
  assert.deepEqual(parseDistillReply('Keeping the fix only: {"keep":[3,1,3]}', 3), [0, 2]);
  assert.deepEqual(parseDistillReply('{"keep":[]}', 2), []);
});

test('parseDistillReply: anything invalid or out of range → null (caller fails open)', () => {
  assert.equal(parseDistillReply('{"keep":[3]}', 2), null, 'out of range');
  assert.equal(parseDistillReply('{"keep":[0]}', 2), null, 'indices are 1-based');
  assert.equal(parseDistillReply('{"keep":[1.5]}', 2), null, 'non-integer');
  assert.equal(parseDistillReply('{"keep":"all"}', 2), null, 'not a list');
  assert.equal(parseDistillReply('sure, keep them all', 2), null, 'no JSON at all');
});

test('heal: a multi-step repair is distilled — exploration dropped, only the fix commits', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'echo exploring' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: { command: 'echo the-fix' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'Verified. REPAIRED' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
    // 4th request = the distillation call.
    { content: [{ type: 'text', text: '{"keep":[2]}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const healer = await createHealer({ noDario: true, testHooks: { testClient: client, testScreen: SCREEN } });
  try {
    const outcome = await healer.heal(MACRO, 1, 'boom');
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.steps, [{ tool: 'bash', input: { command: 'echo the-fix' } }]);
    // The distill request is tool-less, bounded, and a plain string prompt.
    const distillReq = client.requests[3];
    assert.equal(distillReq.max_tokens, 500);
    assert.equal(distillReq.tools, undefined);
    assert.match(distillReq.messages[0].content, /REPLAYED VERBATIM/);
  } finally {
    healer.close();
  }
});

test('heal: an unusable distillation reply fails OPEN — the full trajectory is kept', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'echo exploring' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: { command: 'echo the-fix' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'Verified. REPAIRED' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'both of them look load-bearing to me' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const healer = await createHealer({ noDario: true, testHooks: { testClient: client, testScreen: SCREEN } });
  try {
    const outcome = await healer.heal(MACRO, 1, 'boom');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.steps.length, 2, 'a garbled reply must never shrink a repair');
  } finally {
    healer.close();
  }
});

test('heal: a single-step repair skips distillation entirely (no extra model call)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  const client = scriptedClient([
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'echo the-fix' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } },
    { content: [{ type: 'text', text: 'Verified. REPAIRED' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } },
  ]);
  const healer = await createHealer({ noDario: true, testHooks: { testClient: client, testScreen: SCREEN } });
  try {
    const outcome = await healer.heal(MACRO, 1, 'boom');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.steps.length, 1);
    assert.equal(client.requests.length, 2, 'loop made 2 requests; no distill call for a 1-step repair');
  } finally {
    healer.close();
  }
});
