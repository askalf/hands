# Disclaimer

**Last updated: 2026-05-21**

This document is a plain-language expansion of the MIT License that ships with hands. In case of conflict, the MIT [LICENSE](LICENSE) controls.

By downloading, installing, running, linking against, or otherwise using hands (the "Software"), you acknowledge and agree to everything below. If you do not agree, do not use the Software.

---

## 1. Provided "AS IS"

The Software is provided **"AS IS" and "AS AVAILABLE"**, without warranty of any kind, express, implied, or statutory, including but not limited to:

- warranties of merchantability, fitness for a particular purpose, title, or non-infringement
- warranties that the Software will be error-free, uninterrupted, secure, or free of harmful components
- warranties that any defect or bug will be corrected
- warranties regarding the accuracy, reliability, completeness, timeliness, or usefulness of any output, action, keystroke, mouse event, or screenshot produced by or through the Software

No advice or information obtained from the authors, maintainers, contributors, or any channel associated with the project creates any warranty not expressly stated in the MIT License.

---

## 2. Limitation of liability

To the maximum extent permitted by applicable law, in no event shall the authors, maintainers, contributors, copyright holders, or any person associated with the project be liable for any:

- direct, indirect, incidental, special, exemplary, consequential, punitive, or any other damages
- loss of profits, revenue, data, goodwill, use, opportunity, or business
- service interruption, computer failure or malfunction, file deletion, configuration corruption, hardware control unintended by the user, or subscription loss, suspension, throttling, or termination
- costs of procurement of substitute goods or services
- claims by third parties

arising out of or in connection with the Software, its use, its inability to be used, its interaction with any third-party service, the actions it takes on your computer, or any content produced by it, whether based on warranty, contract, tort (including negligence), strict liability, statute, or any other legal theory, and whether or not the project has been advised of the possibility of such damages.

Where liability cannot be fully excluded under applicable law, it is limited to the maximum extent permitted.

---

## 3. No affiliation

hands is an **independent, unofficial, third-party project**. It is:

- **not affiliated with, endorsed by, sponsored by, or in any way officially connected to** Anthropic PBC, Microsoft Corporation, Apple Inc., any Linux distribution or its maintainers, the `xdotool` / `ydotool` projects, the `whisper.cpp` project, the SoX project, or any other company, product, or service mentioned in the documentation, source code, or test fixtures
- **not an official client, SDK, integration, or partner** of any of the above
- **not authorized to speak on behalf of** any of the above

All product names, logos, brands, trademarks, and registered trademarks referenced anywhere in this project are property of their respective owners. Use of those names is for identification and interoperability purposes only and does not imply endorsement.

---

## 4. User responsibility

You are solely responsible for:

- **Your use of any third-party service** reached through hands. Your use of each upstream LLM endpoint (Anthropic direct, a [dario](https://github.com/askalf/dario) proxy, or any Anthropic-compat URL you configure) is governed by that service's own terms of service, acceptable-use policy, privacy policy, rate limits, billing terms, and any other agreement you have with that service. Review them. Follow them.
- **The actions hands takes on your computer.** hands is a high-trust agent: it executes shell commands, presses keys, moves the mouse, and captures screenshots on your behalf. You are responsible for the consequences of every action it takes under your account, whether you anticipated that specific action or not.
- **Your subscriptions, API keys, OAuth credentials, and accounts.** You are responsible for all activity conducted under them. You are responsible for keeping them secure.
- **Compliance with all laws applicable to you and your use**, including but not limited to export control, sanctions, privacy, data protection, consumer protection, accessibility, and industry-specific regulations (HIPAA, PCI-DSS, FedRAMP, GDPR, CCPA, etc.).
- **The content you send through the Software and the content you receive back.** The project does not moderate, filter, store, or review this content. You are responsible for ensuring your inputs and outputs are lawful, ethical, and appropriate for your context.
- **Determining whether the Software is appropriate for your use case.** The Software is a general-purpose developer tool. It is not intended for, and is not warranted as suitable for, safety-critical, life-critical, mission-critical, high-availability, regulated, or production-grade environments without your own independent review, hardening, and diligence.

If any terms between you and a third-party service prohibit use with a computer-control tool like this one, those terms govern your relationship with that service. The project takes no position on and accepts no liability for how you use the Software with any particular third-party service.

---

## 5. No support obligation

The project is operated on a **best-effort, volunteer basis**. There is no obligation, express or implied, to:

- respond to issues, discussions, pull requests, emails, or other communications
- fix bugs, address vulnerabilities, or publish updates on any timeline
- maintain backward compatibility between versions, except where explicitly stated in release notes
- maintain the project at all

Published service-level targets (e.g., 48-hour security acknowledgment in [SECURITY.md](SECURITY.md)) are goals, not contractual commitments.

---

## 6. No availability or continuity guarantee

The Software may stop working at any time, for any reason, including but not limited to:

- changes to third-party services, APIs, protocols, authentication flows, wire formats, or terms
- changes to operating systems, runtimes, dependencies, display servers (X11 / Wayland), shells, or window managers
- the project entering maintenance mode, archive status, or being discontinued
- the project or its distribution channels (npm, GitHub) being unavailable, removed, or restricted

You should have a fallback plan if continuous availability matters to your workflow. Pinning a specific version does not guarantee that version will continue to function with third-party services or your OS as they evolve.

---

## 7. Third-party services and content

hands runs a local agent loop that forwards requests to whatever Anthropic-compatible LLM endpoint you configure (Anthropic direct, a local [dario](https://github.com/askalf/dario) proxy, or any other URL). When you use it:

- **You initiate the connection.** The project neither controls nor hosts the upstream service.
- **You are the party contracting with the upstream service** under its terms, not through the project.
- **The project does not warrant, endorse, or take responsibility for** the availability, accuracy, legality, quality, safety, or any other aspect of content, services, or responses provided by any upstream service.
- **The project does not process, store, or transmit your data outside of your local machine**, except insofar as it forwards your requests to the upstream service you yourself configured. Screenshots, keystrokes, and shell output stay on your machine except where you direct the agent to send them somewhere.

---

## 8. Credentials and local data

The Software reads, stores, and transmits credentials (API keys, OAuth tokens via the peer `claude` CLI) on your behalf, locally, to reach the services you configure:

- Storage is on the local filesystem under `~/.hands/` with restricted permissions (`0700` on POSIX) where the operating system supports it.
- The agent also reads and writes other local state: an audit log at `~/.hands/audit.jsonl` (SDK mode + `--dry-run`), temporary audio files during voice transcription, and screenshot buffers it captures during a run. It is your responsibility to know what is in these files and to manage them according to your own data-handling policies.
- You are responsible for the security of your machine, your user account, your backups, and any system where credentials or audit logs are stored.
- The project is not responsible for credential compromise, token leakage, or account actions resulting from the security of your environment, your configuration choices, or third-party software running on your system.
- If you believe a credential may have been exposed, rotate it at the upstream service immediately and review that service's documented incident procedures.

---

## 9. Computer-control risks specific to hands

hands is a **computer-use agent**. The agent has shell, keyboard, mouse, and screenshot access on your machine, gated only by your auth choice and the operating recommendations in the README. You acknowledge and agree that:

- **The agent can take actions you did not specifically anticipate.** The system prompt biases it toward predictable shell-first behavior and includes hard-block guardrails for clearly destructive patterns, but it is a language model — not a deterministic script. It can misinterpret a prompt, escalate when it should have asked, or pick a destructive shell command when a safer one existed.
- **Guardrails are not sandboxing.** The guardrails described in the README and in [SECURITY.md](SECURITY.md) are best-effort string and prompt-level mitigations. They are not a security boundary. If you need a security boundary, run hands inside a VM or container with the relevant resources restricted at the OS level.
- **Prompt injection is a real and unsolved threat.** Web pages, emails, PDFs, terminal output, and other content the agent reads can carry instructions Claude was not supposed to follow. You acknowledge this risk and take responsibility for what you point the agent at.
- **`--dry-run` is the safest mode for unfamiliar tasks.** It runs the full agent loop with every tool call audit-logged but stubbed — no shell fires, no keys press, no mouse moves. Read `~/.hands/audit.jsonl` after, reopen for real only if it looks right.
- **Claude Login mode trades observability for cost.** It dispatches tools inside the `claude` child process, where hands cannot intercept and audit-log them. If a full local audit trail matters for your use case, use SDK mode or `--dry-run`.

---

## 10. Security reports

Security issues should be reported per [SECURITY.md](SECURITY.md). Nothing in this disclaimer modifies the security-reporting process; nothing in the security-reporting process creates an enforceable service-level agreement, warranty, or indemnity.

---

## 11. Export, sanctions, regulated use

The Software is distributed from the United States. You are responsible for complying with all applicable export-control laws, sanctions regimes, and regulations in your jurisdiction, and for ensuring the Software is not used in prohibited countries, by prohibited parties, or for prohibited end uses.

The Software is **not designed, tested, or warranted for use** in environments requiring specific regulatory certifications (HIPAA, PCI-DSS, FedRAMP, SOC 2, ISO 27001, FDA, FAA, NERC-CIP, etc.). If your use falls under such a regime, you are solely responsible for determining suitability and performing any required controls, audits, or risk assessments.

---

## 12. Indemnification

To the maximum extent permitted by applicable law, you agree to indemnify, defend, and hold harmless the authors, maintainers, contributors, and copyright holders of the Software from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or in connection with:

- your use of the Software
- the actions the agent takes on your machine while you are running the Software
- your violation of any third-party terms, policies, or agreements
- your violation of any law or regulation
- your violation of any third-party right, including privacy or intellectual property rights
- any content you transmit through or cause to be produced by the Software

---

## 13. Changes to this disclaimer

This document may be updated from time to time. Changes take effect on the date shown at the top of the file. Continued use of the Software after a change indicates acceptance of the updated disclaimer.

---

## 14. Governing law and severability

This disclaimer is to be interpreted consistently with the MIT License. If any provision is held to be unenforceable under applicable law, the remaining provisions remain in full force and effect, and the unenforceable provision shall be modified to the minimum extent necessary to make it enforceable while preserving its intent.

---

## 15. Questions

For questions about this disclaimer, open a GitHub discussion. For security issues, follow [SECURITY.md](SECURITY.md). The project does not provide legal advice; if you need legal advice, consult a qualified attorney in your jurisdiction.
