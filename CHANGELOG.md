# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it. See CONTRIBUTING for the full release
checklist.
-->

## [Unreleased]

## [0.7.0] - 2026-06-12

hands becomes scriptable. v0.6.0 gave Claude Login mode real sessions, audit, and guardrails; v0.7.0 exposes that machinery to scripts, cron jobs, and orchestrators — `hands run` no longer has to end in an interactive prompt, and the now-dual-mode audit log is queryable. Minor-version bump for the new flags.

PRs in this release: #81 (one-shot scripting mode), #82 (audit list filters).

### Added — one-shot scripting mode: `--once`, `--json`, exit-code contract (#81)

- **`hands run --once "<task>"`** runs a single task and exits — no "What next?" loop. The session pointer is saved before returning, so `hands run -c --once "<next step>"` chains multi-step automation across invocations (and reboots).
- **`hands run --json "<task>"`** (implies `--once`) emits exactly one machine-readable JSON line on stdout: `{ ok, mode, result, turns, costUsd, tokens: {input, output}, sessionId? }`. Decorative output is silenced (the spinner included), and failures still emit one JSON line (`{ ok: false, error }`) — a parsing script never sees pretty text. The field set is stable: fields get added, never renamed. SDK mode honors `--json` too, with a `dryRun: true` marker when `--dry-run` forced it.
- **Exit codes**, pinned in tests: `0` task completed, `1` setup/config error, `2` task did not complete cleanly (max-turns cutoff or execution error, surfaced from the stream's result envelope).

### Added — audit list filters: `--mode`, `--tool`, `--failed`, `--json` (#82)

`hands audit list` can now answer "what did Claude Login bash do?" (`--mode cli --tool bash`) and "what went wrong?" (`--failed` — including guardrail blocks) and emit the result as JSON. Filtering never renumbers: printed indexes stay positions in the full log, because they're what `audit show/replay <index>` accept. CLI-mode entries carry a `[cli]` marker in listings; pre-0.6 entries count as `sdk`.

## [0.6.0] - 2026-06-11

Claude Login mode grows up. The default, $0 mode used to run blind: `--dangerously-skip-permissions` with nothing but prompt text for protection, no audit trail ("only SDK mode is covered"), stderr string-scraping for the action display, and "session memory" that was 200-char task summaries re-injected into the system prompt. All four are gone — replaced with the claude CLI's real primitives. Minor-version bump for the new `--continue` flag and audit-log `mode` field.

PRs in this release: #77 (stream-json event feed), #78 (PreToolUse guardrail hook), #79 (session continuity).

### Added — audit trail in Claude Login mode (#77)

The child now runs with `--output-format stream-json` and hands parses the real event feed instead of guessing from stderr noise:

- **Every tool call lands in `~/.hands/audit.jsonl`** — tool, action, redacted args, duration, ok/error — with `mode: 'cli'` so the two run modes are distinguishable (entries without a mode are SDK, which keeps every pre-0.6 line valid). Interrupted calls (no `tool_result` before stream end) are logged as not-ok, since the call may or may not have fired.
- **Live action lines show what's actually happening** — `→ bash: Start-Process notepad`, `→ askalf-computer: screenshot` — real tool names and arg one-liners from the stream, not `s.includes('tool_use')` heuristics.
- The stream parser (`src/cli-stream.ts`) is pure and chunk-boundary-safe; unknown event types are ignored by design so future claude stream additions can't break a run.

### Security — the bash hard-block list now *enforces* in Claude Login mode (#78)

CLI mode passes `--dangerously-skip-permissions` to the claude child, and the only protection that traveled with it was prompt text. Claude Code runs PreToolUse hooks even under that flag and respects a deny decision — so hands now injects a settings file wiring `dist/hook-pre-tool-use.js` as a PreToolUse hook on the Bash tool. The same `checkCommand` hard-block list that gates SDK-mode bash denies in CLI mode, blocked attempts are themselves audit-logged (`action: 'guardrail_block'`), and the hook fails open on any malformed input so a hook bug can never take down a host run. Warn-level patterns stay non-blocking, same as SDK mode. `hands check` reports the honest new scope.

### Added — session continuity: real `--resume` + `hands run --continue` (#79)

- Interactive-loop turns pass `--resume <session_id>` (captured from the stream), so "What next?" follow-ups share the actual conversation — full tool results and context, not a summary. The old summary injection survives only as a fallback for streams that never surface a session id.
- **`hands run --continue` (`-c`) resumes the most recent session across process exits and reboots** — closing the README's long-standing "no session resume" limitation. The pointer lives in `~/.hands/last-session.json` (0600), written after every completed task. Bare `--continue` drops straight into the "What next?" loop; `hands run -c "follow-up"` resumes with a task. The child spawns from the saved cwd (claude scopes session lookup to the starting directory), and impossible combinations (`--continue` + SDK auth / `--dry-run` / no saved session / deleted cwd / missing claude CLI) fail loudly with directed hints.

### Notes

- Claude Login audit coverage is observational (hands records what the stream reports; the child executes the tools), while the PreToolUse hook is enforcement. SDK mode remains the dispatch-site gate it always was.
- `--dry-run` still forces SDK mode — execution can't be stubbed inside the claude child.
- 35 new tests (192 total across 22 files), including subprocess tests that invoke the real hook binary the way Claude Code does.

## [0.5.0] - 2026-06-10

The product release from the 2026-06-10 review, on top of the v0.4.2/v0.4.3 hardening: the computer-use tool now delivers everything it promises the model (full `computer_20251124` action set including zoom at native resolution), the documented dario-only zero-cost setup works end to end, and the SDK agent loop is integration-tested for the first time. Minor-version bump for the new action surface and the relaxed `hands auth` key validation.

PRs in this release: #72 (full computer_20251124 action set), #73 (dario-only auth path + routing diagnostics), #74 (reliability batch, audit secret scrubbing, find_files hardening, agent-loop tests).

### Fixed — reliability batch (silent failures, hangs, crashes)

- **CLI mode silently lost its screenshot tool on install paths containing spaces.** `mcp-server.js`'s entry-point guard compared `import.meta.url` (percent-encoded, `%20`) against `process.argv[1]` (literal spaces), so under paths like `C:\Program Files\…` the spawned server exited immediately with no visible error. The guard now compares resolved filesystem paths (case-insensitive on Windows).
- **`hands` crashed on Node 20.0–20.10** — `import.meta.dirname` only exists from Node 20.11, while `engines` allows `>=20.0.0`. Replaced with the `fileURLToPath` pattern.
- **Ctrl+C inside `hands auth`/`hands init` crashed with an unhandled-rejection stack trace** — `program.parse()` left every async commander action as a floating promise. Now `parseAsync()` with a top-level catch; cancelling a prompt exits quietly with code 130.
- **`hands audit replay <i> --execute` hung after "Replay complete."** — the confirmation prompt resumed stdin and never paused it, keeping the event loop alive. stdin is paused after the read.
- **The CLI-mode spinner froze after the first action line** — `update()` never restarted a stopped interval. It does now.
- **`str_replace` edits could be silently corrupted** when the model's `new_str` contained `$&`/`$$`/`` $` `` — `String.replace` interprets those in string replacements. Switched to a replacer function.
- **Voice transcription treated partial output + a real error as success** — stderr is now checked for error markers even when stdout is non-empty.

### Security — audit log scrubs recognizable secrets

The audit log records the text the agent types and the commands it runs — when a task involved logging into something, credentials persisted in `~/.hands/audit.jsonl` in plaintext (and survived into the rotated archive and replay tooling). New `src/util/redact.ts` scrubs known token shapes (`sk-ant-…`, GitHub/Slack/AWS tokens, JWTs, `Bearer` headers) and `password=…`-style assignments before audit entries are written. Best-effort by nature — an arbitrary string typed into a password field with no context can't be recognized; documented in-module. Tested in `test/redact.test.mjs`.

### Added — agent-loop integration tests

The SDK-mode agent loop — the code that executes model output — had zero tests; coverage was inverted relative to risk. `runSdkMode` now takes documented test hooks (`testClient`, `testScreen`) so the loop runs against a scripted fake client with `--dry-run` stubbing execution. `test/sdk-loop.test.mjs` pins the request shape (model, `computer-use-2025-11-24` beta, `enable_zoom`, system prompt), the tool_use → tool_result round-trip, the budget halt, and the maxTurns cap.

### Fixed — `find_files` hardening

- Model-supplied grep regexes now run under a 5s wall-clock budget with an honest truncation marker, and single lines are capped at 10k chars before hitting the regex engine — a pathological pattern can no longer wedge the agent's turn (ReDoS).
- Removed a dead exclude check in the directory walk.

### Added — full `computer_20251124` action set (zoom, drag, triple-click, hold_key, wait, horizontal scroll, modifier clicks)

The SDK-mode tool declaration promised `computer_20251124`, but the dispatcher implemented only the 2024-10-22 action set — `triple_click`, `hold_key`, `wait`, `left_mouse_down/up`, `left_click_drag`, and `middle_click` all returned "Unknown computer action", and `scroll_direction: left/right` was silently coerced to `down`. The model was burning turns on capabilities that failed at runtime. The dispatcher now implements every documented action:

- **zoom** — view a region of the screen at full resolution (`enable_zoom: true` now set on the tool). Region captures go through native region-capture flags (`screencapture -R`, `grim -g`, `scrot -a`, `CopyFromScreen` rect) with no downscaling, so small text is actually legible.
- **left_click_drag**, **left_mouse_down/up**, **triple_click**, **middle_click** — implemented across all three platforms.
- **hold_key** (duration-clamped to 10s) and **wait** (clamped to 30s).
- **scroll** in all four directions — X11 wheel buttons 6/7, Windows `MOUSEEVENTF_HWHEEL`, ydotool wheel mode for horizontal.
- **Modifier clicks/scrolls** — the documented `text` param (`shift`/`ctrl`/`alt`/`super`) is honored on click and scroll actions (best-effort skipped on Wayland).

Also fixed in passing: the macOS scroll implementation used AppleScript verbs that don't exist in System Events (`set position of mouse`, `scroll`) and errored on every call — replaced with cursor positioning + Page Up/Down / arrow-key presses (macOS has no CLI wheel synthesis). Every mouse/keyboard/screenshot adapter call now carries a 15s timeout, so a hung `xdotool`/`cliclick`/`powershell` can no longer stall the agent's turn indefinitely. Action-set parity is pinned in `test/computer-actions.test.mjs` against the documented 2025-11-24 list.

### Fixed — the documented dario-only setup actually works now

The README documented `export ANTHROPIC_BASE_URL=http://localhost:3456` + `export ANTHROPIC_API_KEY=dario` as a zero-config SDK-mode path, but three pieces of code made it impossible: `hands auth` hard-rejected any key not starting with `sk-ant-`, `hands run` exited unless a key was stored in config, and SDK mode passed `config.apiKey` explicitly so the env var was never read. All three fixed:

- `hands auth` accepts non-Anthropic-shaped keys with an informational note (dario and other Anthropic-compatible proxies use arbitrary keys).
- `hands run` treats `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the environment as valid SDK credentials (new pure helper `hasSdkCredentials`, tested).
- SDK mode constructs the Anthropic client without an explicit key when none is stored, letting the SDK resolve env credentials itself.

### Fixed — routing diagnostics and URL hygiene

- `hands doctor` reported "SDK mode will hit api.anthropic.com directly" whenever `ANTHROPIC_BASE_URL` was unset — but `hands run` auto-detects dario on localhost:3456 and silently routes through it, so the diagnosis was wrong in exactly the case the auto-detect feature creates. Doctor now runs the same probe and reports auto-routing when dario is reachable.
- The dario auto-detect exported `ANTHROPIC_BASE_URL` untrimmed, so a trailing slash in `HANDS_DARIO_URL` leaked into the SDK's base URL. Normalized before use and export.

## [0.4.3] - 2026-06-10

Hardening + Windows-reliability release, all from the same internal repo review that produced v0.4.2. Headliners: Claude Login mode actually works on Windows npm installs now (it spawned nothing before), `read_page` refuses private/internal targets, screenshot context no longer grows unbounded, and `~/.hands/config.json` stopped being world-readable. Plus a Windows CI leg so the headline platform stays tested.

PRs in this release: #68 (screenshot trimming, per-run flag validation, config perms), #69 (Windows `claude.cmd` spawn resolver + `build-windows` CI job), #70 (`read_page` SSRF guard, guardrail gaps, replay gate).

### Security — `read_page` refuses private/internal targets (SSRF guard)

`read_page` fetched any http(s) URL the model asked for, with redirects followed silently — a prompt-injected page could steer the agent into `http://169.254.169.254/…` (cloud metadata) or intranet hosts. New `src/util/url-safety.ts` refuses hostnames/addresses in loopback, private, link-local, CGNAT, and special-use ranges (IPv4 + IPv6, including v4-mapped), checks every address DNS returns, and re-validates on every redirect hop (now followed manually, max 5). Reading internal pages on purpose is still a one-switch override: `HANDS_ALLOW_PRIVATE_URLS=1`. Known limit documented in-module: DNS rebinding between validation and fetch is not closed — that needs IP pinning, out of proportion for a read-only page fetcher.

### Security — guardrail gaps closed

- The root-delete patterns required end-or-whitespace right after the slash, so `rm -rf /` was blocked but `rm -rf /*`, `rm -rf /.`, and `rm -rf C:\*` were not. The patterns now accept a trailing glob/dot. Bypass cases pinned in `test/guardrails.test.mjs`.
- `hands audit replay <i> --execute` re-ran recorded bash commands without the `checkCommand` gate the live SDK-mode bash tool runs behind. Replay now runs the same gate.
- `hands check` printed "Guardrails: active" unconditionally — including in CLI mode, which passes `--dangerously-skip-permissions` to the `claude` CLI and never consults `checkCommand`. The line now states the real scope.

### Fixed — Claude Login mode works on Windows npm installs

`spawn('claude', ...)` fails on Windows when Claude Code is installed via npm (the path this repo's own error message recommends): the install is a `claude.cmd` shim, which `CreateProcess` won't resolve from the bare name and which Node ≥ 20.12.2 refuses to spawn without a shell (CVE-2024-27980). Detection via `where` passed and then the spawn died with a misleading "Claude CLI not found" — reproduced on a real Windows npm install (ENOENT). New resolver `src/platform/claude-cli.ts` finds what the shim wraps — the packaged native `claude.exe` (current claude-code layout) or `cli.js` run through our own node (older layout) — and keeps spawning shell-free, so prompt text is never re-parsed by cmd.exe. Applied to CLI mode, `hands auth`, and `hands doctor` (which now reports a real version instead of `v?` on Windows). Pure resolution core unit-tested in `test/claude-cli.test.mjs`.

### Added — Windows CI job

CI ran on Ubuntu only while the README calls Windows 10/11 "best-supported". New `build-windows` job (windows-latest, Node 22) runs the same typecheck / build / test / smoke sequence on every PR. Added as a separate job rather than a matrix axis so the existing `build (20)` / `build (22)` required-check names in branch protection stay stable.

### Fixed — screenshot trimming actually trims now

`trimScreenshots` only matched top-level `image` blocks, but per-turn screenshots come back nested inside `tool_result` content — so nothing was ever trimmed and every screenshot stayed in context for the whole task (up to 50 turns of ~1,500-token images). The walk now descends into `tool_result` blocks; the newest 5 screenshots are kept, older ones become `[screenshot omitted]` placeholders. New tests in `test/trim-screenshots.test.mjs`.

### Fixed — `hands run -m/-b/-t` no longer silently rewrite your saved config

The one-off flags were persisted to `~/.hands/config.json` on every run, unvalidated — `hands run -b abc "..."` wrote `NaN` (serialized as `null`), which crashed every subsequent SDK run until the file was hand-edited. The flags now apply to that run only and are validated up front (positive number for `--budget`, positive integer for `--turns`), with every problem reported in one pass. `hands config` remains the persistence path and gets the same validation. New module `src/util/cli-overrides.ts` with tests.

### Fixed — `~/.hands/config.json` is created owner-only

The config file (which holds the Anthropic API key in API-key mode) was written with default permissions. It's now created `0600` in a `0700` dir, matching what the README already claimed, what `hands doctor` already checks for, and what the audit log already did. Existing installs are repaired on the next config save.

## [0.4.2] - 2026-06-10

Security release. One fix: the SDK-mode text editor no longer shells out, closing a command-injection path. Everything else is dependency maintenance and README accuracy. **If you use SDK mode (API-key auth), upgrade.** Claude Login mode — the default — never touches the affected code path.

PRs in this release: #58 (shell-free file editor + express removal), #60 (commander 13 → 15), #55 (inquirer 13 → 14), #54 / #59 / #64 / #66 (non-major bumps: `@anthropic-ai/sdk`, hono, others), #48 (qs 6.15.2), #49 / #56 / #61 (README only).

### Security — text editor no longer shells out (command-injection path closed)

The `str_replace_based_edit_tool`'s `view` operation ran `cat "<path>"` through a shell with a model-supplied path. A path containing shell metacharacters could inject arbitrary commands — and because the guardrail engine only gates the `bash` tool, the injected command bypassed it entirely. The editor is reimplemented directly on `node:fs` with no shell anywhere in the path, and the previously-stubbed `create` / `str_replace` / `insert` operations now actually work instead of silently no-oping. Found during an internal code audit. (#58)

### Changed

- `express` removed from direct dependencies — nothing in `src` imports it; it was only ever pulled transitively by the MCP SDK. (#58)
- commander 13 → 15 and inquirer 13 → 14, plus non-major bumps across `@anthropic-ai/sdk`, hono, qs, and fast-uri. No user-facing changes in CLI parsing or interactive prompts; the full test suite passes on both. (#60, #55, #54, #59, #64, #66, #48)

## [0.4.1] - 2026-05-07

One new agent capability (`find_files`), one gap-closer from v0.4.0 (personas now work in CLI mode, not just SDK mode), and three dependency bumps. All additive — v0.4.0 users see no behavior change without opting into the new tool surface or `--persona` flag.

PRs in this release: #31 (codeql-action 3.35.2 → 4.35.3), #32 (`@anthropic-ai/sdk` 0.91.1 → 0.92.0), #33 (find_files tool), #34 (persona-CLI plumbing), #35 (ip-address + express-rate-limit transitive bumps).

### Added — `find_files` tool: list / search files in one turn

A new SDK-mode tool that replaces the agent's chained `bash ls` + `cat` + `grep` loops with a single call. List mode (`name_pattern`, basename glob like `*.ts` or `{a,b}.md`) enumerates matching files with sizes; grep mode (also pass `grep`, a regex) returns `file:line:content` matches across the matched set. Default excludes — `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `target`, `__pycache__`, `.venv`, `venv`, `coverage` — are baked in, so the agent doesn't have to remember `find -not -path` flags every time. Walker caps: `max_depth=10`, `max_results=50`, `max_bytes=50KB` on the rendered response, `1MB` per-file read cap, NUL-byte heuristic for skipping binaries.

System-prompt nudge mirrors the `read_page` framing: *"For locating files or searching code: use the find_files tool, not chained bash ls + cat + grep calls."* Anti-pattern added: *"Do NOT chain ls + cat + grep to find or search files — use find_files in one turn."*

The tool is read-only by construction (no rename, no move, no write). Heavier file operations stay on `str_replace_based_edit_tool` and `bash`.

New module: `src/tools/find-files.ts` with 11 unit-test assertions covering glob conversion (`*`, `?`, `{a,b}`, regex-escape), default excludes, list / grep mode separation, `max_results` truncation reporting, invalid-regex error, and missing-path error.

### Changed — `--persona` and `--system-prompt` now work in CLI mode

The flags shipped in v0.4.0 against SDK mode only; CLI mode (the default Claude Login path) ignored them. They now thread through to `runCliMode` and become the value of `claude --append-system-prompt`. When a persona is set, hands' OS-aware default block is dropped (Claude Code's built-in prompt already covers basic computer-use orchestration); session context — task history + lessons learned across the interactive loop — is preserved either way.

Semantic note: SDK mode replaces the entire system prompt with the persona text; CLI mode appends to Claude Code's built-in prompt because there is no full-replacement hook. The end-user effect is the same — the persona's defaults (verbosity, autonomy, tool framing) take effect — with the caveat that CLI mode keeps Claude Code's general-purpose framing as the substrate.

New pure helper: `composeCliAppendPrompt(platform, sessionContext, persona)` in `src/cli-mode.ts`, with 6 unit-test assertions covering both branches (no-persona / persona-set), session-context preservation, and OS-aware-default suppression on Windows / macOS / Linux when a persona is active.

## [0.4.0] - 2026-04-30

Four operator-facing features bundled into one release. Net: hands gains a way to read web pages without a browser (`read_page` tool), auto-routes through dario when it's running (subscription billing without the env-var dance), accepts custom system prompts via named personas, and exposes its own audit log for inspection and replay. All additive — v0.3.0 users see no behavior change without opting into the new flags or letting the new tool surface.

PRs in this release: #25 (deps bump), #26 (auto-detect dario), #27 (personas), #28 (audit list/show/replay), #29 (read_page tool).

### Added — `read_page` tool: fetch URLs without a browser

The agent's SDK-mode tool list grew from three to four. Alongside `computer`, `bash`, and `str_replace_based_edit_tool`, hands now ships a custom `read_page(url)` tool that fetches a URL via plain `fetch()`, runs an HTML cleanup pipeline (drop scripts/styles/iframes/svg/canvas/video, keep signal-bearing `<head>` metadata, resolve relative `href`/`src` to absolute URLs, prune cookie/consent banners by class+id selector, inline lazy-loaded image `data-src`, 80KB hard size cap), and returns the cleaned HTML directly to the agent. No nested LLM call — the agent is already a Claude model and reads HTML natively.

The system prompt nudges the model toward `read_page` for every URL-reading task: *"For reading web pages: ALWAYS use the read_page tool, NEVER navigate to a URL with the computer tool."* Anti-pattern explicitly added: *"Do NOT open a browser to read a URL — use read_page."*

Cost comparison (live-tested, sonnet-4-6 via dario, OAuth subscription billing):

| Task | read_page | computer-tool path (estimated) |
|------|-----------|-------------------------------|
| Summarize Wikipedia article | 2 turns, 14k in / 307 out | 6-8 turns, ~50k+ in |
| Read Anthropic docs | 2 turns, 11k in / 315 out | 6-8 turns, ~50k+ in |
| Identify SPA shell | 2 turns, 2k in / 330 out | 4-6 turns, ~20k+ in |

Each computer-tool screenshot costs ~1,500 tokens; `read_page` returns ~1-7K tokens of cleaned HTML for the same content. SPA shells (empty body, JS-rendered) are detected and surfaced as a metadata-only response with a clear marker — the agent honestly identifies them as SPA shells rather than hallucinating content.

New dep: `cheerio` (HTML parser, ~70KB unpacked, no transitive runtime). New module: `src/util/page-cleanup.ts` with 17 unit-test assertions.

### Added — auto-detect dario at startup

When `ANTHROPIC_BASE_URL` isn't already set, hands probes `localhost:3456/health` at the start of `hands run`. If dario responds within 2s, sets `ANTHROPIC_BASE_URL` so the Anthropic SDK routes through it for OAuth subscription billing. Operator override always wins: env-pre-set or `--no-dario` skip the probe; `HANDS_DARIO_URL` overrides the default target for non-default ports.

| Condition | Outcome |
|---|---|
| `ANTHROPIC_BASE_URL` already set | Respect it, no probe |
| `--no-dario` flag | Skip probe, no env var change |
| Dario reachable on `localhost:3456/health` | Set env var, log info line |
| Dario not reachable | Silent fall-through to api.anthropic.com |
| `HANDS_DARIO_URL` env set | Probe that URL instead |

2s timeout — dario's first `/health` on a cold proxy is ~840ms (account pool + template state checks); subsequent hits are much faster, but the auto-detect runs once per `hands run` so the budget covers cold-path. New module: `src/dario-detect.ts` with 7 unit-test assertions.

### Added — personas: named system-prompt overrides

Two new flags on `hands run`:

```
--persona <name>       use a named persona (bundled or ~/.hands/personas/<name>.md)
--system-prompt <path> use an arbitrary prompt file (bypasses --persona)
```

Bundled personas: `minimal` (short, no constraints), `thorough` (take initiative, exhaustive code with comments), `concise` (terse, no preamble), `security-aware` (confirm-before-destructive). User overrides at `~/.hands/personas/<name>.md` take precedence over the bundled set. Mutex: `--persona` and `--system-prompt` are mutually exclusive — both set exits 1 with a clear error before doing any other work.

Why it's safe to ship: dario research ([askalf/dario#172](https://github.com/askalf/dario/discussions/172)) confirmed the billing classifier doesn't fingerprint system prompt content — content, length, and block count are not classifier inputs. Combined with hands routing through dario for OAuth subscription billing, swapping the system prompt does NOT flip billing from `five_hour` to `overage`. Personas are the operator-facing surface for that capability.

SDK mode only — CLI mode (which spawns `claude --append-system-prompt`) doesn't plumb `--persona` through yet; the integration there is meaningfully different and gets its own future PR. New module: `src/personas.ts` with 7 unit-test assertions.

### Added — `hands audit list/show/replay`

Three subcommands under `hands audit`:

```
hands audit list [--last N]     show recent entries with replay index
hands audit show <index>        full JSON detail for one entry
hands audit replay <index>      re-execute the entry's tool call
                                (dry-run by default; --execute fires)
```

The audit log at `~/.hands/audit.jsonl` already records every SDK-mode tool call; this surface lets operators inspect what the agent did and re-run individual actions deterministically. Useful for *"the agent did something I didn't watch closely — show me what"* and for repeating a known-good action sequence on a fresh state.

Replay safety:

- Default is dry-run — `replay <index>` prints what would happen, doesn't fire the tool. Operator must pass `--execute` to actually re-run.
- Each `--execute` prompts before firing for state-changing actions: clicks, typing, key presses, scrolls, every bash command, and text_editor str_replace/create/insert. Read-only actions (computer:screenshot, computer:mouse_move, text_editor:view) fire immediately.
- text_editor replay only handles `view` — create/str_replace/insert require original input fields (`file_text`, `old_str`, `new_str`) which the audit summarizer may truncate. Refuse rather than guess.
- Replay does NOT re-run the LLM. Pure tool-call replay; no model invocation, no token spend.

New module: `src/audit-replay.ts` with 12 unit-test assertions. Test count goes 49 → 66 (+17 across this release total).

### Changed — dependency bump

`@anthropic-ai/sdk` upgraded by Dependabot (#25). No behavior change.

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
