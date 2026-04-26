# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it. See CONTRIBUTING for the full release
checklist.
-->

## [Unreleased]

## [0.3.0] - 2026-04-25

Cross-platform system prompts (no longer Windows-only despite the platform abstraction), CodeQL clear-text-logging fix, and a production-ready README rewrite. Both functional changes are additive — v0.2.0 Windows users see no behavior change. macOS / Linux operation is now intended-to-work but **empirically un-smoked** — the system-prompt branching is unit-tested but the LLM behavior under it is not yet verified against real model use on a non-Windows host. First post-publish report from a Mac or Linux user is the signal that locks in the "cross-platform" claim.

### Documentation — production-ready README rewrite

The pre-v0.3 README was install + commands + a thin "Safety Guardrails" paragraph. v0.3.0 ships a structural rewrite covering the gaps a production-ready high-trust local computer-use tool needs: a "what you keep" sovereignty lead, an explicit cost-comparison table (Claude Login = $0, SDK + dario = $0, SDK direct = $X per task, hosted competitor = $20–50/mo flat), a full threat model with operating recommendations (review `--dry-run` before trusting a new task class, keep destructive ops scope-targeted, audit-log review cadence), an honest "Limitations & known issues" block (Wayland xdotool blind spot, macOS Accessibility first-run prompt, Claude-Login-no-audit-trail, cross-platform empirical state, SDK-mode-Anthropic-only), a troubleshooting / FAQ block, and a trust-and-transparency table mirroring claude-bridge's pattern (runtime deps count, network scope, telemetry status, branch protection, release attestation). Old content preserved where it was working — quickstart, commands reference, configuration, the Full Platform pitch, the Links + License footer.

### Changed — system prompts are now OS-aware (no longer Windows-only despite the platform abstraction)

Pre-fix, both run modes hardcoded a Windows-only system prompt even though `src/platform/` had cliclick / xdotool / ydotool / scrot wired up for SDK-mode mouse / keyboard / screenshot. The LLM guidance was the missing piece — Claude was being told to run PowerShell on macOS / Linux where it doesn't exist:

- `src/cli-mode.ts:201` opened with *"You are a computer control agent with FULL access to this Windows machine"* and had ~115 lines of PowerShell-only examples (Windows 11 Store redirect workarounds, `Start-Process 'C:\\Windows\\System32\\notepad.exe'`, etc.).
- `src/sdk-mode.ts:29` opened with *"Use the bash tool with PowerShell commands instead of screenshot-click loops"* with similar Windows-only patterns.

Both prompts now branch on `process.platform` and ship matching guidance:

- **Windows (`win32`)** — PowerShell, `Start-Process`, `Get-ChildItem`, `Set-Clipboard`, `winget`, plus the Windows 11 Store redirect anti-pattern that was already documented.
- **macOS (`darwin`)** — `open -a "AppName"` for app launch, `osascript -e 'tell application "System Events" to keystroke "..."'` for keyboard automation, `pbcopy` / `pbpaste` for clipboard, `brew` for installs. Notes the Accessibility-permission prompt on first `osascript` run.
- **Linux (`linux`)** — `xdg-open` for files / URLs, `xdotool type` (X11) or `ydotool type` (Wayland) for keyboard automation, `xclip` (X11) or `wl-copy` (Wayland) for clipboard, with display-server detection (`[ -n "$WAYLAND_DISPLAY" ]`) baked in. Calls out that xdotool can't reach Wayland clients (input synthesis is blocked at the protocol level).

**Implementation:** new pure module `src/system-prompt.ts` with `buildCliSystemPrompt(platform, sessionContext)` and `buildSdkSystemPrompt(platform)` builders, plus `normalizePlatform()` (falls back to `linux` for non-Win/non-Mac Unix variants — every BSD has bash + the standard utilities, so the Linux block is the safest default). `cli-mode.ts` and `sdk-mode.ts` are now ~120 lines lighter each — they call the builders instead of inlining the prompts. 13 new assertions in `test/system-prompt.test.mjs` cover the OS branching, the shared frame across platforms, the empty-sessionContext edge, and a regression pin against the original *"FULL access to this Windows machine"* on non-Win prompts. `npm test` total goes 36 → 49 (all green).

**Marketing follow-through:** the `package.json` description swapped *"PowerShell-first"* for *"Cross-platform"* with a per-OS shell summary; keywords lost `powershell` and gained `windows` / `macos` / `linux` / `cross-platform`. The README's lead paragraph, "Shell-first" section (renamed from "PowerShell-first"), and architecture diagram all reflect the per-OS shell — the install table was already accurate (Windows / macOS / Linux X11 / Linux Wayland), it just had to stop being undermined by the lead copy. Historical v0.1.0 CHANGELOG entries left as-is — they describe what shipped at that time.

### Security — close CodeQL `js/clear-text-logging` alert (high)

First CodeQL alert against the public repo. The flagged sink is `output.success()` in `src/util/output.ts:8`, with two upstream paths:

1. **`src/auth.ts:90-91`** — `hands auth` status line emitted `sk-ant-...XXXX` (first 7 + last 4 chars of the stored API key). The first 7 chars are the well-known fixed `sk-ant-` prefix (zero entropy disclosure), but the last 4 are real key material — minimal but non-zero info disclosure. **Replaced with `***` only**, matching dario v3.7.2+'s "no substring of any stored key in user-facing output" rule.
2. **`src/init.ts:93`** — final summary line interpolated a literal `' (key stored)'` based on a truthy check of `config.apiKey`. The value itself was never emitted (template's true-branch is a fixed string), but CodeQL's flow conservatively flags any read on the path to a logger. **Routed through a `Boolean(...)` intermediate** so the dataflow stops there. Behavior unchanged.

No behavior change for users — the `hands auth` status line just shows `Mode: API Key (***)` instead of the partial-key string. Existing tests still pass (no test referenced the masked format).

## [0.2.0] - 2026-04-25

Three new commands shipped between v0.1.0 and v0.2.0 — `hands init` (interactive first-run setup), `audit log + --dry-run` (trust-story for the SDK-mode tool dispatch path), and `hands doctor` (aggregated health report). All three are additive; no behavior change for existing v0.1.0 users.

### Added — `hands init` (interactive first-run wizard)

One command to walk a new user through every choice hands asks them to make before their first `hands run`. Environment snapshot at the top (Claude CLI install state, whisper install state, `ANTHROPIC_BASE_URL` routing hint) so it's obvious what will be skipped, then delegates step-by-step to the existing flows — no duplicated logic.

- If `claude` CLI is missing, offers the one-liner install (`npm i -g @anthropic-ai/claude-code`) and bails cleanly so the user can re-run after install. Continuing without it warns that only API Key mode will be available.
- Calls the existing `authInteractive()` for Claude Login vs API Key selection (same flow `hands auth` uses).
- Offers whisper.cpp setup if not already installed. Non-destructive skip if it's there.
- If auth mode lands on API Key and `ANTHROPIC_BASE_URL` isn't set, surfaces a dario routing tip. Instructions only — we don't write env vars for the user (shells are too varied).
- Final summary prints auth / model / budget / turns / voice state plus a try-it one-liner.

Safe to re-run — every step asks before changing anything, and defaults reflect current config. ASCII status markers (`[ok]`/`[miss]`) instead of Unicode to avoid codepage fights in Windows terminals.

One new smoke-test assertion (init exports `initInteractive`). 36 total (up from 35).

### Added — audit log + `--dry-run`

Trust-story enhancements for a tool that takes shell, keyboard, mouse, and screenshot access on the user's behalf. Both are SDK-mode features — Claude Login mode spawns the `claude` child process and dispatches tools internally, so hands can't intercept actions there.

**Audit log** — every tool invocation in SDK mode appends one JSONL line to `~/.hands/audit.jsonl`: timestamp, tool name, action, summarized args (image bytes stripped, long strings truncated to 200 chars), wall-clock duration, and outcome (ok/error/dry-run). Non-fatal on failure — if the log-write errors out (disk full, permission flipped), hands logs to stderr and keeps going; the audit log is diagnostic, not authoritative. The live file rotates to `audit.jsonl.old` when it exceeds 10 MB; two files total, bounded disk cost.

**`hands run --dry-run`** — the agent plans and emits tool calls, but every execution is stubbed out. Shell commands don't run, keys don't press, mouse doesn't move, screenshots return a text placeholder. The agent sees "success" for each stubbed action so the loop continues to completion. Audit-logged with `dryRun: true` so a review shows both what the agent wanted to do and the fact that it didn't. Not supported in Claude Login mode (forces SDK fallback for the invocation, with a clear warning).

**New exports for library callers:** `appendAudit`, `rotateIfNeeded`, `readAuditHistory`, `summarizeForAudit`, `getAuditPaths` from `util/audit.js`, plus `summarizeToolArgs` from `sdk-mode.js`. 7 new test assertions covering: append+read round-trip, dir-creation on first append, summarization correctness (image bytes dropped, string truncation), rotation behaviour (rotates over cap, returns absent when no file exists, fresh appends after rotation don't read the archive), and malformed-line tolerance in history reads. 35 tests total (up from 28).

### Added — `hands doctor`

Aggregated health report mirroring the pattern from dario / deepdive / claude-bridge. One command probes every subsystem hands depends on and produces a paste-able table:

- **env** — hands version, Node version (fail below 20), platform + arch + OS release.
- **config** — `~/.hands/` dir state + perms (warn if not 0700 on non-Windows), auth mode, model, budget, and a fail if `api_key` mode is set but no key stored.
- **platform** — display server, and availability of screenshot / mouse / keyboard tool for the detected platform (PowerShell on Windows, cliclick on macOS, xdotool+scrot on X11 Linux, ydotool+grim on Wayland). Surfaces the platform-specific install hint if anything's missing.
- **claude-cli** — `claude` on PATH + version (warn if absent, since Claude Login mode needs it).
- **voice** — whisper.cpp install state for `--voice` mode.
- **dario** — if `ANTHROPIC_BASE_URL` is set, probe `/health` with a 3s timeout and surface the verdict. Skipped (info-only) when the env var isn't set.

Flags: `--json` for structured output (scrapeable in CI, usable by claude-bridge's `/status`), `--skip-dario` / `--skip-whisper` for environments where those checks aren't meaningful. Exit code 1 on any fail, 0 otherwise.

Pure helpers (`nodeMeetsMinimum`, `scrubPath`, `trimTrailingSlash`, `classifyFsError`, `classifyFetchError`, `renderDoctorText`, `renderDoctorJson`, `exitCodeFor`) all exported for library use. 10 new test assertions in `test/doctor.test.mjs` covering version matching, path scrubbing, URL trimming, error classification, text/JSON rendering, and exit-code logic. 28 total (up from 18).

`hands check` remains for backwards compat — it's a narrower subset of what `doctor` covers.

### Release — publish-ready for npm + public-flip

Closes the prep pass for flipping hands public and shipping `@askalf/hands@0.1.0`:

- **`package.json`** — removed `"private": true`. Added `files` allowlist (`dist`, `README.md`, `LICENSE`, `CHANGELOG.md`) so the tarball ships only what users need — 55 kB, 76 files, verified via `npm publish --dry-run`. Added `prepublishOnly` script running `npm run build && npm test` so a local `npm publish` can't ship a stale dist or a failing build.
- **`.github/workflows/codeql.yml`** — restored from pre-deletion state (commit `17df9f3^`). Content is byte-identical to the sibling repos' canonical version. Will start running once the repo flips public (CodeQL is free on public repos; was unavailable on the private account without GHAS, which is why it was removed).

After merge, the public-flip sequence (all one-liners, can be done in any order):

```bash
# Flip public
gh repo edit askalf/hands --visibility public

# Enable secret scanning + push protection (free on public)
echo '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}' | \
  gh api --method PATCH repos/askalf/hands --input -

# Enable Dependabot security updates (free on public)
gh api --method PUT repos/askalf/hands/vulnerability-alerts
gh api --method PUT repos/askalf/hands/automated-security-fixes

# Add NPM_TOKEN (same one used for dario / deepdive / claude-bridge)
gh secret set NPM_TOKEN --repo askalf/hands < <(printf '%s' "$NPM_TOKEN")

# Optional: branch protection with required checks (after CodeQL has run once)
# (same pattern as deepdive — see its settings)

# Cut v0.1.0 — auto-release.yml will fire and npm publish end-to-end
gh release create v0.1.0 --repo askalf/hands --title "v0.1.0" --generate-notes
```

### Tests — smoke + guardrails coverage

First real test coverage. Was previously zero tests. Two files, 18 passing assertions, runs in ~330ms via `node --test`:

- **`test/smoke.test.mjs`** — import-level smoke for every module actually referenced from elsewhere in the codebase (`util/config`, `util/guardrails`, `platform/*`, keyboard, mouse, screenshot, screen-info). Catches "someone deleted an exported function" regressions without needing runtime mocks.
- **`test/guardrails.test.mjs`** — behavioural tests for `checkCommand`'s hard-block + warn logic. Pins the safety policy: `rm -rf /`, `format C:`, `reg delete ... /f`, `netsh advfirewall set ... off`, `bcdedit /delete`, `net user ... /add` all return `{blocked: true}`; benign commands pass through; `Remove-Item ./node_modules -Recurse` warns but allows (policy choice — scoped recursion is sometimes legitimate). If a future refactor drops one of these patterns, the test fails loudly before the change can land.

CI step added (`npm test` runs after `npm run typecheck` + `npm run build`).

### Docs — document dario routing for SDK mode

`@anthropic-ai/sdk@0.91` (bumped from 0.74 via Dependabot) defaults `baseURL` and `apiKey` to the standard `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` env vars. Which means if a user has dario running and the standard env vars set, hands's SDK mode automatically routes through dario — and bills against their Claude Max subscription instead of per-token API overage. Added a "Routing through dario" section under Authentication documenting this.

### CI — disable CodeQL workflow while repo is private

GitHub code scanning (CodeQL) is not available on personal-account private repos without GitHub Advanced Security (paid, per-seat). The `codeql.yml` workflow was part of the CI foundation parity bundle; when run, every PR's `analyze` job fails with: *"Code scanning is not enabled for this repository. Please enable code scanning in the repository settings."* That made every Dependabot PR's check surface look red without any dep actually being a problem.

Removing the workflow file until the repo flips public. When it does, restore from git history (pre-this-commit copy is bit-identical to the dario / deepdive / claude-bridge versions — canonical template). Branch protection doesn't depend on `analyze` on hands yet, so removal doesn't un-gate anything.

### CI — foundation parity with dario / claude-bridge / deepdive

Standard CI / security / release scaffolding, ported pattern-for-pattern from the sibling repos:

- **`ci.yml`** — `typecheck` + `build` + `--help` smoke on Node 20 / 22.
- **`codeql.yml`** — `javascript-typescript` analysis on every PR + push + weekly Monday 06:00 UTC scheduled scan.
- **`actionlint.yml`** — `actionlint` v1.7.1 on every PR + push (no path filter — prevents the required-check-never-reports trap that bit the sibling repos).
- **`dependabot.yml`** — weekly Monday 09:00 UTC npm + github-actions version updates, non-major grouped.
- **`stale.yml`** — `actions/stale@v10.2.0` daily at 04:30 UTC. Conservative 60-to-warn / 14-to-close. Exempts `security` / `auth` / `review-feedback` / `help-wanted` / `good-first-issue` / `pinned` for issues; plus `wip` / `blocked` / `security` for PRs.
- **`auto-release.yml`** — fires on merged PR, detects `package.json.version` bump, creates tag + GitHub release from CHANGELOG section, then runs `npm publish --access public --provenance` **inline** (not via `publish.yml` release:published trigger — GITHUB_TOKEN-created releases don't fire downstream workflows, cost deepdive a manual recreate on v0.3.0, baked the lesson in preemptively here).

No runtime-behavior change. All scaffolding for the v0.1.0 release when the modernization pass is ready (dario routing, SDK bump, test coverage).

## [0.1.0] — unreleased

Seeded from [`@askalf/agent`](https://github.com/askalf/agent) commit `bef177d` — the last pre-fleet-bridge state of that repo, which was an open-source computer-use agent with PowerShell-first control, optional voice input, safety guardrails, session memory, and self-correction.

What's in the seed (all carried forward from v0.3.7 of the originating tree):

- **CLI** (`hands run "..."`, `hands auth`, `hands voice-setup`, `hands check`, `hands config`) with interactive session loop.
- **Two execution modes** — Claude Login (spawns the CC child process, zero per-token cost) and SDK mode (direct Anthropic API with `computer_20251124` tool + budget cap).
- **PowerShell-first architecture** — most tasks complete through `bash`-emitted PowerShell, with screenshot MCP tool reserved for visual verification.
- **Voice control** — local `whisper.cpp`, no cloud APIs.
- **Platform abstractions** — Windows PowerShell, macOS `cliclick`, Linux X11 `xdotool`/`scrot`, Linux Wayland `ydotool`/`grim`.
- **Safety guardrails** — hard blocks on recursive-root-delete, disk format, registry destruction, boot-config changes, firewall disabling, ransomware patterns.
- **Session memory + self-correction** — the agent remembers what worked and what failed within a session.

Rebrand-only changes from the seed:
- Package name `@askalf/agent` → `@askalf/hands`, version `0.3.7` → `0.1.0` (fresh repo starts fresh).
- CLI bin `askalf-agent` → `hands`, every user-facing command-suggestion string swapped.
- Config dir `~/.askalf/` → `~/.hands/` in `src/util/config.ts` + `src/voice/setup.ts`.
- README rewritten for the new identity.

Modernization items deferred to subsequent releases (tracked in-repo issues once public):
- Bump `@anthropic-ai/sdk` past 0.74.0 and re-verify current computer-use beta header/tool spec.
- Default-route through [dario](https://github.com/askalf/dario) so users with Claude Max / Pool configs get the same routing story as deepdive and claude-bridge.
- Behavioural tests (v0.3.7 shipped zero).
- Flip repo visibility to public once the first of the above items lands.
