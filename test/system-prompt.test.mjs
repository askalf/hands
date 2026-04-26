// Tests for the OS-aware system-prompt builders. Pin the contract that
//   - the right OS label appears in the header
//   - OS-specific shell guidance gets composed in
//   - shared frame elements (self-correction rules, anti-patterns,
//     guardrails, sessionContext for CLI) are present regardless of OS
//   - normalizePlatform falls back safely on unknown values

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePlatform,
  buildCliSystemPrompt,
  buildSdkSystemPrompt,
} from '../dist/system-prompt.js';

// ── normalizePlatform ───────────────────────────────────────────────

test('normalizePlatform — known values pass through', () => {
  assert.equal(normalizePlatform('win32'),  'win32');
  assert.equal(normalizePlatform('darwin'), 'darwin');
  assert.equal(normalizePlatform('linux'),  'linux');
});

test('normalizePlatform — unknown values fall back to linux', () => {
  // Linux is the safest default for non-Win/non-Mac Unix variants
  // (FreeBSD, OpenBSD, etc. all have bash + coreutils).
  assert.equal(normalizePlatform('freebsd'), 'linux');
  assert.equal(normalizePlatform('openbsd'), 'linux');
  assert.equal(normalizePlatform('aix'),     'linux');
  assert.equal(normalizePlatform(''),        'linux');
  assert.equal(normalizePlatform('garbage'), 'linux');
});

// ── buildCliSystemPrompt — OS-specific content branching ────────────

test('buildCliSystemPrompt(win32) — Windows label + PowerShell guidance', () => {
  const p = buildCliSystemPrompt('win32', '');
  assert.match(p, /FULL access to this Windows machine/);
  assert.match(p, /PowerShell-First Approach/);
  assert.match(p, /Start-Process/);
  assert.match(p, /Windows 11 Store Redirect/);
  // Negative checks — Mac/Linux content must not leak in
  assert.doesNotMatch(p, /open -a "Calculator"/);
  assert.doesNotMatch(p, /xdotool type/);
});

test('buildCliSystemPrompt(darwin) — macOS label + open(1) / osascript guidance', () => {
  const p = buildCliSystemPrompt('darwin', '');
  assert.match(p, /FULL access to this macOS machine/);
  assert.match(p, /open -a "Calculator"/);
  assert.match(p, /osascript -e/);
  assert.match(p, /pbcopy/);
  // The Windows-Gotchas section must not be present as guidance; the
  // prompts may still mention Start-Process / xdotool in the
  // "wrong-OS" anti-pattern callouts ("don't try Start-Process,
  // that's PowerShell only"), so we look for the section header
  // rather than any literal token.
  assert.doesNotMatch(p, /## Windows Gotchas/);
  assert.doesNotMatch(p, /## Linux App Launch/);
});

test('buildCliSystemPrompt(linux) — Linux label + xdotool / ydotool / display-server detection', () => {
  const p = buildCliSystemPrompt('linux', '');
  assert.match(p, /FULL access to this Linux machine/);
  assert.match(p, /xdotool type/);
  assert.match(p, /ydotool/);
  assert.match(p, /WAYLAND_DISPLAY/);
  assert.match(p, /xdg-open/);
  assert.doesNotMatch(p, /## Windows Gotchas/);
  assert.doesNotMatch(p, /## macOS App Launch/);
});

// ── buildCliSystemPrompt — shared frame across all platforms ────────

test('buildCliSystemPrompt — shared frame is present on every OS', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const p = buildCliSystemPrompt(platform, '');
    assert.match(p, /Self-Correction Rules/, `[${platform}] missing self-correction`);
    assert.match(p, /Anti-patterns — NEVER DO THESE/, `[${platform}] missing anti-patterns`);
    assert.match(p, /When Screenshots ARE Appropriate/, `[${platform}] missing screenshot rules`);
    // GUARDRAIL_PROMPT is appended at the end — pin a stable token
    // that has been part of the guardrail copy since v0.1.0.
    assert.match(p, /Guardrails|guardrails|destructive/, `[${platform}] missing guardrail content`);
  }
});

test('buildCliSystemPrompt — sessionContext is appended, not interpolated mid-prompt', () => {
  const ctx = '\n## Recent session\n- Did a thing\n- Then another thing';
  const p = buildCliSystemPrompt('linux', ctx);
  assert.ok(p.includes(ctx), 'sessionContext must appear in the output');
  assert.ok(p.endsWith(ctx), 'sessionContext must be at the end (post-guardrails)');
});

test('buildCliSystemPrompt — empty sessionContext does not produce a trailing-space artifact', () => {
  const p = buildCliSystemPrompt('linux', '');
  // Tolerable: trailing newline. Not tolerable: random whitespace bloat.
  assert.ok(p.length > 1000, 'prompt should still be substantial without context');
  assert.ok(!p.endsWith('  \n'), 'no double-trailing-space artifact');
});

// ── buildSdkSystemPrompt — OS-specific content branching ────────────

test('buildSdkSystemPrompt(win32) — Windows label + PowerShell guidance, shorter than CLI', () => {
  const p = buildSdkSystemPrompt('win32');
  assert.match(p, /computer control agent on Windows/);
  assert.match(p, /Start-Process/);
  assert.match(p, /Windows Gotchas/);
  assert.doesNotMatch(p, /open -a "Calculator"/);
  assert.doesNotMatch(p, /xdotool type/);
});

test('buildSdkSystemPrompt(darwin) — macOS label + open(1) / osascript guidance', () => {
  const p = buildSdkSystemPrompt('darwin');
  assert.match(p, /computer control agent on macOS/);
  assert.match(p, /open -a "Calculator"/);
  assert.match(p, /osascript/);
  assert.doesNotMatch(p, /## Windows Gotchas/);
  assert.doesNotMatch(p, /## Linux Gotchas/);
});

test('buildSdkSystemPrompt(linux) — Linux label + xdotool / ydotool / display-server detection', () => {
  const p = buildSdkSystemPrompt('linux');
  assert.match(p, /computer control agent on Linux/);
  assert.match(p, /xdotool/);
  assert.match(p, /ydotool/);
  assert.match(p, /WAYLAND_DISPLAY/);
  assert.doesNotMatch(p, /## Windows Gotchas/);
  assert.doesNotMatch(p, /## macOS Gotchas/);
});

test('buildSdkSystemPrompt — bash-tool framing on every OS (pre-feature behavior preserved)', () => {
  // Pre-feature, the SDK prompt opened with "Use the bash tool with
  // PowerShell commands". Post-feature, the framing is generic shell
  // commands — but the "use bash tool over computer tool" guidance is
  // the same on every OS.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const p = buildSdkSystemPrompt(platform);
    assert.match(p, /bash tool with shell commands/, `[${platform}] bash-tool guidance missing`);
    assert.match(p, /Prefer bash tool over computer tool/, `[${platform}] preference rule missing`);
    assert.match(p, /screenshot-click loops/, `[${platform}] anti-screenshot framing missing`);
    assert.match(p, /destructive|Guardrails|guardrails/, `[${platform}] guardrail content missing`);
  }
});

// ── Cross-OS leak guards (regression: the bug we just fixed) ────────

test('regression — Mac / Linux prompts do not claim "Windows machine" in the header', () => {
  // Pre-fix, both CLI and SDK prompts opened with "Windows machine"
  // (CLI: "FULL access to this Windows machine") regardless of OS.
  // Pin the fix so a future "let's hardcode Windows for simplicity"
  // PR breaks the test instead of shipping silent Windows-on-Mac
  // behavior. We don't ban the word "Windows" — the macOS and Linux
  // prompts deliberately reference it in anti-pattern callouts
  // ("don't try Windows commands on macOS"). We ban the specific
  // string that was the bug.
  assert.doesNotMatch(buildCliSystemPrompt('darwin', ''), /FULL access to this Windows machine/);
  assert.doesNotMatch(buildCliSystemPrompt('linux',  ''), /FULL access to this Windows machine/);
  assert.doesNotMatch(buildSdkSystemPrompt('darwin'),    /computer control agent on Windows/);
  assert.doesNotMatch(buildSdkSystemPrompt('linux'),     /computer control agent on Windows/);
});
