/**
 * Auto-detect a running dario proxy on startup. If ANTHROPIC_BASE_URL
 * is already set we respect it (operator override wins). Otherwise
 * probe the canonical localhost:3456 endpoint; if dario is up and
 * responds within the timeout, set ANTHROPIC_BASE_URL so the
 * Anthropic SDK routes through it. Result: hands users on a Max/Pro
 * subscription get OAuth subscription billing automatically when
 * dario is running, without having to remember to `export
 * ANTHROPIC_BASE_URL=...` first.
 *
 * Probe target is dario's `/health` endpoint (already used by
 * hands doctor — same shape, same timeout class).
 */

const DEFAULT_DARIO_URL = 'http://localhost:3456';
// 2s is enough for dario's first /health response on a cold proxy
// (which does account-pool + template-state checks on first hit;
// observed ~840ms on a healthy local instance). Subsequent hits are
// much faster but the auto-detect runs once per `hands run`, so we
// budget for the cold-path. Hands startup already takes a few
// seconds for screenshot capture + config load, so 2s here is not
// the dominant latency.
const PROBE_TIMEOUT_MS = 2000;

export interface DarioDetectResult {
  /** What's now in process.env.ANTHROPIC_BASE_URL after this call. */
  baseUrl: string | undefined;
  /** Whether this call modified the env var. */
  detected: boolean;
  /** Human-readable explanation of what happened, for log lines. */
  detail: string;
}

/**
 * Probe dario at the default (or DARIO_URL-overridden) endpoint and
 * mutate process.env.ANTHROPIC_BASE_URL if it's reachable. Returns a
 * structured result suitable for logging.
 *
 * Skipped if:
 *   - opts.disabled === true (operator opted out via --no-dario)
 *   - ANTHROPIC_BASE_URL is already set (operator chose explicit
 *     routing; we don't override)
 *
 * The probe failure is silent — we don't error or warn, because the
 * common "no dario running" case is normal and should fall through
 * to direct api.anthropic.com routing.
 */
export async function autoDetectDario(opts: {
  disabled?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<DarioDetectResult> {
  const existing = process.env['ANTHROPIC_BASE_URL'];
  if (existing) {
    return {
      baseUrl: existing,
      detected: false,
      detail: `ANTHROPIC_BASE_URL already set to ${existing} — respecting operator override`,
    };
  }
  if (opts.disabled) {
    return {
      baseUrl: undefined,
      detected: false,
      detail: 'auto-detect disabled (--no-dario)',
    };
  }

  // Normalize before use AND before export — a trailing slash in
  // HANDS_DARIO_URL would otherwise leak into ANTHROPIC_BASE_URL and
  // produce double-slash request paths in the SDK.
  const target = trimTrailingSlash(process.env['HANDS_DARIO_URL'] || DEFAULT_DARIO_URL);
  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(`${target}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      process.env['ANTHROPIC_BASE_URL'] = target;
      return {
        baseUrl: target,
        detected: true,
        detail: `auto-detected dario at ${target} — routing through it for subscription billing`,
      };
    }
    return {
      baseUrl: undefined,
      detected: false,
      detail: `dario probe at ${target}/health returned ${res.status} — falling through to api.anthropic.com`,
    };
  } catch {
    // Network error / timeout / connection refused — the common "no
    // dario running" case. Silent fall-through.
    return {
      baseUrl: undefined,
      detected: false,
      detail: `no dario reachable at ${target} — using api.anthropic.com directly`,
    };
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
