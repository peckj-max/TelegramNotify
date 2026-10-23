import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentMessage, formatNotification } from '../src/message.mjs';
import { optionKeyboard, parseCallbackData, parseCommand } from '../src/notifier.mjs';

test('formatNotification escapes agent supplied text', () => {
  const text = formatNotification({
    type: 'permission',
    agent: 'claude',
    title: 'Needs <script>',
    message: 'run & continue',
    cwd: 'D:\\work',
    waitForReply: true,
    options: ['Allow', 'Deny'],
  });
  assert.ok(text.includes('Needs &lt;script&gt;'));
  assert.ok(text.includes('run &amp; continue'));
  assert.ok(text.includes('Reply with /1 /2'));
});

test('formatAgentMessage truncates to the configured limit', () => {
  const text = formatAgentMessage({ type: 'info', message: 'x'.repeat(500) }, 120);
  assert.ok(text.length <= 120);
  assert.ok(text.endsWith('…'));
});

test('option keyboard carries a compact callback id', () => {
  const keyboard = optionKeyboard('deadbeef', ['Allow once', 'Deny']);
  assert.equal(keyboard.inline_keyboard.length, 2);
  const parsed = parseCallbackData(keyboard.inline_keyboard[1][0].callback_data);
  assert.equal(parsed.id, 'deadbeef');
  assert.equal(parsed.index, 1);
});

test('parseCallbackData ignores foreign callbacks', () => {
  assert.equal(parseCallbackData('other:1'), null);
  assert.equal(parseCallbackData('tn:nothex:1'), null);
});

test('parseCommand understands commands, options and bot suffixes', () => {
  assert.deepEqual(parseCommand('/list'), { name: 'list', arg: '', text: '' });
  assert.deepEqual(parseCommand('/2'), { name: 'option', arg: '2', text: '2' });
  assert.deepEqual(parseCommand('/answer deadbeef yes'), { name: 'answer', arg: 'deadbeef yes', text: 'deadbeef yes' });
  assert.deepEqual(parseCommand('/status@MyBot'), { name: 'status', arg: '', text: '' });
  assert.equal(parseCommand('just text').name, '');
});
