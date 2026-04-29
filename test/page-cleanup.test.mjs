// Unit tests for the cleanHtml pipeline. Pure function, no network,
// no LLM — exercises the strip / resolve / size-cap behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtml } from '../dist/util/page-cleanup.js';

const BASE = 'https://example.com/page/';

test('strips <script> tags entirely', () => {
  const r = cleanHtml('<html><body><p>hi</p><script>alert(1)</script></body></html>', BASE);
  assert.match(r.html, /<p>hi<\/p>/);
  assert.doesNotMatch(r.html, /alert\(1\)/);
  assert.doesNotMatch(r.html, /<script/);
});

test('strips <style>, <iframe>, <svg>, <canvas>', () => {
  const r = cleanHtml(
    '<html><body><p>visible</p><style>p{color:red}</style><iframe src="x"></iframe><svg><circle/></svg><canvas></canvas></body></html>',
    BASE,
  );
  assert.match(r.html, /visible/);
  assert.doesNotMatch(r.html, /color:red/);
  assert.doesNotMatch(r.html, /<iframe/);
  assert.doesNotMatch(r.html, /<svg/);
  assert.doesNotMatch(r.html, /<canvas/);
});

test('resolves relative href to absolute URL using base', () => {
  const r = cleanHtml('<html><body><a href="/foo">link</a></body></html>', 'https://example.com/page/');
  assert.match(r.html, /href="https:\/\/example\.com\/foo"/);
});

test('preserves absolute hrefs verbatim', () => {
  const r = cleanHtml('<html><body><a href="https://other.com/x">link</a></body></html>', BASE);
  assert.match(r.html, /href="https:\/\/other\.com\/x"/);
});

test('resolves relative href in a different parent path', () => {
  const r = cleanHtml('<html><body><a href="bar">link</a></body></html>', 'https://example.com/page/');
  assert.match(r.html, /href="https:\/\/example\.com\/page\/bar"/);
});

test('resolves protocol-relative URL using base protocol', () => {
  const r = cleanHtml('<html><body><a href="//cdn.example.com/x.js">link</a></body></html>', BASE);
  assert.match(r.html, /href="https:\/\/cdn\.example\.com\/x\.js"/);
});

test('keeps fragment identifiers as-is', () => {
  const r = cleanHtml('<html><body><a href="#section">link</a></body></html>', BASE);
  assert.match(r.html, /href="#section"/);
});

test('strips presentational class/style/aria attributes', () => {
  const r = cleanHtml(
    '<html><body><div class="banner" style="color:red" aria-label="hi" data-testid="x">content</div></body></html>',
    BASE,
  );
  assert.match(r.html, /<div>content<\/div>/);
  assert.doesNotMatch(r.html, /class=/);
  assert.doesNotMatch(r.html, /style=/);
  assert.doesNotMatch(r.html, /aria-label=/);
  assert.doesNotMatch(r.html, /data-testid=/);
});

test('strips event handler attributes (onclick, onload, etc.)', () => {
  const r = cleanHtml('<html><body><button onclick="bad()">click</button></body></html>', BASE);
  assert.doesNotMatch(r.html, /onclick=/);
  assert.match(r.html, /<button>click<\/button>/);
});

test('strips HTML comments', () => {
  const r = cleanHtml('<html><body><!-- secret --><p>visible</p><!-- ie hack --></body></html>', BASE);
  assert.match(r.html, /visible/);
  assert.doesNotMatch(r.html, /secret/);
  assert.doesNotMatch(r.html, /ie hack/);
});

test('inlines lazy-loaded image data-src to src', () => {
  const r = cleanHtml(
    '<html><body><img src="placeholder.gif" data-src="real.jpg" alt="x"></body></html>',
    'https://example.com/page/',
  );
  assert.match(r.html, /src="https:\/\/example\.com\/page\/real\.jpg"/);
  assert.doesNotMatch(r.html, /data-src/);
});

test('extracts <title> into structured.meta', () => {
  const r = cleanHtml('<html><head><title>The Title</title></head><body><p>x</p></body></html>', BASE);
  assert.equal(r.structured.meta.title, 'The Title');
});

test('extracts og: and twitter: meta tags', () => {
  const r = cleanHtml(
    '<html><head><meta property="og:title" content="OG"><meta name="twitter:card" content="summary"><meta name="ignored" content="xxx"></head><body><p>x</p></body></html>',
    BASE,
  );
  assert.equal(r.structured.meta['og:title'], 'OG');
  assert.equal(r.structured.meta['twitter:card'], 'summary');
  assert.equal(r.structured.meta['ignored'], undefined);
});

test('parses JSON-LD blocks, skips malformed ones', () => {
  const r = cleanHtml(
    '<html><head><script type="application/ld+json">{"@type":"Article","name":"hi"}</script><script type="application/ld+json">not json</script></head><body><p>x</p></body></html>',
    BASE,
  );
  assert.equal(r.structured.jsonLd.length, 1);
  assert.equal(r.structured.jsonLd[0].name, 'hi');
});

test('truncates HTML at maxBytes with marker', () => {
  const big = '<html><body><p>' + 'x'.repeat(200_000) + '</p></body></html>';
  const r = cleanHtml(big, BASE, { maxBytes: 1000 });
  assert.equal(r.stats.truncated, true);
  assert.ok(r.html.length <= 1500, `expected ~1000-byte cap, got ${r.html.length}`);
  assert.match(r.html, /HTML truncated at 1000 bytes/);
});

test('does not truncate when content is under cap', () => {
  const r = cleanHtml('<html><body><p>short</p></body></html>', BASE);
  assert.equal(r.stats.truncated, false);
  assert.doesNotMatch(r.html, /truncated at/);
});

test('removes elements with cookie/consent in class or id', () => {
  const r = cleanHtml(
    '<html><body><div class="cookie-banner">accept!</div><div id="consent-modal">consent</div><p>real content</p></body></html>',
    BASE,
  );
  assert.match(r.html, /real content/);
  assert.doesNotMatch(r.html, /accept!/);
  assert.doesNotMatch(r.html, /consent-modal/);
});
