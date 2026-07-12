// Fuzz the PreToolUse guardrail hook — hands' enforcement boundary. The hook
// receives whatever JSON Claude Code hands it and must decide deny/defer over
// the hard-block list. Its documented contract: decideHook is pure and NEVER
// throws — anything unexpected defers — because a hook crash would take the
// decision path down (the runtime fails open by design, so a crash silently
// disables enforcement). A deny must always carry a reason, and denyResponse
// must always emit the exact JSON shape Claude Code parses.
import { decideHook, denyResponse } from '../dist/hook-pre-tool-use.js';

function assertDecision(d, label) {
  if (!d || typeof d.deny !== 'boolean') {
    throw new Error(`${label}: decideHook returned a malformed decision`);
  }
  if (d.deny && (typeof d.reason !== 'string' || d.reason.length === 0)) {
    throw new Error(`${label}: deny without a usable reason`);
  }
}

export function fuzz(data) {
  const s = data.toString('utf8');

  // Raw hostile payloads: the bytes themselves, their JSON.parse when they
  // parse, and prototype-named/nested junk keyed off the input.
  const payloads = [s, s.length, null, undefined];
  try { payloads.push(JSON.parse(s)); } catch {}
  payloads.push({ [s.slice(0, 32)]: s, ['__proto__']: s, tool_input: s });

  // A correctly-shaped PreToolUse Bash payload with a hostile command —
  // this drives the guardrail matcher (evaluateCommand) over arbitrary bytes.
  payloads.push({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: s },
  });

  for (const p of payloads) {
    assertDecision(decideHook(p), typeof p);
  }

  const resp = JSON.parse(denyResponse(s));
  if (resp?.hookSpecificOutput?.permissionDecision !== 'deny') {
    throw new Error('denyResponse lost the deny decision');
  }
}
