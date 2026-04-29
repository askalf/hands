// Unit tests for the persona resolver. Bundled set is exercised
// against the real loader; user-file overrides are exercised via
// HOME-redirect into a tmp dir; explicit path uses a tmp file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePersona, resolveSystemPromptFile, listBundledNames } from '../dist/personas.js';

test('listBundledNames — returns the canonical bundled set', () => {
  const names = listBundledNames();
  assert.ok(names.includes('minimal'), 'minimal should be bundled');
  assert.ok(names.includes('thorough'), 'thorough should be bundled');
  assert.ok(names.includes('concise'), 'concise should be bundled');
  assert.ok(names.includes('security-aware'), 'security-aware should be bundled');
});

test('resolvePersona — bundled name resolves to bundled prompt', async () => {
  const r = await resolvePersona('minimal');
  assert.equal(r.source, 'bundled');
  assert.equal(r.label, 'minimal');
  assert.ok(r.prompt.length > 0, 'should have non-empty prompt');
  assert.match(r.prompt, /computer control agent/i);
});

test('resolvePersona — unknown name throws with bundled set listed', async () => {
  await assert.rejects(
    () => resolvePersona('does-not-exist'),
    (err) => {
      assert.match(err.message, /not found/);
      assert.match(err.message, /bundled set/);
      assert.match(err.message, /minimal/, 'bundled set should mention minimal');
      return true;
    },
  );
});

test('resolvePersona — user-file override takes precedence over bundled', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'hands-persona-test-'));
  const personasDir = join(fakeHome, '.hands', 'personas');
  mkdirSync(personasDir, { recursive: true });
  // Override the bundled "minimal" with custom content
  writeFileSync(join(personasDir, 'minimal.md'), 'CUSTOM USER OVERRIDE TEXT', 'utf-8');

  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  try {
    const r = await resolvePersona('minimal');
    assert.equal(r.source, 'user-file');
    assert.equal(r.label, 'minimal');
    assert.equal(r.prompt, 'CUSTOM USER OVERRIDE TEXT');
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile; else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolvePersona — user file content is trimmed', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'hands-persona-trim-'));
  const personasDir = join(fakeHome, '.hands', 'personas');
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'whitey.md'), '\n\n   prompt-body   \n\n', 'utf-8');

  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  try {
    const r = await resolvePersona('whitey');
    assert.equal(r.prompt, 'prompt-body');
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile; else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolveSystemPromptFile — reads + trims an explicit path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hands-syspath-'));
  const path = join(dir, 'mine.txt');
  writeFileSync(path, '\n\nyou are an agent\n', 'utf-8');

  try {
    const r = await resolveSystemPromptFile(path);
    assert.equal(r.source, 'explicit-path');
    assert.equal(r.label, path);
    assert.equal(r.prompt, 'you are an agent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSystemPromptFile — missing file throws an Error', async () => {
  await assert.rejects(
    () => resolveSystemPromptFile('/nonexistent/path/that/does/not/exist.md'),
  );
});
