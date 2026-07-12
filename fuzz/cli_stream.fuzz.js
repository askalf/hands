// Fuzz the Claude Code stream parser — every JSONL line the claude child
// emits (model output, tool results, future event shapes hands doesn't model)
// flows through parseStreamLine. Its documented contract: malformed lines and
// unknown event types yield [] — never a throw, never a non-array — because
// one odd line must not break a run.
import { parseStreamLine } from '../dist/cli-stream.js';

function assertEvents(evs, label) {
  if (!Array.isArray(evs)) {
    throw new Error(`${label}: parseStreamLine returned a non-array`);
  }
  for (const e of evs) {
    if (!e || typeof e !== 'object' || typeof e.kind !== 'string') {
      throw new Error(`${label}: event without a string kind`);
    }
  }
}

export function fuzz(data) {
  const s = data.toString('utf8');

  assertEvents(parseStreamLine(s), 'raw line');

  // Wrap the bytes into the event envelopes the parser walks deepest, so the
  // content-block extraction sees adversarial shapes, not just parse failures.
  let inner;
  try { inner = JSON.parse(s); } catch { inner = s; }
  const envelopes = [
    { type: 'system', subtype: 'init', session_id: s },
    { type: 'assistant', message: { content: [inner, { type: 'tool_use', name: s, input: inner }, { type: 'text', text: s }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: inner }, inner] } },
    { type: 'result', subtype: s, is_error: inner, result: inner, total_cost_usd: inner, usage: inner },
    { type: s, message: inner },
  ];
  for (const env of envelopes) {
    assertEvents(parseStreamLine(JSON.stringify(env)), `envelope ${env.type}`);
  }
}
