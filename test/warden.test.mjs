// Tests for src/util/warden.ts — the hands↔warden bridge. The gate's
// decision logic is exercised with an injected fake firewall (a stand-in
// for warden's guardToolUse) and a fake operator prompt, so no real
// @askalf/warden install is needed. verdictLine is a pure renderer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WardenGate, verdictLine, createWardenGate } from '../dist/util/warden.js';

// The sibling warden checkout, if this repo is laid out beside it (dev box).
// Absent in CI, where the integration test below skips.
const here = dirname(fileURLToPath(import.meta.url));
const siblingWarden = join(here, '..', '..', 'warden');
const wardenAvailable = existsSync(join(siblingWarden, 'src', 'wrap.mjs'));

function mkGate(verdict, guard) {
  const lines = [];
  const gate = new WardenGate({
    guardToolUse: () => verdict,
    policy: {},
    audit: null,
    guard,
    out: (l) => lines.push(l),
  });
  return { gate, lines };
}

// ── verdictLine ─────────────────────────────────────────────────────

test('verdictLine — renders block / approve / allow with the why', () => {
  assert.match(verdictLine('bash', { tool: 'bash', tier: 'black', decision: 'block', why: ['☠ rm -rf /'] }), /black.*BLOCK.*rm -rf/);
  assert.match(verdictLine('read_page', { tool: 'fetch', tier: 'red', decision: 'approve', why: ['⚠ ssrf'] }), /red.*approve.*ssrf/);
  assert.match(verdictLine('bash', { tool: 'shell', tier: 'green', decision: 'allow', why: [] }), /green.*allow/);
});

// ── WardenGate.gate ─────────────────────────────────────────────────

test('gate — allow verdict executes and tallies', async () => {
  const { gate } = mkGate({ tool: 'shell', tier: 'green', decision: 'allow', why: [] });
  const o = await gate.gate({ name: 'bash', input: { command: 'ls' } });
  assert.equal(o.action, 'allow');
  assert.equal(gate.allowed, 1);
});

test('gate — black verdict blocks; model is told not to retry', async () => {
  const { gate } = mkGate({ tool: 'shell', tier: 'black', decision: 'block', why: ['☠ recursive root delete'] });
  const o = await gate.gate({ name: 'bash', input: { command: 'rm -rf /' } });
  assert.equal(o.action, 'deny');
  assert.match(o.reason, /BLOCKED/);
  assert.match(o.reason, /Do not retry/);
  assert.equal(gate.blocked, 1);
});

test('gate — red verdict with no operator attached fails closed', async () => {
  const { gate } = mkGate({ tool: 'fetch', tier: 'red', decision: 'approve', why: ['⚠ internal SSRF'] }); // no guard
  const o = await gate.gate({ name: 'read_page', input: { url: 'http://10.0.0.1/' } });
  assert.equal(o.action, 'deny');
  assert.match(o.reason, /fail-closed/);
  assert.equal(gate.denied, 1);
});

test('gate — red verdict, operator allows', async () => {
  const guard = { decide: async () => ({ kind: 'allow' }) };
  const { gate } = mkGate({ tool: 'shell', tier: 'red', decision: 'approve', why: ['⚠ sudo'] }, guard);
  const o = await gate.gate({ name: 'bash', input: { command: 'sudo apt update' } });
  assert.equal(o.action, 'allow');
  assert.equal(gate.approved, 1);
});

test('gate — red verdict, operator denies', async () => {
  const guard = { decide: async () => ({ kind: 'deny' }) };
  const { gate } = mkGate({ tool: 'shell', tier: 'red', decision: 'approve', why: ['⚠ x'] }, guard);
  const o = await gate.gate({ name: 'bash', input: { command: 'x' } });
  assert.equal(o.action, 'deny');
  assert.equal(gate.denied, 1);
});

test('gate — red verdict, operator quits → abort', async () => {
  const guard = { decide: async () => ({ kind: 'abort' }) };
  const { gate } = mkGate({ tool: 'shell', tier: 'red', decision: 'approve', why: ['x'] }, guard);
  assert.equal((await gate.gate({ name: 'bash', input: {} })).action, 'abort');
});

test('gate — red verdict, operator edits → allow with revised input', async () => {
  const guard = { decide: async () => ({ kind: 'allow', input: { command: 'safer' } }) };
  const { gate } = mkGate({ tool: 'shell', tier: 'red', decision: 'approve', why: ['x'] }, guard);
  const o = await gate.gate({ name: 'bash', input: { command: 'risky' } });
  assert.equal(o.action, 'allow');
  assert.equal(o.input.command, 'safer');
  assert.equal(gate.approved, 1);
});

test('gate — emits a verdict line per call; summary tallies the run', async () => {
  const { gate, lines } = mkGate({ tool: 'shell', tier: 'green', decision: 'allow', why: [] });
  await gate.gate({ name: 'bash', input: { command: 'ls' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /warden: bash/);
  assert.match(gate.summary(), /1 allowed/);
});

// ── real warden, loaded via HANDS_WARDEN_PATH (skips when absent) ────

test('integration: real warden blocks a black command and allows a green one', { skip: !wardenAvailable }, async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'hands-warden-int-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HANDS_WARDEN_PATH: process.env.HANDS_WARDEN_PATH };
  process.env.HOME = tmpHome;          // redirect ~/.warden audit + policy into a throwaway dir
  process.env.USERPROFILE = tmpHome;
  process.env.HANDS_WARDEN_PATH = siblingWarden;
  try {
    const gate = await createWardenGate({ out: () => {} }); // unattended → red fails closed
    const black = await gate.gate({ name: 'bash', input: { command: 'rm -rf /' } });
    assert.equal(black.action, 'deny', 'recursive root delete must be blocked');
    assert.match(black.reason, /BLOCKED/);
    const green = await gate.gate({ name: 'bash', input: { command: 'ls -la' } });
    assert.equal(green.action, 'allow', 'a benign list must pass');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
