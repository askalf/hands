# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it. See CONTRIBUTING for the full release
checklist.
-->

## [Unreleased]

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
