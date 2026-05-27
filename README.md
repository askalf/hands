<p align="center">
  <h1 align="center">hands</h1>
  <p align="center"><strong>Your LLM on your mouse, keyboard, and screen.</strong><br>A local computer-use agent that drives the OS through its native shell — PowerShell on Windows, <code>open</code> + AppleScript on macOS, <code>xdotool</code> / <code>ydotool</code> on Linux. Voice optional. Routes through <a href="https://github.com/askalf/dario">dario</a> or any Anthropic-compat endpoint, so the per-task token spend bills against the Claude Max subscription you already pay for instead of a hosted research-tool tier on top.</p>
</p>

<p align="center"><em>Pre-1.0. MIT. Independent, unofficial, third-party — see <a href="DISCLAIMER.md">DISCLAIMER</a>.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/hands"><img src="https://img.shields.io/npm/v/@askalf/hands?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/hands/actions/workflows/ci.yml"><img src="https://github.com/askalf/hands/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/hands/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/hands" alt="License"></a>
</p>

---

## What you keep

Hosted computer-use products take four decisions away from you:

**Your data.** Every prompt, every screenshot, every keystroke the agent emits — all of it goes to the vendor's servers. With hands, none of that exists. The model runs on whatever endpoint *you* point at; the screen and the keyboard belong to your machine. The only outbound connections are to your chosen LLM endpoint. No telemetry, no analytics. Inspectable: `lsof -i` during a run.

**Your model.** Hosted products pick for you. hands routes through whatever endpoint you configure — Anthropic direct, Claude Max via [dario](https://github.com/askalf/dario), or any Anthropic-compat URL.

**Your shell.** Hosted products simulate clicks and keystrokes via screenshot loops because they don't have your shell. hands has your shell. The agent prefers a one-line `Start-Process` / `open -a` / `xdotool` over a four-screenshot click loop, which is dramatically faster and cheaper.

**Your audit trail.** SDK mode appends every tool call to `~/.hands/audit.jsonl` — timestamps, args, durations, outcomes. `--dry-run` shows what an agent *would* do without doing it. Both work locally; nothing leaves your machine.

## What you stop paying for

Most people reading this already pay Anthropic for Claude Max ($100–200/mo). A computer-use task — "open the spreadsheet, add a row, save it" — runs through 10–60 LLM calls in the agent loop. Through Anthropic's per-token API, that's pennies per task; through a hosted UI on top, that's another subscription tier.

| How you run it | Per-task cost | Data stays local? |
|---|---|---|
| Claude Login mode (Claude Max subscription via `claude` CLI) | **$0** | ✅ |
| SDK mode + dario (Claude Max via local proxy) | **$0** | ✅ |
| SDK mode + direct Anthropic API | **~$0.05–$2 per task** depending on screenshots | ✅ |
| Hosted "AI does your computer for you" tier | $20–50/mo flat | ❌ |

`hands run` defaults to **Claude Login mode** — the zero-cost path. SDK mode is only invoked when you explicitly choose API Key during `hands auth`, or when `--dry-run` forces it (Claude Login dispatches tools inside the `claude` child process, where hands can't intercept and audit-log them).

---

## 60 seconds

```bash
# 1. Install
npm i -g @askalf/hands
hands init                                  # interactive: auth, voice, dario routing

# 2. Run
hands run "open notepad and type hello world"
hands run "open VS Code in ~/projects/api and run npm test"
hands run "open chrome and go to amazon.com" --voice
```

`hands init` walks every choice the CLI asks of a new user: install `claude` CLI if missing, pick auth mode, optionally download whisper.cpp for voice, surface dario routing tip in API-Key mode. Safe to re-run.

Requires **Node.js 20+** and (for the recommended Claude Login mode) the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code).

---

## What a day looks like

```
$ hands run "open chrome and go to amazon.com"

✔ AskAlf Agent — Computer Control
ℹ Using Claude subscription (no per-token costs)
ℹ Type "exit" or Ctrl+C to quit

ℹ → open chrome and go to amazon.com

✔ Chrome is open with Amazon loaded.
ℹ (6 turns)

❯ What next? open notepad and type hello world

✔ Notepad now has "Hello World" in it.
ℹ (14 turns)

❯ What next?
🎙 Listening... (press Enter to stop)
Heard: "minimize everything and open spotify"

✔ Desktop minimized and Spotify is now open.
ℹ (4 turns)

❯ What next? exit
ℹ Session ended.
```

The agent prefers the OS-native shell over screenshot-click loops:

- **Windows** — PowerShell (`Start-Process`, `Get-ChildItem`, `Set-Clipboard`, `winget`).
- **macOS** — `open -a` for app launch, `osascript` for keystrokes / window control, `pbcopy` / `pbpaste` for clipboard, `brew` for installs.
- **Linux** — `xdg-open` for files / URLs, `xdotool` (X11) or `ydotool` (Wayland) for keystrokes, `xclip` / `wl-copy` for clipboard, distro-appropriate package manager. Display server is detected at start of each run.

A screenshot MCP tool is available when Claude needs to visually verify what's on screen, but most tasks complete entirely through the shell. `hands doctor` reports which platform tools are installed.

**Voice control** — Add `--voice` to speak commands instead of typing. Uses local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for transcription — free, private, offline. No cloud APIs.

---

## 10 example tasks

Concrete things people have actually run, grouped by what the agent leans on most. Every one is a single `hands run "..."` invocation.

**Shell-heavy (PowerShell / bash / zsh)**

1. `hands run "rename all PNG files in C:\Users\me\Screenshots by their dimensions, like 1920x1080.png"` — bulk rename on Windows via `Get-ChildItem` + `System.Drawing`. No screenshot loop.

2. `hands run "in ~/projects/api, pull main, install deps, run the tests, and tell me which ones failed"` — multi-step dev workflow; agent stays in the terminal end-to-end.

3. `hands run "tail the last 200 lines of /var/log/syslog, find anything mentioning oom or killed, and summarize"` — log triage on Linux; one `tail` + `grep` chain, then the model summarizes inline.

4. `hands run "list every brew package that has an update available, then run brew upgrade only for the ones that aren't pinned"` — macOS package maintenance; respects `brew pin` without being reminded.

**OS automation (osascript / xdotool / ydotool)**

5. `hands run "tile firefox left, terminal right, both full-height"` — window management on Linux; agent picks `wmctrl` on X11 or the Wayland equivalent.

6. `hands run "screenshot the active window and save it to my desktop with today's date in the filename"` — Win/macOS/Linux each have a one-line shell command; agent picks the right one per `process.platform`.

7. `hands run "open my next calendar event in zoom, open the attached doc in Preview, and mute notifications for an hour"` — macOS chain using `osascript` + `open -a` + Focus toggle.

**Browser / mixed (shell + screenshot when needed)**

8. `hands run "for every PDF in Downloads from this week, save the first page as a JPEG into Downloads/thumbnails/"` — `find` + `pdftoppm` on Unix or `magick` on Windows; no GUI loop.

9. `hands run "read what's on my clipboard, translate it to French via deepl.com, and put the translation back on the clipboard"` — clipboard-in, clipboard-out; needs a screenshot or two for the browser step, then `pbcopy` / `Set-Clipboard` / `xclip` to finish.

**Voice (`--voice`)**

10. `hands run "open three news sites and summarize the top story on each into a single bulleted list in a new TextEdit document" --voice` — speak the prompt instead of typing; whisper.cpp transcribes locally, no audio leaves the machine.

Run any of these with `--dry-run` first to see the model's plan and the tool calls it intends to fire, before letting it touch your machine.

## How it works

Two run modes, one consistent UX:

```
hands run "open chrome" --voice
        │
        ├── Input ─────────────────────────────
        │       │
        │       ├── --voice OFF: readline (keyboard)
        │       └── --voice ON:  mic → whisper.cpp → text
        │
        ├── Claude Login (default, $0/task on Claude Max)
        │       │
        │       ├── Spawns claude CLI
        │       ├── --append-system-prompt (OS-aware computer control agent)
        │       ├── --mcp-config (screenshot tool)
        │       ├── Claude uses built-in bash → OS-native shell
        │       │       (PowerShell / open+osascript / xdotool|ydotool)
        │       └── Interactive loop: task → "What next?" → repeat
        │
        └── SDK / API Key (per-token unless routed through dario)
                │
                ├── Anthropic SDK direct (or dario-proxied via ANTHROPIC_BASE_URL)
                ├── computer_20251124 + bash + text_editor tools
                ├── Single-run with cost summary
                └── Every tool call appended to ~/.hands/audit.jsonl
```

The system prompt branches on `process.platform` and ships matching examples for the detected OS. Both modes run the model on the host — hands does not relay, proxy, or upload your screen anywhere except the LLM endpoint you configured.

---

## Authentication

### Claude Login (recommended, default)

Uses your existing Claude Max subscription. **Zero per-token cost.**

```bash
npm i -g @anthropic-ai/claude-code
claude auth login
hands auth
# Select "Claude Login"
```

Claude Login mode spawns the `claude` CLI as a child process. It dispatches tool calls itself, which means individual tool invocations are not visible to hands and not written to the audit log. If you need a full local audit trail, use SDK mode (or run with `--dry-run`, which forces SDK).

### API Key (fallback)

Paste an Anthropic API key. Pay per token (or zero if routed through dario — see below).

```bash
hands auth
# Select "API Key" → paste your sk-ant-... key
```

> Heads-up: SDK mode uses the computer-use beta which charges per token including screenshots. A single "open notepad" task can run several dollars at direct API rates. Prefer Claude Login or SDK + dario.

### Routing through dario (zero per-token cost in SDK mode)

If you're running [dario](https://github.com/askalf/dario) locally, hands' SDK-mode calls auto-route through it — including the computer-use beta — so they bill against your Claude Max subscription instead of per-token API overage. The Anthropic SDK reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from env by default, so there's no hands-side config:

```bash
# in whatever shell starts hands:
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario            # or your DARIO_API_KEY if set

dario proxy                                # keep this running
hands run "open notepad"
```

Verify routing with `hands doctor` (reports the effective base URL) or by watching `dario proxy --verbose` while hands runs. Claude Login mode spawns the `claude` CLI directly — env-routing only matters for SDK mode.

---

## ⚠️ Security

hands is a high-trust tool: **the agent has shell, keyboard, mouse, and screenshot access on your machine**, gated only by your auth choice and the operating recommendations below. Treat it accordingly.

### Threat model

- **Prompt injection.** A web page, an email, a PDF the agent reads can carry instructions Claude wasn't supposed to follow. The agent's bias toward shell over screenshot-click loops *narrows* this surface — typed text from a webpage rarely flows back into a `Start-Process` call — but does not eliminate it. Mitigations: review `--dry-run` before trusting a new task class; keep destructive operations to specific files / folders rather than recursive parents; use `hands run "..."` for one task at a time rather than open-ended sessions on untrusted material.
- **Lost machine / shoulder-surfed terminal.** API keys live in `~/.hands/config.json` (auto-set to `0700` perms on POSIX). A user who can read that file can issue API calls on your account. `hands auth --status` shows `Mode: API Key (***)` — no key material is emitted in user-facing output (CodeQL `js/clear-text-logging` closed in v0.3.0).
- **Unaudited Claude Login mode.** The `claude` CLI dispatches tools inside its own process; hands cannot intercept those calls to audit-log them. If you need a full local trail (every shell command, mouse event, screenshot), use SDK mode or `--dry-run`.
- **Computer-use beta cost.** SDK-mode without dario charges per token *including screenshots* — every screenshot the model takes adds vision tokens. A few-dollar task is plausible at direct API rates. The shell-first system prompt suppresses unnecessary screenshots, but a task that genuinely needs visual verification will spend.
- **Voice transcription.** whisper.cpp runs entirely local — no audio leaves the machine. Recordings are written to a temp file during transcription and unlinked immediately after. SoX / arecord are invoked via `execFile` with argv arrays (not shell strings) so input filenames can't be injected.

### Operating recommendations

- **Review `--dry-run` for anything you don't trust by reflex.** SDK-mode `--dry-run` runs the full agent loop with every tool call audit-logged but stubbed — no shell fires, no keys press, no mouse moves. Read `~/.hands/audit.jsonl` after; reopen for real if it looks right.
- **Keep destructive operations targeted.** `hands run "delete files in ~/Downloads"` is a safer prompt than `hands run "clean up my computer"`. The narrower the scope of the prompt, the narrower the agent's reach for failure modes.
- **Use SDK mode or `--dry-run` when you need an audit trail.** Claude Login mode is the cheapest path but also the least observable. For sysadmin / high-impact runs, the audit log is worth the per-token cost.
- **Don't run hands as root / Administrator.** The agent's shell access is exactly your shell access. Running as root makes `rm -rf /` a one-prompt foot-gun the guardrails won't necessarily catch.
- **Rotate API keys after suspected exposure.** If your dev machine is compromised or borrowed, treat the API key in `~/.hands/config.json` as exposed. Revoke at [console.anthropic.com](https://console.anthropic.com), then `hands auth` to install the new one.
- **Review the audit log periodically.** `tail -100 ~/.hands/audit.jsonl` after a session that touched anything important.

### Reporting

Found a security issue? Email **security@askalf.org** — don't open a public issue. See [SECURITY.md](SECURITY.md).

### Built-in guardrails

The system prompt also includes hard-block guidance for clearly destructive patterns the agent will refuse to execute:

- Recursive root deletion (`rm -rf /`, `Remove-Item -Recurse C:\`, etc.)
- Disk formatting / partition modification
- Registry destruction (Windows) / `defaults delete` chains (macOS) / `/etc` overwrites (Linux)
- Boot config changes
- Firewall disabling
- User account creation
- Ransomware-pattern encryption sweeps

These are **system-prompt guardrails, not sandboxing.** They reduce the chance the model emits a destructive command on its own initiative; they do not prevent a user from explicitly instructing one. The strongest guardrail is your prompt.

---

## Limitations & known issues

Pre-1.0. Honest about what doesn't work yet:

- **Cross-platform LLM behavior is empirical.** v0.3.0 ships OS-aware system prompts (PowerShell / `open` + `osascript` / `xdotool` / `ydotool`) but the actual model behavior under the macOS and Linux blocks is not yet smoke-tested against real Claude calls. Expect the first non-Windows run to surface rough edges in the example commands. Report what didn't work and we'll tune the prompts. Windows is well-exercised.
- **Wayland input synthesis is restricted by the protocol.** `xdotool` cannot type into Wayland clients — Wayland blocks input synthesis from arbitrary clients by design. `ydotool` works but requires the `ydotoold` daemon running with appropriate uinput permissions. `hands doctor` reports whether the daemon is reachable.
- **macOS Accessibility permission on first run.** `osascript -e 'tell application "System Events" to keystroke "..."'` requires Accessibility permission for the parent process. First run will trigger a system prompt; users have to allow it once before keystroke automation works.
- **Claude Login mode lacks an audit trail.** As covered in the security section — the `claude` CLI doesn't surface tool calls back to hands. Full audit requires SDK mode.
- **SDK mode is Anthropic-only today.** The computer-use beta (`computer_20251124`) is an Anthropic API; OpenAI / Gemini have no native equivalent. dario routing helps for non-computer-use traffic but does not bridge this. Provider abstraction is a v0.4 candidate, not in v0.3.
- **`--dry-run` does not prevent every side effect of the planning step.** If the model decides to call a tool that involves an HTTP request as part of "planning what to do," that request still fires (in SDK mode `--dry-run` only stubs the *executor*, not the *model's own reads*). Practically rare; flagging in case it matters.
- **Voice mode requires SoX (Windows / macOS) or arecord (Linux).** Whisper binary is downloaded by `hands voice-setup`; recording dependency is a separate install — doctor reports it.
- **No session resume across reboots.** Session memory lives in process; once you exit `hands run`, the conversation is gone. Long multi-day automation is out of scope today.

---

## Platform support

| OS | Status | Computer Control | Notes |
|---|---|---|---|
| **Windows 10 / 11** | Best-supported | PowerShell (pre-installed) | The OS hands was developed and exercised on |
| **macOS 12+** | Cross-platform smoke pending | `open` + AppleScript / `osascript` | Accessibility permission required for keystrokes; install `cliclick` (`brew install cliclick`) for `hands` SDK-mode mouse / keyboard |
| **Linux (X11)** | Cross-platform smoke pending | `xdotool` + `scrot` | `apt install xdotool scrot` (Debian/Ubuntu); equivalents on other distros |
| **Linux (Wayland)** | Cross-platform smoke pending | `ydotool` + `grim` | `ydotoold` daemon required for input; `apt install ydotool grim` |

Voice control needs SoX (Windows / macOS via `choco install sox` / `brew install sox`) or arecord (Linux, usually pre-installed).

Run **`hands doctor`** to verify your setup — reports every dependency state with install hints for what's missing.

---

## Commands

### Setup

```bash
hands init                  # one-shot interactive setup; safe to re-run
hands auth                  # change auth mode (Claude Login ↔ API Key)
hands auth --status         # show current auth mode (no key material emitted)
hands voice-setup           # download whisper.cpp + speech model for --voice
```

### Running

```bash
hands run "<prompt>"        # interactive computer control session
hands run "<prompt>" --voice          # voice input via local whisper
hands run "<prompt>" --dry-run        # plan + audit-log without executing (SDK mode)
hands run "<prompt>" -m claude-opus-4-6     # override model
hands run "<prompt>" -b 10.00         # SDK budget cap (USD); default $5.00
hands run "<prompt>" -t 100           # max turns per task; default 50
```

### Health & diagnostics

```bash
hands doctor                # aggregated health report; paste into bug reports
hands doctor --json         # structured for CI / scripts
hands doctor --skip-dario   # skip the dario reachability probe
hands check                 # platform-deps subset of doctor (legacy; doctor covers everything)
hands config                # view config
hands config --model claude-opus-4-6 --turns 100   # update fields
```

`hands run --dry-run` is the audit-trail-and-no-side-effects path; useful for first runs against new task classes or for reviewing a model's plan before committing. Forces SDK mode if you're on Claude Login (Claude Login can't be intercepted at the tool level).

---

## Architecture

```
src/
  cli.ts            # Commander entry, command dispatch
  init.ts           # interactive first-run wizard
  auth.ts           # Claude Login / API Key flow
  run.ts            # mode picker (CLI vs SDK), --dry-run gating
  cli-mode.ts       # Claude Login: spawns `claude` CLI, MCP server, interactive loop
  sdk-mode.ts       # SDK mode: Anthropic SDK, computer-use beta, audit, dry-run
  mcp-server.ts     # MCP server exposing the screenshot tool to the `claude` CLI
  doctor.ts         # health report
  system-prompt.ts  # OS-aware system-prompt builders (win32 / darwin / linux)
  platform/         # screenshot / mouse / keyboard / screen-info per platform
  voice/            # whisper setup + audio recorder
  util/
    config.ts       # ~/.hands/config.json load / save / dir creation
    audit.ts        # ~/.hands/audit.jsonl append / read / rotate
    guardrails.ts   # GUARDRAIL_PROMPT + heuristic checkCommand
    output.ts       # chalked stdout helpers
```

Six runtime dependencies — `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `commander`, `chalk`, `inquirer`, `express`. Resist adding more: the security story rests on the surface staying small enough to audit.

---

## Configuration

Stored at `~/.hands/config.json`, dir auto-created with `0700` perms on POSIX. All fields can also be set via env vars or `hands config <flag>`.

```json
{
  "authMode": "oauth",
  "model": "claude-sonnet-4-6",
  "maxBudgetUsd": 5.00,
  "maxTurns": 50,
  "voice": {
    "whisperModel": "base",
    "silenceThresholdDb": -40,
    "silenceDurationMs": 1500
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `authMode` | `"oauth"` \| `"api_key"` | `"oauth"` | Set by `hands auth`. OAuth = Claude Login (zero cost). |
| `apiKey` | string | — | Anthropic API key when `authMode === "api_key"`. Never emitted in user-facing output. |
| `model` | string | `claude-sonnet-4-6` | Model ID passed to the API. |
| `maxBudgetUsd` | number | `5.00` | SDK-mode budget cap. Run halts cleanly if exceeded. |
| `maxTurns` | number | `50` | Hard ceiling on turns per task. |
| `voice.whisperModel` | string | `"base"` | whisper.cpp model size. `tiny` / `base` / `small`. |
| `voice.silenceThresholdDb` | number | `-40` | dB below which audio counts as silence. |
| `voice.silenceDurationMs` | number | `1500` | Silence duration that ends recording. |

Env wins over config: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (for SDK + dario routing), plus standard Node env handled by the SDK.

---

## Troubleshooting

**`hands doctor` says my platform tool is missing.** Doctor's install hint covers the common case for each OS. After installing, re-run `hands doctor` to confirm.

**Claude opens a screenshot loop instead of using the shell.** The system prompt branches on `process.platform`. If the model is on the wrong branch (e.g. WSL reporting as `linux` but you wanted PowerShell guidance), this would explain it. Run `node -e "console.log(process.platform)"` to confirm what hands sees. Override is not exposed today — file an issue if you hit a real edge.

**Wayland keystrokes don't land.** `ydotool` requires the `ydotoold` daemon. Check with `systemctl --user status ydotoold` (or your init system's equivalent). Some distros need uinput group membership for the calling user.

**macOS osascript prompts for permission on every run.** First run only — once you grant Accessibility permission in System Settings → Privacy & Security → Accessibility for the parent process (your terminal app), subsequent runs reuse it.

**`hands auth --status` shows `Mode: API Key (***)` — where did the partial key go?** v0.3.0 closes a CodeQL `js/clear-text-logging` finding by removing all key substrings from user-facing output (matches dario v3.7.2+). The key is still in `~/.hands/config.json`. Use `cat ~/.hands/config.json` if you need to verify locally.

**My SDK-mode session burned $X — was that supposed to happen?** SDK mode without dario routing pays per token at the computer-use beta rates. Screenshots are the largest input-token contributor. Mitigate: (1) route through dario for $0 against Claude Max, (2) prefer Claude Login mode, (3) use `--dry-run` to plan first.

**The agent didn't roll back a destructive operation.** It can't — once a `Bash` / `Write` tool call fires, the action is real. The audit log shows what happened; the agent is not a transactional system.

**dario routing isn't picking up my SDK calls.** Check `hands doctor` — it reports the effective base URL and probes dario's `/health`. If the URL is unset, the SDK falls back to `api.anthropic.com` direct. Check that `ANTHROPIC_BASE_URL` is set in the same shell that launches `hands run`.

**I can't reproduce a bug.** `hands doctor --json > doctor.json` and attach it to your issue along with the failing prompt and the audit log tail (`tail -50 ~/.hands/audit.jsonl`).

---

## Trust and transparency

| Signal | Status |
|---|---|
| **Runtime dependencies** | Six — `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `commander`, `chalk`, `inquirer`, `express`. Audited per the security policy. |
| **Credentials** | Stored locally in `~/.hands/config.json`. Dir auto-set to `0700` on POSIX; doctor warns if perms drift. Key material never appears in stdout, error messages, audit log, or doctor output. |
| **Network scope** | Only your configured LLM endpoint (Anthropic or whatever dario routes to) and, in `voice-setup`, the GitHub mirror that hosts whisper.cpp binaries. No telemetry, no analytics, no phone-home. Verify with `lsof -i` during a run. |
| **Audit log** | Local-only at `~/.hands/audit.jsonl`. SDK-mode tool invocations only. Rotates at 10 MB; two files total. |
| **Code-scanning** | CodeQL runs on every PR + weekly schedule. 0 open alerts as of v0.3.0. |
| **Branch protection** | `main` requires `actionlint`, `analyze`, `build (20)`, `build (22)` checks; force-push and deletion blocked; conversation resolution required. |
| **Release attestation** | Every npm publish carries a SLSA provenance attestation generated by GitHub Actions. Verifiable via `npm audit signatures @askalf/hands`. |
| **Telemetry** | None. |
| **License** | MIT |
| **Affiliation** | Independent, unofficial, third-party. Not affiliated with Anthropic, OpenAI, GitHub, Discord, or any other company mentioned. |

---

## Reporting bugs / contributing

- **Bugs / feature requests** — open an [issue](https://github.com/askalf/hands/issues). Include `hands doctor --json` output and the failing prompt.
- **Security issues** — email **security@askalf.org**, not a public issue. See [SECURITY.md](SECURITY.md).
- **PRs welcome.** See [CONTRIBUTING.md](CONTRIBUTING.md) for build / test flow. Code style matches dario / agent / deepdive: small TypeScript, pure decision functions where possible, `strict: true`, no `any`, no unused imports.

Run `npm install && npm run build && npm test` to get a working dev tree (49 assertions across 5 test files; runs in ~2s).

---

## Full Platform

This CLI is a standalone computer-use agent. For the broader askalf workforce — a Docker-Compose stack with 18 specialist agents and an orchestrator working tickets autonomously, a dashboard for supervising them, and LLM routing through dario so you can bring your own Claude Max subscription:

```bash
curl -fsSL https://get.askalf.org | bash
```

[askalf.org](https://askalf.org) · [askalf/platform](https://github.com/askalf/platform) · [FLEET.md](https://github.com/askalf/platform/blob/main/docs/FLEET.md)

---

## Links

- [npm package](https://www.npmjs.com/package/@askalf/hands)
- [CHANGELOG](CHANGELOG.md)
- [SECURITY](SECURITY.md)
- [DISCLAIMER](DISCLAIMER.md)
- [@ask_alf on X](https://x.com/ask_alf)

## License

MIT

---

## Also by askalf

| Project | What it does |
|---------|-------------|
| [agent](https://github.com/askalf/agent) | Device connector. Registers any machine with your askalf forge so the fleet can run shell or Claude Code tasks on it. |
| [browser-bridge](https://github.com/askalf/browser-bridge) | Stealth headless Chromium in a container. CDP on 9222 — Playwright/Puppeteer/MCP-compatible. |
| [claude-sync](https://github.com/askalf/claude-sync) | Cross-machine Claude Code session sync. |
| [dario](https://github.com/askalf/dario) | Local LLM router. Use your Claude Max/Pro subscription as an API. |
| [deepdive](https://github.com/askalf/deepdive) | Local research agent. Plan → search → fetch → extract → synthesize. Cited answers. |
| [git-providers](https://github.com/askalf/git-providers) | Unified GitHub + GitLab + Bitbucket Cloud REST clients behind one GitProvider interface. Plus a 44-entry api-key-provider taxonomy. |
| [install-kit](https://github.com/askalf/install-kit) | curl-pipe-bash template for self-hosted Docker apps. |
| [pgflex](https://github.com/askalf/pgflex) | One Postgres API. Two modes (real PG ↔ PGlite WASM). |
| [platform](https://github.com/askalf/platform) | The full self-hosted askalf workforce — forge, dashboard, fleet of specialists. |
| [redisflex](https://github.com/askalf/redisflex) | One Redis API. Two modes (ioredis ↔ in-process). |
