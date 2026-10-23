import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests } from '../src/pending.mjs';

test('resolves by request id, code and Telegram message id', () => {
  const pending = new PendingRequests();
  const entry = pending.create({ agent: 'claude', type: 'question', chatId: '42', options: ['a'], timeoutSeconds: 5 });
  pending.attachMessage(entry.id, 500);

  assert.equal(pending.get(entry.id), entry);
  assert.equal(pending.getByCode(entry.code), entry);
  assert.equal(pending.getByMessageId(500), entry);

  entry.resolve({ source: 'reply', answer: 'yes', reply: 'yes', optionIndex: null, timedOut: false });
  assert.equal(pending.size, 0);
  assert.equal(pending.getByMessageId(500), null);
});

test('expires after the timeout', async () => {
  const pending = new PendingRequests();
  const entry = pending.create({ agent: 'claude', type: 'question', chatId: '42', options: [], timeoutSeconds: 1 });
  const resolution = await entry.wait;
  assert.equal(resolution.source, 'timeout');
  assert.equal(resolution.timedOut, true);
  assert.equal(pending.size, 0);
});

test('list exposes the remaining lifetime', () => {
  const pending = new PendingRequests();
  pending.create({ agent: 'copilot', type: 'permission', chatId: '42', options: ['x'], timeoutSeconds: 10, title: 'T' });
  const [item] = pending.list();
  assert.equal(item.agent, 'copilot');
  assert.equal(item.title, 'T');
  assert.ok(item.expiresInSeconds <= 10);
  pending.cancelAll();
});
