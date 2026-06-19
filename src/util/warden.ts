// warden integration — route hands' SDK-mode tool calls through warden's
// policy firewall (`hands run --warden`). Part of Own Your Stack: the same
// guard that fronts Claude Code, the platform forge, and MCP servers also
// fronts hands' computer-use loop.
//
// Each tool_use is classified by warden (green / yellow / red / black):
//   black  → blocked outright (the model is told, and adapts or stops)
//   red    → held for the operator (reuses the --guard prompt when a TTY is
//            attached; fail-closed when unattended)
//   green/yellow → allowed
// Every verdict is appended to warden's tamper-evident, hash-chained audit
// at ~/.warden/audit.jsonl — the same log warden's other surfaces write.
//
// warden is an OPTIONAL integration: it isn't a hands dependency (the core
// six stay six). `--warden` loads `@askalf/warden` dynamically and errors
// helpfully if it isn't installed. Until warden is on npm, point hands at a
// local checkout with HANDS_WARDEN_PATH. The bridge is split so the gate's
// decision logic is unit-testable with an injected fake firewall — no real
// warden needed for tests.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { previewToolUse, type GuardController } from './guard.js';

/** A warden verdict (subset hands reads). Mirrors warden's `check()` return. */
export interface WardenVerdict {
  tool: string;
  tier: string; // green | yellow | red | black
  decision: 'allow' | 'approve' | 'block';
  why: string[];
}

interface WardenAuditLog {
  record(rec: unknown): unknown;
}

/** The slice of warden's API the bridge calls. Loaded dynamically. */
export interface WardenApi {
  guardToolUse(
    toolUse: { name: string; input?: Record<string, unknown> | undefined },
    policy: unknown,
    opts: { audit?: WardenAuditLog | undefined },
  ): WardenVerdict;
  loadPolicy(path: string): unknown;
  ChainedFileAudit: new (path: string) => WardenAuditLog;
}

/** What the SDK loop does with a tool call after warden weighs in. */
export type WardenOutcome =
  | { action: 'allow'; input?: Record<string, unknown> | undefined }
  | { action: 'deny'; reason: string }
  | { action: 'abort' };

/**
 * Load warden's API. Resolution order: an explicit HANDS_WARDEN_PATH
 * checkout, then the installed `@askalf/warden` package. Specifiers are
 * built as non-literal expressions so the TypeScript compiler doesn't try
 * to resolve an optional, possibly-absent module at build time. Throws a
 * directed error when warden can't be found.
 */
export async function loadWardenApi(): Promise<WardenApi> {
  const base = process.env['HANDS_WARDEN_PATH'];
  try {
    if (base) {
      const wrap = await import(pathToFileURL(join(base, 'src', 'wrap.mjs')).href);
      const policy = await import(pathToFileURL(join(base, 'src', 'policy.mjs')).href);
      const audit = await import(pathToFileURL(join(base, 'src', 'audit.mjs')).href);
      return { guardToolUse: wrap.guardToolUse, loadPolicy: policy.loadPolicy, ChainedFileAudit: audit.ChainedFileAudit };
    }
    const pkg = '@askalf/warden';
    const wrap = await import(`${pkg}/wrap`);
    const idx = await import(`${pkg}`);
    const audit = await import(`${pkg}/audit`);
    return { guardToolUse: wrap.guardToolUse, loadPolicy: idx.loadPolicy, ChainedFileAudit: audit.ChainedFileAudit };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--warden needs @askalf/warden, which couldn't be loaded. Install it (npm i -g @askalf/warden) ` +
        `or set HANDS_WARDEN_PATH to a warden checkout. (${detail})`,
    );
  }
}

/** warden's standard config + audit locations (~/.warden/). */
export function wardenPaths(): { dir: string; policy: string; audit: string } {
  const dir = join(homedir(), '.warden');
  return { dir, policy: join(dir, 'config.json'), audit: join(dir, 'audit.jsonl') };
}

/** Render a verdict as the one-line status hands prints per tool call. Pure. */
export function verdictLine(tool: string, v: WardenVerdict): string {
  const mark = v.decision === 'block' ? '✗ BLOCK' : v.decision === 'approve' ? '? approve' : '✔ allow';
  const why = v.decision === 'allow' ? '' : ` — ${v.why.join('; ')}`;
  return `warden: ${tool} → ${v.tier} ${mark}${why}`;
}

interface WardenGateDeps {
  guardToolUse: WardenApi['guardToolUse'];
  policy: unknown;
  audit?: WardenAuditLog | undefined;
  /** Reused for the red-tier ("approve") operator prompt. Null = unattended (fail-closed). */
  guard?: GuardController | undefined;
  /** Status sink for the per-call verdict line. */
  out: (line: string) => void;
}

/**
 * The hands-side gate. Classifies each tool call through warden, then maps
 * the verdict to an outcome the SDK loop acts on. Black blocks, red defers
 * to the operator (or fails closed unattended), green/yellow allow. Deps
 * are injected so the decision logic is testable without a real warden.
 */
export class WardenGate {
  private readonly deps: WardenGateDeps;
  allowed = 0;
  approved = 0;
  denied = 0;
  blocked = 0;

  constructor(deps: WardenGateDeps) {
    this.deps = deps;
  }

  async gate(toolUse: { name: string; input?: Record<string, unknown> | undefined }): Promise<WardenOutcome> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const v = this.deps.guardToolUse({ name: toolUse.name, input }, this.deps.policy, { audit: this.deps.audit });
    this.deps.out(verdictLine(toolUse.name, v));

    if (v.decision === 'block') {
      this.blocked++;
      return {
        action: 'deny',
        reason: `warden BLOCKED this ${v.tier} action (${v.why.join('; ')}). Do not retry it — choose a safer approach, or stop and report that you were blocked.`,
      };
    }

    if (v.decision === 'approve') {
      if (!this.deps.guard) {
        this.denied++;
        return {
          action: 'deny',
          reason: `warden held this ${v.tier} action for approval, but no operator is attached — fail-closed (${v.why.join('; ')}).`,
        };
      }
      const preview = `${previewToolUse(toolUse.name, input)}   ⟵ warden ${v.tier}: ${v.why.join('; ')}`;
      const d = await this.deps.guard.decide({
        tool: toolUse.name,
        action: typeof input['action'] === 'string' ? input['action'] : undefined,
        input,
        preview,
      });
      if (d.kind === 'abort') return { action: 'abort' };
      if (d.kind === 'deny') {
        this.denied++;
        return { action: 'deny', reason: 'The operator denied this warden-flagged action.' };
      }
      this.approved++;
      return d.input ? { action: 'allow', input: d.input } : { action: 'allow' };
    }

    this.allowed++;
    return { action: 'allow' };
  }

  summary(): string {
    return `warden: ${this.allowed} allowed · ${this.approved} approved · ${this.denied} denied/held · ${this.blocked} blocked`;
  }
}

/**
 * Load warden, its policy (~/.warden/config.json, default policy if absent),
 * and a durable hash-chained audit (~/.warden/audit.jsonl), and build the
 * gate. `guard` supplies the red-tier prompt; pass it only when a TTY is
 * attached (otherwise red fails closed).
 */
export async function createWardenGate(
  opts: { guard?: GuardController | undefined; out: (line: string) => void },
): Promise<WardenGate> {
  const api = await loadWardenApi();
  const paths = wardenPaths();
  try {
    mkdirSync(paths.dir, { recursive: true });
  } catch {
    // Best-effort — a missing dir just means the audit append silently no-ops.
  }
  const policy = api.loadPolicy(paths.policy);
  const audit = new api.ChainedFileAudit(paths.audit);
  return new WardenGate({
    guardToolUse: api.guardToolUse,
    policy,
    audit,
    ...(opts.guard ? { guard: opts.guard } : {}),
    out: opts.out,
  });
}
