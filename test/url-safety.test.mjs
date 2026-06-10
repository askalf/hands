import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, isBlockedHostname, assertPublicUrl } from '../dist/util/url-safety.js';

test('isPrivateIp — private/special IPv4 ranges', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.255',   // loopback
    '10.0.0.1', '10.255.255.255',     // 10/8
    '172.16.0.1', '172.31.255.255',   // 172.16/12
    '192.168.1.1',                    // 192.168/16
    '169.254.169.254',                // link-local incl. cloud metadata
    '100.64.0.1', '100.127.255.255',  // CGNAT
    '0.0.0.0',
    '192.0.0.1',                      // 192.0.0/24 special-use
    '198.18.0.1', '198.19.255.255',   // benchmarking
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp — public IPv4 stays public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.169.0.1', '198.20.0.1', '11.0.0.1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('isPrivateIp — IPv6 loopback, ULA, link-local, v4-mapped', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.5']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('isPrivateIp — non-IP strings are not classified', () => {
  assert.equal(isPrivateIp('example.com'), false);
  assert.equal(isPrivateIp(''), false);
});

test('isBlockedHostname — localhost names and cloud metadata host', () => {
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('LOCALHOST'), true);
  assert.equal(isBlockedHostname('foo.localhost'), true);
  assert.equal(isBlockedHostname('localhost.'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('example.com'), false);
  assert.equal(isBlockedHostname('notlocalhost.com'), false);
});

test('assertPublicUrl — rejects IP literals in private ranges', async () => {
  await assert.rejects(() => assertPublicUrl(new URL('http://169.254.169.254/latest/meta-data/')), /private\/internal/);
  await assert.rejects(() => assertPublicUrl(new URL('http://127.0.0.1:8080/admin')), /private\/internal/);
  await assert.rejects(() => assertPublicUrl(new URL('http://[::1]/')), /private\/internal/);
});

test('assertPublicUrl — rejects blocked hostnames before DNS', async () => {
  let lookedUp = false;
  await assert.rejects(
    () => assertPublicUrl(new URL('http://localhost:3000/'), { lookupFn: async () => { lookedUp = true; return []; } }),
    /private\/internal/,
  );
  assert.equal(lookedUp, false, 'should refuse by name without resolving');
});

test('assertPublicUrl — rejects hostnames resolving to private addresses', async () => {
  await assert.rejects(
    () => assertPublicUrl(new URL('http://internal.example.com/'), {
      lookupFn: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.7' }],
    }),
    /private\/internal/,
  );
});

test('assertPublicUrl — passes public hostnames', async () => {
  await assertPublicUrl(new URL('https://example.com/page'), {
    lookupFn: async () => [{ address: '93.184.216.34' }],
  });
});

test('assertPublicUrl — DNS failure is its own error', async () => {
  await assert.rejects(
    () => assertPublicUrl(new URL('http://nxdomain.example.com/'), {
      lookupFn: async () => { throw new Error('ENOTFOUND'); },
    }),
    /DNS lookup failed/,
  );
});

test('assertPublicUrl — allowPrivate override skips every check', async () => {
  await assertPublicUrl(new URL('http://169.254.169.254/'), { allowPrivate: true });
  await assertPublicUrl(new URL('http://localhost/'), { allowPrivate: true });
});
