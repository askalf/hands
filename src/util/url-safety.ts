// SSRF guard for read_page.
//
// read_page fetches model-chosen URLs. A prompt-injected page can ask
// the agent to "read" http://169.254.169.254/… (cloud metadata) or an
// intranet host — so before fetching we refuse hostnames/addresses in
// private, loopback, link-local, and other special-use ranges, and we
// re-check on every redirect hop.
//
// Operator override: hands is a local tool and reading a localhost
// dashboard is a legitimate ask, so HANDS_ALLOW_PRIVATE_URLS=1 turns
// the guard off — same operator-wins philosophy as the dario
// auto-detect's --no-dario.
//
// Known limit: we check the addresses DNS returns at validation time,
// then fetch() resolves again — a DNS-rebinding attacker who flips the
// record between the two lookups can slip through. Closing that needs
// a custom agent that pins the validated IP; out of proportion for a
// read-only page fetcher, documented here so nobody mistakes this for
// a complete defense.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0 || a === 10 || a === 127) return true;          // "this", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12 private
  if (a === 192 && b === 0 && parts[2] === 0) return true;    // 192.0.0/24 special-use
  if (a === 192 && b === 168) return true;                    // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18/15 benchmarking
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;         // loopback, unspecified
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);               // v4-mapped
  const firstGroup = lower.startsWith('::') ? 0 : parseInt(lower.split(':')[0]!, 16);
  if ((firstGroup & 0xfe00) === 0xfc00) return true;          // fc00::/7 ULA
  if ((firstGroup & 0xffc0) === 0xfe80) return true;          // fe80::/10 link-local
  return false;
}

/** True when `ip` is in a private / loopback / link-local / special-use range. Pure — exported for tests. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

/** True for hostnames that are internal by name, before any DNS. Pure — exported for tests. */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal') return true;
  return false;
}

export interface UrlSafetyOptions {
  /** Test hook — replaces the DNS lookup. */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Explicit override; defaults to the HANDS_ALLOW_PRIVATE_URLS env switch. */
  allowPrivate?: boolean;
}

/**
 * Throw if the URL's host is private/internal — by name, by IP
 * literal, or by any address its DNS resolves to.
 */
export async function assertPublicUrl(parsed: URL, opts: UrlSafetyOptions = {}): Promise<void> {
  const allowPrivate = opts.allowPrivate ?? process.env['HANDS_ALLOW_PRIVATE_URLS'] === '1';
  if (allowPrivate) return;

  const refusal = (detail: string) =>
    new Error(`Blocked: ${parsed.href} targets a private/internal address (${detail}). ` +
      'read_page only fetches public URLs; set HANDS_ALLOW_PRIVATE_URLS=1 to allow internal targets.');

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // URL keeps brackets on IPv6 literals

  if (isBlockedHostname(hostname)) {
    throw refusal(hostname);
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw refusal(hostname);
    return;
  }

  const lookupAll = opts.lookupFn
    ?? (async (h: string) => lookup(h, { all: true, verbatim: true }));
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupAll(hostname);
  } catch {
    throw new Error(`DNS lookup failed for ${hostname}`);
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw refusal(`${hostname} → ${address}`);
  }
}
