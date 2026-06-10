import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimScreenshots } from '../dist/sdk-mode.js';

const img = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
const toolResultMsg = (...blocks) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: blocks }],
});

test('trims screenshots nested in tool_result blocks beyond keepLast', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'task' }, img()] }, // initial screenshot
    toolResultMsg(img()),
    toolResultMsg({ type: 'text', text: 'bash ok' }),
    toolResultMsg(img()),
    toolResultMsg(img()),
  ];
  trimScreenshots(messages, 2);

  // The newest two nested screenshots survive
  assert.equal(messages[4].content[0].content[0].type, 'image');
  assert.equal(messages[3].content[0].content[0].type, 'image');
  // Older nested screenshot is replaced with a placeholder, source dropped
  assert.equal(messages[1].content[0].content[0].type, 'text');
  assert.equal(messages[1].content[0].content[0].text, '[screenshot omitted]');
  assert.equal('source' in messages[1].content[0].content[0], false);
  // The oldest of all — the top-level initial screenshot — is trimmed too
  assert.equal(messages[0].content[1].type, 'text');
  assert.equal(messages[0].content[1].text, '[screenshot omitted]');
  // Non-image blocks are untouched
  assert.equal(messages[0].content[0].text, 'task');
  assert.equal(messages[2].content[0].content[0].text, 'bash ok');
});

test('keeps everything when screenshot count is within keepLast', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'task' }, img()] },
    toolResultMsg(img()),
  ];
  trimScreenshots(messages, 5);
  assert.equal(messages[0].content[1].type, 'image');
  assert.equal(messages[1].content[0].content[0].type, 'image');
});

test('handles string content and empty tool_result content without throwing', () => {
  const messages = [
    { role: 'user', content: 'plain string content' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: [] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
  ];
  trimScreenshots(messages, 1);
  assert.equal(messages[0].content, 'plain string content');
});
