# Security Policy

## Supported Versions

hands is **pre-1.0**. Security fixes ship on the latest minor.

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| 0.3.x   | No        |
| < 0.3   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in hands, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@askalf.org** with:
   - Description of the vulnerability
   - Steps to reproduce (a minimal `hands run "..."` invocation, a malformed config, a specific shell payload, etc.)
   - Platform (Windows / macOS / Linux + display server if Linux)
   - Run-mode (Claude Login vs SDK / API Key)
   - Potential impact
3. **Response SLA:** Acknowledgment within 48 hours, fix within 7 days for critical issues.
4. We will coordinate disclosure with you before publishing a fix.

## Scope

The following are in scope for security reports:

- **API key / token leakage** — `sk-ant-...` keys, OAuth tokens from the peer `claude` CLI, or any other stored credential being emitted in logs, error messages, audit entries, or user-facing CLI output. The `js/clear-text-logging` class is a recurring concern for this codebase — closed in v0.3.0, but new logging paths must be reviewed against it.
- **Credential file permission issues** — `~/.hands/config.json` should be `0700` on POSIX. Any code path that writes config without enforcing perms is in scope.
- **Audit-log integrity** — bypasses that let an SDK-mode tool call execute without writing to `~/.hands/audit.jsonl`. The audit log is part of the security story; gaps in it matter.
- **Guardrail bypass** — payloads that evade `src/util/guardrails.ts` hard-blocks (the full list is enumerated in the README under "Built-in guardrails" — covers recursive root deletion, partition tools, registry wipes, boot-config edits, firewall disabling, user-account creation, ransomware-pattern encryption sweeps). The guardrails are best-effort string detection, not sandboxing — but documented bypasses still get fixed.
- **Voice subsystem injection** — `src/voice/recorder.ts` invokes SoX / arecord via `execFile` with argv arrays. Any code path that lets an attacker control a shell-string arg (a filename, a device name) is in scope.
- **Tool-input injection** — `find_files`, `read_page`, `bash`, `text_editor` arguments that allow path traversal, SSRF, or unintended shell expansion beyond what the tool spec documents.
- **Claude Login child-process leakage** — anything that exfiltrates the parent `hands` env (including credentials) into the spawned `claude` CLI in a way the user did not intend.
- **MCP server exposure** — `src/mcp-server.ts` binds locally to expose the screenshot tool. Bugs that let a non-localhost client connect, or that let a localhost attacker drive the screenshot tool, are in scope.
- **Dependency vulnerabilities** — high / critical advisories on runtime deps (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `commander`, `inquirer`, `express`, `cheerio`, `chalk`).

## Out of scope

- **Prompt injection from web pages or user-provided text.** This is a fundamental property of computer-use agents, not a hands-specific bug. The threat model is documented in the README. Reports that demonstrate a *specific* exfiltration channel (e.g. an injected prompt that reliably reads `~/.hands/config.json` via a tool call) are in scope; "the agent can be tricked" reports are not.
- **Hosted-LLM-side issues.** Bugs in Anthropic's API, the Claude Code CLI, or any other upstream endpoint should be reported to that vendor.
- **Local-machine compromise.** If an attacker already has shell access on your machine, `~/.hands/config.json` is readable by definition. hands does not attempt to defend against this; rotate the key.

## Security Architecture

### Credential storage

- `~/.hands/config.json` stores the chosen run-mode and (in API Key mode) the Anthropic API key.
- POSIX: directory created with `0700`, file written with `0600`. Windows ACLs are not currently restricted beyond defaults — this is a known gap, tracked.
- `hands auth --status` displays `Mode: API Key (***)`; the key material itself is never emitted to stdout or stderr.
- No credentials are logged. No credentials are included in error messages. No credentials are written to `~/.hands/audit.jsonl`.

### Audit log

- `~/.hands/audit.jsonl` is append-only and written by SDK mode + `--dry-run`. Each line is one tool call: timestamp, tool name, args, duration, outcome.
- The audit log is **the** observability surface for SDK mode. Anything that bypasses it bypasses the security story.
- Claude Login mode cannot audit-log individual tool calls because the `claude` child process dispatches them itself. This is documented in the README; use SDK mode or `--dry-run` when an audit trail is required.

### Run-mode defaults

- `hands run` defaults to **Claude Login** mode — the zero-cost path. SDK / per-token mode is invoked only when the user explicitly picks API Key during `hands auth` or when `--dry-run` forces it.
- Run-mode default is treated as load-bearing security state — a silent switch to SDK mode would change the billing surface without user consent.

### Guardrails (best-effort, not a sandbox)

`src/util/guardrails.ts` plus a hard-block section in the system prompt cover destructive patterns the agent will refuse to execute on its own initiative — the full enumerated list (recursive root deletion, partition tools, registry / `defaults delete` / `/etc` overwrites, boot config changes, firewall disabling, user-account creation, ransomware-pattern encryption sweeps) lives in the README under "Built-in guardrails".

These are **system-prompt and string-match guardrails, not sandboxing**. They reduce the chance the model emits a destructive command on its own initiative; they do not prevent a user from explicitly instructing one. The strongest guardrail is your prompt.

### Voice subsystem

- Recording uses SoX (macOS / Linux) or arecord (Linux) via `execFile` with argv arrays — no shell-string interpolation, so filenames and device names cannot be injected.
- Audio files live in a per-session temp directory and are unlinked immediately after transcription.
- Transcription runs entirely locally via [whisper.cpp](https://github.com/ggerganov/whisper.cpp). No audio leaves the machine.

### Network

- hands itself opens no inbound sockets except the local MCP server (loopback only) used by Claude Login mode.
- Outbound connections: the Anthropic endpoint (or whatever `ANTHROPIC_BASE_URL` the user configured — typically a local [dario](https://github.com/askalf/dario) proxy). No telemetry, no analytics, no crash reporting.
- Verify outbound surface during a run with `lsof -i` (POSIX) or `Get-NetTCPConnection` (Windows).

### Error sanitization

- API keys (`sk-ant-*`) and bearer tokens are redacted from error messages and CLI output.
- Stack traces emitted to the audit log do not include argv or env (which can carry secrets).
