# hands

**Your LLM on your mouse, keyboard, and screen.**

One npm install. Hands-on computer control — PowerShell-first for speed, screenshot tool for visual verification when needed, voice input optional. Routes through [dario](https://github.com/askalf/dario) or any Anthropic-compat endpoint — keep using your Claude Max subscription and pay zero per-token on the happy path.

> **Status:** seeded from `@askalf/hands`'s v0.3.7 tree (commit `bef177d`), the last standalone computer-use state before that repo pivoted to a fleet-bridge role. This repo is the continuation of that work — pre-1.0, modernization in progress.

## Install

```bash
npm i -g @askalf/hands
```

Requires Node.js 20+ and [Claude CLI](https://docs.anthropic.com/en/docs/claude-code).

## Quick Start

```bash
# 1. One-shot interactive setup — auth + voice (optional) + dario routing tips
hands init

# 2. Run
hands run "open notepad and type hello world"

# 3. Voice mode — talk to your computer (if you said yes to voice during init)
hands run "open notepad" --voice
```

`hands init` walks through every choice the CLI asks you to make: installing the `claude` CLI if missing (needed for zero-per-token Claude Login mode), picking auth mode, optionally downloading whisper.cpp for voice, and — if you're on API Key mode — nudging you toward routing through [dario](https://github.com/askalf/dario) for zero per-token cost. Safe to re-run at any time.

Then Claude opens Notepad, types "Hello World", and asks **"What next?"** — type or speak your next command.

## How It Works

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

**PowerShell-first** — Claude runs PowerShell commands directly to open apps, browse the web, manage files, and automate tasks. No slow screenshot loops. A screenshot MCP tool is available when Claude needs to visually verify what's on screen, but most tasks complete entirely through PowerShell.

**Voice control** — Add `--voice` to speak commands instead of typing. Uses local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for transcription — free, private, completely offline. No cloud APIs, no data leaves your machine.

## Authentication

### Claude Login (Recommended)

Uses your existing Claude Pro/Max subscription. **Zero extra API costs.** This is the default.

```bash
npm i -g @anthropic-ai/claude-code
claude auth login
hands auth
# Select "Claude Login"
```

### API Key (Fallback)

Paste your Anthropic API key. Pay per token. Uses the Anthropic SDK directly with the `computer_20251124` tool.

```bash
hands auth
# Select "API Key" → paste your sk-ant-... key
```

> **Note:** SDK mode uses computer-use API calls which cost per token. A simple task like "open notepad" can cost several dollars. Claude Login mode is strongly recommended.

### Routing through dario (zero per-token cost in SDK mode)

If you're running [dario](https://github.com/askalf/dario) locally, hands will auto-route SDK-mode calls through it — including SDK mode's computer-use calls, which can then bill against your Claude Max subscription instead of per-token API overage. The `@anthropic-ai/sdk` client defaults its `baseURL` and `apiKey` to the standard env vars, so this works with zero hands-side config:

```bash
# in whatever shell starts hands:
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario            # or your DARIO_API_KEY if you set one

dario proxy                                # keep this running
hands run "open notepad"
```

Verify the routing is live with `hands check` (reports the effective base URL) or by watching `dario proxy -v` while hands is running — a request should show up in dario's log. Claude Login mode (the default) spawns the `claude` CLI child process directly, so the env-var-routing flow only matters for SDK mode.

## Commands

### `hands init`

Interactive first-run wizard. One command covers every choice hands asks a new user to make before their first `hands run`: install `claude` CLI if missing, pick auth mode (Claude Login vs API Key), optionally download whisper.cpp for voice, and — if you're on API Key mode — surface the dario routing tip for zero per-token cost. Delegates to the same `hands auth` / `hands voice-setup` flows the individual commands use, so there's no duplicated logic.

```bash
hands init
```

Safe to re-run — every step asks before changing anything, and defaults reflect current config. Environment snapshot at the top shows what's already installed so you know what will be skipped.

### `hands run "<prompt>"`

Start an interactive computer control session.

```bash
hands run "resize all images in ./assets to 800px wide"
hands run "open VS Code and create a Flask hello world app"
hands run "go to github.com and star the askalf/hands repo"
```

Each task completes and prompts **"What next?"** for follow-up commands. Type `exit` or hit Ctrl+C to end the session.

Options:
- `-v, --voice` — Use voice input (microphone → whisper transcription)
- `-m, --model <model>` — Model to use (default: `claude-sonnet-4-6`)
- `-b, --budget <amount>` — Max budget in USD for SDK mode (default: `5.00`)
- `-t, --turns <count>` — Max turns per task (default: `50`)

### `hands auth`

Configure authentication interactively.

- `hands auth --status` — Show current auth status

### `hands voice-setup`

Download whisper.cpp binary and speech model for voice control. One-time setup.

```bash
hands voice-setup                # default: base.en model (~148MB)
hands voice-setup --model tiny   # smaller/faster (~75MB)
hands voice-setup --model small  # more accurate (~466MB)
```

### `hands run "<prompt>" --dry-run`

Run the agent without actually doing anything on the host. In SDK mode, every tool call (shell, keyboard, mouse, screenshot) is **logged and stubbed** — the agent sees success results so the loop continues, but no command executes, no key presses, no cursor moves. The audit log at `~/.hands/audit.jsonl` shows what it would have done.

```bash
hands run "organize my downloads folder" --dry-run
# → agent plans + the audit log shows every action it would have taken
cat ~/.hands/audit.jsonl | tail -20
```

Useful for reviewing an agent's plan before trusting it with a new task, or smoke-testing a prompt change without side effects. Not supported in Claude Login mode (the `claude` child process dispatches tools itself; hands can't intercept them) — `--dry-run` forces SDK mode for that invocation.

### Audit log

Every tool invocation in SDK mode is appended to `~/.hands/audit.jsonl` with timestamp, tool name, action, summarized args (image bytes stripped, long strings truncated), duration, and outcome. The file rotates to `audit.jsonl.old` when it exceeds 10 MB. Paste the tail into issues when reporting bugs.

```bash
tail -3 ~/.hands/audit.jsonl
# {"ts":1761307432021,"tool":"computer","action":"screenshot","args":{},"durationMs":45,"ok":true}
# {"ts":1761307432190,"tool":"bash","args":{"command":"Get-Process"},"durationMs":112,"ok":true}
# {"ts":1761307432340,"tool":"computer","action":"left_click","args":{"coordinate":[640,400]},"durationMs":22,"ok":true}
```

Claude Login mode delegates tool execution to the `claude` child process, which doesn't surface individual tool calls back to hands — actions there are not logged. Use SDK mode (`hands auth` → API Key, or `--dry-run` which forces SDK) if you need a full local audit trail.

### `hands doctor`

Aggregated health report covering every subsystem hands depends on: Node version, platform, config dir state + permissions, screenshot / mouse / keyboard tool availability, Claude CLI install + version, whisper.cpp install, and — if `ANTHROPIC_BASE_URL` is set — a reachability probe for dario. Exit code 1 on any fail, 0 otherwise. Paste it into issues.

```bash
hands doctor                  # text table, non-destructive (no browser opens, no config writes)
hands doctor --json           # structured output for scripts
hands doctor --skip-dario     # skip the dario HTTP probe
hands doctor --skip-whisper   # skip the whisper-install check (useful in CI)
```

### `hands check`

Older narrower version of `doctor` — platform deps only. Kept for backwards compat; `doctor` covers everything `check` does plus auth + config + dario routing state.

### `hands config`

View or update configuration.

```bash
hands config --model claude-opus-4-6 --turns 100
```

## What It Can Do

| Capability | How |
|---|---|
| **Open apps** | `Start-Process chrome`, `Start-Process notepad` |
| **Browse the web** | Opens Chrome, navigates sites, fills forms |
| **Manage files** | Create, move, read, edit files anywhere on your system |
| **Run commands** | Git, npm, Docker, Python — any CLI tool |
| **See your screen** | Screenshot tool for visual verification when needed |
| **Voice control** | Speak commands via local whisper.cpp — offline, private |
| **Chain tasks** | Interactive loop — complete a task, ask "What next?" |
| **Session memory** | Remembers what worked and what failed across the session |
| **Self-correction** | Learns from errors within the session and adapts approach |

## Safety Guardrails

Built-in command guardrails prevent catastrophic operations before they reach the shell:

- **Hard blocks** — recursive root deletion, disk formatting, registry destruction, boot config changes, firewall disabling, user account creation, ransomware-like encryption patterns
- **System prompt injection** — Claude is instructed to verify destructive operations and prefer safe alternatives
- **Voice pipeline hardening** — input validation, temp file cleanup, process isolation

## Platform Support

| OS | Status | Computer Control |
|----|--------|-----------------|
| **Windows** | Full support | PowerShell (pre-installed) |
| **macOS** | Full support | `cliclick` (`brew install cliclick`) |
| **Linux (X11)** | Full support | `xdotool` + `scrot` (`apt install xdotool scrot`) |
| **Linux (Wayland)** | Full support | `ydotool` + `grim` (`apt install ydotool grim`) |

**Voice control** requires SoX (Windows/macOS) or arecord (Linux, pre-installed). Whisper binary is downloaded automatically by `voice-setup`.

Run `hands check` to verify your setup.

## Architecture

```
hands run "open chrome" --voice
        │
        ├── Input ─────────────────────────────
        │       │
        │       ├── --voice OFF: readline (keyboard)
        │       └── --voice ON:  mic → whisper.cpp → text
        │
        ├── Claude Login (default)
        │       │
        │       ├── Spawns claude CLI
        │       ├── --append-system-prompt (computer control agent)
        │       ├── --mcp-config (screenshot tool)
        │       ├── Claude uses built-in bash → PowerShell
        │       └── Interactive loop: task → "What next?" → repeat
        │
        └── API Key (fallback)
                │
                ├── Anthropic SDK direct
                ├── computer_20251124 + bash + text_editor tools
                └── Single-run with cost summary
```

The MCP server exposes a single `screenshot` tool. All other computer control happens through Claude's built-in bash tool running PowerShell commands — this is dramatically faster than screenshot-based control loops.

## Configuration

Config stored at `~/.hands/config.json`:

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

## Full Platform

This CLI is a standalone computer control agent. For the full autonomous fleet — 7 core agents, persistent memory, 16 communication channels (including OpenClaw bridge), 28 marketplace packages, and a mission control dashboard:

```bash
curl -fsSL https://get.askalf.org | bash
```

[askalf.org](https://askalf.org) | [GitHub](https://github.com/SprayberryLabs/askalf) | [Architecture](https://github.com/SprayberryLabs/askalf/blob/main/docs/ARCHITECTURE.md)

## Links

- [npm package](https://www.npmjs.com/package/@askalf/hands)
- [AskAlf Platform](https://askalf.org)
- [@ask_alf on X](https://x.com/ask_alf)

## License

MIT
