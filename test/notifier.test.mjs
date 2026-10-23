import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeTelegram, parseCallback, testConfig, waitFor } from './helpers.mjs';
import { Notifier } from '../src/notifier.mjs';

test('answers a button press and marks the message resolved', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const pending = notifier.notify({
    type: 'permission',
    agent: 'claude',
    title: 'Claude Code needs permission',
    options: ['Allow once', 'Deny'],
    waitForReply: true,
  });

  await waitFor(() => telegram.sent.length === 1);
  const button = telegram.last.replyMarkup.inline_keyboard[0][0];
  const { id } = parseCallback(button);

  const result = await notifier.handleUpdate({
    callback_query: {
      id: 'cb-1',
      data: button.callback_data,
      message: { chat: { id: 42 } },
    },
  });

  assert.equal(result.handled, true);
  const resolution = await pending;
  assert.equal(resolution.ok, true);
  assert.equal(resolution.answer, 'Allow once');
  assert.equal(resolution.optionIndex, 0);
  assert.equal(resolution.source, 'button');
  assert.equal(telegram.answers[0].text, 'Selected: Allow once');
  assert.equal(telegram.edits.length, 1);
  assert.ok(telegram.edits[0].text.includes('Allow once'));
  assert.deepEqual(telegram.edits[0].replyMarkup, { inline_keyboard: [] });
  assert.equal(notifier.pending.get(id), null);
});

test('answers a message reply to the notification', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const pending = notifier.notify({
    type: 'question',
    agent: 'claude',
    message: 'Which branch?',
    waitForReply: true,
  });

  await waitFor(() => telegram.sent.length === 1);
  const messageId = telegram.last.message_id;

  const handled = await notifier.handleUpdate({
    message: {
      chat: { id: 42 },
      from: { is_bot: false },
      text: 'use release/2.0',
      reply_to_message: { message_id: messageId },
    },
  });

  assert.equal(handled.handled, true);
  const resolution = await pending;
  assert.equal(resolution.reply, 'use release/2.0');
  assert.equal(resolution.answer, 'use release/2.0');
  assert.equal(resolution.source, 'reply');
});

test('answers through /answer and /1 shortcuts', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const pending = notifier.notify({
    type: 'question',
    agent: 'copilot',
    message: 'Pick one',
    options: ['Red', 'Blue'],
    waitForReply: true,
  });

  await waitFor(() => telegram.sent.length === 1);
  const id = parseCallback(telegram.last.replyMarkup.inline_keyboard[0][0]).id;

  await notifier.handleUpdate({
    message: { chat: { id: 42 }, from: { is_bot: false }, text: `/answer ${id} 2` },
  });

  const resolution = await pending;
  assert.equal(resolution.answer, 'Blue');
  assert.equal(resolution.optionIndex, 1);
  assert.equal(resolution.source, 'button');
});

test('rejects answers from an unknown chat', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const result = await notifier.handleUpdate({
    message: { chat: { id: 999 }, from: { is_bot: false }, text: 'hi' },
  });

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'chat-not-allowed');
  assert.equal(telegram.sent.length, 0);
});

test('ignores its own bot messages', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });
  const result = await notifier.handleUpdate({
    message: { chat: { id: 42 }, from: { is_bot: true }, text: '/list' },
  });
  assert.equal(result.handled, false);
});

test('lists and cancels pending requests', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const pending = notifier.notify({ type: 'question', agent: 'claude', message: 'Still there?', waitForReply: true });
  await waitFor(() => telegram.sent.length === 1);
  const id = notifier.pending.list()[0].id;

  await notifier.handleUpdate({ message: { chat: { id: 42 }, from: { is_bot: false }, text: '/list' } });
  assert.ok(telegram.last.text.includes(id));

  await notifier.handleUpdate({ message: { chat: { id: 42 }, from: { is_bot: false }, text: `/cancel ${id}` } });
  const resolution = await pending;
  assert.equal(resolution.source, 'cancelled');
  assert.equal(notifier.pending.size, 0);
});

test('times out and keeps the notification visible', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig({ replyTimeoutSeconds: 1 }), { telegram });

  const result = await notifier.notify({ type: 'permission', agent: 'claude', message: 'Approve?', waitForReply: true, timeoutSeconds: 1 });

  assert.equal(result.timedOut, true);
  assert.equal(result.source, 'timeout');
  assert.equal(telegram.edits.length, 1);
  assert.ok(telegram.edits[0].text.includes('no answer'));
  assert.equal(telegram.edits[0].replyMarkup, undefined);
});

test('options without waitForReply are sent as info only', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const result = await notifier.notify({ type: 'info', message: 'Build is queued', options: ['Retry', 'Skip'] });
  assert.equal(result.ok, true);
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.last.replyMarkup, undefined);
  assert.equal(notifier.pending.size, 0);
});

test('a bare number answers the newest pending request', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const older = notifier.notify({ type: 'question', message: 'old', options: ['A', 'B'], waitForReply: true });
  await waitFor(() => telegram.sent.length === 1);
  const newer = notifier.notify({ type: 'question', message: 'new', options: ['C', 'D'], waitForReply: true });
  await waitFor(() => telegram.sent.length === 2);

  await notifier.handleUpdate({ message: { chat: { id: 42 }, from: { is_bot: false }, text: '2' } });
  const newest = await newer;
  assert.equal(newest.answer, 'D');

  await notifier.cancel(notifier.pending.list()[0].id);
  const oldest = await older;
  assert.equal(oldest.source, 'cancelled');
});

test('completion messages do not wait and respect the switch', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });

  const result = await notifier.notify({ type: 'completed', agent: 'copilot', message: 'done' });
  assert.equal(result.ok, true);
  assert.equal(telegram.sent.length, 1);
  assert.ok(telegram.last.text.includes('done'));
  assert.equal(telegram.last.replyMarkup, undefined);

  const quiet = new Notifier(testConfig({ notifyOnCompleted: false }), { telegram });
  const skipped = await quiet.notify({ type: 'completed', agent: 'copilot' });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'completed-disabled');
});

test('skips when Telegram is not configured', async () => {
  const telegram = new FakeTelegram();
  telegram.enabled = false;
  const notifier = new Notifier(testConfig(), { telegram });
  const result = await notifier.notify({ type: 'completed' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not-configured');
});

test('sends nothing when notifications are switched off', async () => {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig({ notificationsEnabled: false }), { telegram });
  const result = await notifier.notify({ type: 'question', message: 'Anyone?', waitForReply: true });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'notifications-disabled');
  assert.equal(telegram.sent.length, 0);
  assert.equal(notifier.pending.size, 0);
});

test('reports a Telegram failure without leaving a pending request', async () => {
  const telegram = new FakeTelegram();
  telegram.failNext = new Error('boom');
  const notifier = new Notifier(testConfig(), { telegram });

  const result = await notifier.notify({ type: 'question', message: 'Anybody?', waitForReply: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'telegram-error');
  assert.equal(notifier.pending.size, 0);
});
