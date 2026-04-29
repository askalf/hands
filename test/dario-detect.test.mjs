// Unit tests for autoDetectDario — exercises every branch of the
// startup probe with a fakeFetch so the test doesn't depend on a
// live dario being up (or not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDetectDario } from '../dist/dario-detect.js';

const ENV_KEY = 'ANTHROPIC_BASE_URL';
const HANDS_DARIO_URL_KEY = 'HANDS_DARIO_URL';

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

function clearEnv() {
  delete process.env[ENV_KEY];
  delete process.env[HANDS_DARIO_URL_KEY];
}

test('respects pre-existing ANTHROPIC_BASE_URL — does not override', async () => {
  clearEnv();
  process.env[ENV_KEY] = 'http://operator-set:9999';
  let probeCalled = false;
  const result = await autoDetectDario({
    fetchImpl: fakeFetch(() => { probeCalled = true; return { ok: true, status: 200 }; }),
  });
  assert.equal(result.baseUrl, 'http://operator-set:9999');
  assert.equal(result.detected, false);
  assert.equal(probeCalled, false, 'should not probe when env var already set');
  assert.equal(process.env[ENV_KEY], 'http://operator-set:9999');
  clearEnv();
});

test('disabled=true — skips the probe entirely', async () => {
  clearEnv();
  let probeCalled = false;
  const result = await autoDetectDario({
    disabled: true,
    fetchImpl: fakeFetch(() => { probeCalled = true; return { ok: true, status: 200 }; }),
  });
  assert.equal(result.baseUrl, undefined);
  assert.equal(result.detected, false);
  assert.equal(probeCalled, false);
  assert.equal(process.env[ENV_KEY], undefined);
  clearEnv();
});

test('successful probe — sets ANTHROPIC_BASE_URL and reports detected=true', async () => {
  clearEnv();
  let probeUrl;
  const result = await autoDetectDario({
    fetchImpl: fakeFetch((url) => { probeUrl = url; return { ok: true, status: 200 }; }),
  });
  assert.equal(result.detected, true);
  assert.equal(result.baseUrl, 'http://localhost:3456');
  assert.equal(process.env[ENV_KEY], 'http://localhost:3456');
  assert.equal(probeUrl, 'http://localhost:3456/health');
  clearEnv();
});

test('non-OK response — does NOT set env var', async () => {
  clearEnv();
  const result = await autoDetectDario({
    fetchImpl: fakeFetch(() => ({ ok: false, status: 503 })),
  });
  assert.equal(result.detected, false);
  assert.equal(result.baseUrl, undefined);
  assert.equal(process.env[ENV_KEY], undefined);
  assert.match(result.detail, /503/);
  clearEnv();
});

test('network error — silent fall-through, no env var set', async () => {
  clearEnv();
  const result = await autoDetectDario({
    fetchImpl: fakeFetch(() => { throw new Error('ECONNREFUSED'); }),
  });
  assert.equal(result.detected, false);
  assert.equal(result.baseUrl, undefined);
  assert.equal(process.env[ENV_KEY], undefined);
  assert.match(result.detail, /no dario reachable/);
  clearEnv();
});

test('HANDS_DARIO_URL override — probes that URL instead of default', async () => {
  clearEnv();
  process.env[HANDS_DARIO_URL_KEY] = 'http://my-server:8080';
  let probeUrl;
  const result = await autoDetectDario({
    fetchImpl: fakeFetch((url) => { probeUrl = url; return { ok: true, status: 200 }; }),
  });
  assert.equal(result.detected, true);
  assert.equal(result.baseUrl, 'http://my-server:8080');
  assert.equal(probeUrl, 'http://my-server:8080/health');
  clearEnv();
});

test('HANDS_DARIO_URL with trailing slash — slash is trimmed before /health is appended', async () => {
  clearEnv();
  process.env[HANDS_DARIO_URL_KEY] = 'http://my-server:8080/';
  let probeUrl;
  await autoDetectDario({
    fetchImpl: fakeFetch((url) => { probeUrl = url; return { ok: true, status: 200 }; }),
  });
  assert.equal(probeUrl, 'http://my-server:8080/health');
  clearEnv();
});
