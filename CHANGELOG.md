# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it. See CONTRIBUTING for the full release
checklist.
-->

## [Unreleased]

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
