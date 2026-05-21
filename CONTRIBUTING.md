# Contributing to hands

PRs welcome. hands is the `@askalf/hands` CLI — a cross-platform local computer-use agent that drives the OS through its native shell (PowerShell on Windows, `open` + `osascript` on macOS, `xdotool` / `ydotool` on Linux), with optional voice input via local whisper.cpp.

## Setup

```bash
git clone https://github.com/askalf/hands
cd hands
npm install
npm run build       # TypeScript compile to dist/
npm run dev         # tsc --watch for iterative work
```

Requires **Node.js 20+**. For the recommended Claude Login run-mode you also need the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`npm i -g @anthropic-ai/claude-code`). The peer dep is optional — SDK mode does not require it.

## Structure

| Area | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point, command routing (`run`, `init`, `auth`, `doctor`, etc.) |
| `src/run.ts` | Run-loop dispatch — picks Claude Login vs SDK based on auth config |
| `src/cli-mode.ts` | Claude Login mode — spawns the `claude` CLI, threads `--append-system-prompt` and `--mcp-config` |
| `src/sdk-mode.ts` | SDK / API Key mode — Anthropic SDK direct, `computer_20251124` + `bash` + `text_editor` tools, audit-log emission |
| `src/system-prompt.ts` | OS-aware system prompt (branches on `process.platform`), shell-first nudges, hard-block guardrails |
| `src/platform/*` | Per-platform keyboard / mouse / screenshot / screen-info — abstraction over PowerShell / AppleScript / xdotool / ydotool |
| `src/voice/*` | Optional voice input — local whisper.cpp transcriber, SoX / arecord capture via `execFile` (no shell strings) |
| `src/tools/find-files.ts` | SDK-mode `find_files` tool (list + grep modes, default excludes, walker caps) — replaces chained `ls + cat + grep` loops |
| `src/tools/read-page.ts` | SDK-mode `read_page` tool — fetches a URL, runs `page-cleanup` to strip nav / ads / scripts |
| `src/util/audit.ts` | Append-only `~/.hands/audit.jsonl` writer (SDK mode + `--dry-run`) |
| `src/util/guardrails.ts` | Hard-block detection for destructive shell patterns (recursive root deletion, partition tools, registry wipes, etc.) |
| `src/util/config.ts` | `~/.hands/config.json` reader/writer with `0700` perms on POSIX |
| `src/auth.ts` | `hands auth` flow — pick Claude Login vs API Key, validate key, write config |
| `src/doctor.ts` | `hands doctor` — reports installed platform tools, effective `ANTHROPIC_BASE_URL`, voice-stack status |
| `src/init.ts` | `hands init` — interactive first-run setup, optionally installs `claude` CLI and whisper.cpp |
| `src/dario-detect.ts` | Detects a local [dario](https://github.com/askalf/dario) proxy and surfaces the routing tip in API-Key mode |
| `src/personas.ts` | `--persona` plumbing (v0.4.x — CLI mode + SDK mode) |
| `src/mcp-server.ts` | Local MCP server exposing the screenshot tool to Claude Login mode |
| `src/audit-replay.ts` | `hands audit-replay` — replays a recorded audit log against a stubbed dispatcher |
| `test/*.test.mjs` | Node-native (`node --test`) unit tests — no live LLM calls required |

## Before submitting

1. `npm run build` — must compile clean under TypeScript strict.
2. `npm test` — the full `node --test test/*.test.mjs` suite must pass. These run in-process with no live LLM calls.
3. `npm audit --production --audit-level=high` — no high-severity vulnerabilities.
4. For changes that touch a `src/platform/*` module: smoke-test the affected platform manually (`hands run "open notepad"` on Windows, `hands run "open Finder"` on macOS, equivalent on Linux). The platform abstractions are the riskiest surface — cross-platform LLM behavior is empirical (see Limitations in the README).
5. For changes that touch `src/system-prompt.ts` or `src/util/guardrails.ts`: re-read what the prompt is now telling the agent end-to-end and update the corresponding `test/system-prompt.test.mjs` / `test/guardrails.test.mjs` assertion set. The system prompt is load-bearing — most agent behavior is governed by it.
6. For changes to SDK-mode tool surface (`src/tools/*`, `src/sdk-mode.ts`): bump the tool-name string carefully — the audit log indexes on it, and `hands audit-replay` reads historical logs.

## Security issues

Do **not** open a public issue. Email **security@askalf.org** instead. See [SECURITY.md](SECURITY.md).

## Review policy

Every PR goes through at least one review round. The bar for merge is:

- **Functional.** Tests pass locally and on CI (the full `npm test` suite, not just the change's new tests). CodeQL must remain green — `js/clear-text-logging` is a recurring class for this codebase since the agent emits a lot of contextual logs.
- **Necessary.** The change solves a stated problem (linked issue, user report, or review-feedback entry). "While I was in there" changes get split into a separate PR.
- **Cross-platform aware.** Anything in `src/platform/*` ships with the assumption that the other two platforms still work. If a change is platform-specific, say so in the PR title (`[win]`, `[mac]`, `[linux]`).
- **Test coverage for behavior changes.** New flags, new tools, new exit conditions all get at least one assertion in `test/`. Pure refactors are exempt.
- **Audit-log compatibility.** The `~/.hands/audit.jsonl` format is read by `hands audit-replay` and by external auditors. Field renames / removals require a versioned migration.

PRs that don't meet the bar get comments explaining why, not a silent block. If the bar seems arbitrary in a specific case, argue it in the PR — every bar item has been negotiated before.

## Release cadence

hands is **pre-1.0** — breaking changes are possible on any minor and called out explicitly in [CHANGELOG.md](CHANGELOG.md).

- **Patch** (`0.4.x`) — bug fixes, prompt tuning, dependency bumps, drift patches.
- **Minor** (`0.5.0`) — new tools, new flags, new platform behaviors. Ships when accumulated new surface justifies it.
- **Major** (`1.0.0`) — first stable release. After 1.0, breaking changes follow a deprecation cycle.

New tool surface defaults to **opt-in** for at least one minor before being threaded into the default agent loop. Audit-log schema changes ship with a version bump in the JSONL header.

## Pre-1.0 stability notes

- The system prompt is treated as a **load-bearing config file**, not as code. Changes to it are reviewed as carefully as changes to the run loop, and shipped under their own CHANGELOG entry whenever they could change observable agent behavior.
- The `~/.hands/audit.jsonl` schema is intended to be stable across patch releases. If a change requires a new field, prefer additive (new key, default-null) over rename.
- Run-mode default (`Claude Login`) is also load-bearing — `hands run` should never silently switch to SDK / per-token billing without an explicit user choice or an explicit `--dry-run`.
