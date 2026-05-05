// Unit tests for the find_files tool. Pure filesystem walking, no
// network — exercises name-glob matching, grep mode, default excludes,
// and size / depth caps using a tmp-dir fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFiles, globToRegex } from '../dist/tools/find-files.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hands-find-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'src', 'sub'));
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'node_modules', 'pkg'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'README.md'), '# title\nhello world\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const foo = 1;\nexport const bar = 2;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'import { foo } from "./a";\nfoo();\n');
  writeFileSync(join(root, 'src', 'sub', 'c.ts'), 'const baz = "foo";\n');
  writeFileSync(join(root, 'src', 'd.js'), 'const x = 1;\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return root;
}

test('globToRegex — * matches any chars except slash', () => {
  const re = globToRegex('*.ts');
  assert.ok(re.test('a.ts'));
  assert.ok(re.test('foo.bar.ts'));
  assert.ok(!re.test('a.js'));
  assert.ok(!re.test('a/b.ts'));
});

test('globToRegex — ? matches single char', () => {
  const re = globToRegex('?.txt');
  assert.ok(re.test('a.txt'));
  assert.ok(!re.test('ab.txt'));
  assert.ok(!re.test('.txt'));
});

test('globToRegex — {a,b} alternation', () => {
  const re = globToRegex('{a,b}.md');
  assert.ok(re.test('a.md'));
  assert.ok(re.test('b.md'));
  assert.ok(!re.test('c.md'));
});

test('globToRegex — escapes regex meta chars', () => {
  const re = globToRegex('a.b+c');
  assert.ok(re.test('a.b+c'));
  assert.ok(!re.test('aXbXc'));
});

test('findFiles — list mode with name_pattern', async () => {
  const root = makeFixture();
  try {
    const r = await findFiles({ path: root, namePattern: '*.ts' });
    assert.equal(r.meta.matched, 3, `expected 3 .ts files, got ${r.meta.matched}`);
    assert.match(r.text, /a\.ts/);
    assert.match(r.text, /b\.ts/);
    assert.match(r.text, /c\.ts/);
    assert.doesNotMatch(r.text, /d\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles — skips node_modules and .git by default', async () => {
  const root = makeFixture();
  try {
    const r = await findFiles({ path: root, namePattern: '*' });
    assert.doesNotMatch(r.text, /node_modules/);
    assert.doesNotMatch(r.text, /\.git/);
    assert.doesNotMatch(r.text, /index\.js/);
    assert.doesNotMatch(r.text, /HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles — grep mode returns file:line:content matches', async () => {
  const root = makeFixture();
  try {
    const r = await findFiles({ path: root, namePattern: '*.ts', grep: 'foo' });
    // a.ts line 1 (foo = 1), b.ts line 1 (import foo), b.ts line 2 (foo()), c.ts line 1 (baz = "foo")
    assert.ok(r.meta.matched >= 4, `expected ≥4 matches, got ${r.meta.matched}`);
    assert.match(r.text, /a\.ts:1:.*foo/);
    assert.match(r.text, /b\.ts:1:.*foo/);
    assert.match(r.text, /Grep: \/foo\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles — grep with no matches', async () => {
  const root = makeFixture();
  try {
    const r = await findFiles({ path: root, namePattern: '*.ts', grep: 'definitely_not_there_xyzzy' });
    assert.equal(r.meta.matched, 0);
    assert.match(r.text, /\(no matches\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles — respects maxResults in list mode', async () => {
  const root = makeFixture();
  try {
    const r = await findFiles({ path: root, namePattern: '*.ts', maxResults: 2 });
    // Walker may scan more; meta.matched is total found, but rendered list caps at 2.
    const fileLines = r.text.split('\n').filter(l => l.endsWith('B)'));
    assert.equal(fileLines.length, 2);
    assert.match(r.text, /\[\.\.\.truncated\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles — invalid grep regex throws clean error', async () => {
  const root = makeFixture();
  try {
    await assert.rejects(
      () => findFiles({ path: root, grep: '[invalid(' }),
      /Invalid grep regex/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles — missing path throws clean error', async () => {
  await assert.rejects(
    () => findFiles({ path: '/nonexistent/path/that/should/not/exist/xyzzy' }),
    /Path not found/,
  );
});

test('findFiles — list mode with no name_pattern lists all files', async () => {
  const root = makeFixture();
  try {
    const r = await findFiles({ path: root });
    // README.md + 3 .ts + 1 .js = 5 (node_modules + .git skipped)
    assert.equal(r.meta.matched, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
