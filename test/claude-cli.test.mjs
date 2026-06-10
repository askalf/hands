import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pickClaudeInvocation } from '../dist/platform/claude-cli.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SHIM_DIR = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const PKG_DIR = join(SHIM_DIR, 'node_modules', '@anthropic-ai', 'claude-code');

test('a claude.exe on PATH wins outright', () => {
  const inv = pickClaudeInvocation(
    ['C:\\Tools\\claude.exe', join(SHIM_DIR, 'claude.cmd')],
    () => true,
    NODE,
  );
  assert.deepEqual(inv, { command: 'C:\\Tools\\claude.exe', prefixArgs: [] });
});

test('npm .cmd shim resolves to the packaged native binary (current layout)', () => {
  const packagedExe = join(PKG_DIR, 'bin', 'claude.exe');
  const inv = pickClaudeInvocation(
    [join(SHIM_DIR, 'claude.ps1'), join(SHIM_DIR, 'claude.cmd'), join(SHIM_DIR, 'claude')],
    (p) => p === packagedExe,
    NODE,
  );
  assert.deepEqual(inv, { command: packagedExe, prefixArgs: [] });
});

test('npm .cmd shim falls back to cli.js through node (older layout)', () => {
  const cliJs = join(PKG_DIR, 'cli.js');
  const inv = pickClaudeInvocation(
    [join(SHIM_DIR, 'claude.cmd')],
    (p) => p === cliJs,
    NODE,
  );
  assert.deepEqual(inv, { command: NODE, prefixArgs: [cliJs] });
});

test('unresolvable shim falls back to the bare name', () => {
  const inv = pickClaudeInvocation([join(SHIM_DIR, 'claude.cmd')], () => false, NODE);
  assert.deepEqual(inv, { command: 'claude', prefixArgs: [] });
});

test('no where output falls back to the bare name', () => {
  const inv = pickClaudeInvocation([], () => true, NODE);
  assert.deepEqual(inv, { command: 'claude', prefixArgs: [] });
});

test('whitespace and empty where lines are ignored', () => {
  const inv = pickClaudeInvocation(['', '  ', '\r'], () => true, NODE);
  assert.deepEqual(inv, { command: 'claude', prefixArgs: [] });
});

test('extension matching is case-insensitive', () => {
  const inv = pickClaudeInvocation(['C:\\Tools\\CLAUDE.EXE'], () => false, NODE);
  assert.deepEqual(inv, { command: 'C:\\Tools\\CLAUDE.EXE', prefixArgs: [] });
});
