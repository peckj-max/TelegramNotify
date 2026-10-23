import test from 'node:test';
import assert from 'node:assert/strict';
import { PollingReceiver } from '../src/polling.mjs';
import { normalizeConfig, validateConfig } from '../src/config.mjs';

/** Feeds scripted getUpdates responses, then idles. */
function scriptedTelegram(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    telegram: {
      async getUpdates(options) {
        calls.push(options);
        const page = pages[index];
        index += 1;
        if (!page) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [];
        }
        return page;
      },
      async deleteWebhook() {
        calls.push({ deleteWebhook: true });
        return true;
      },
    },
  };
}

test('polls, advances the offset and hands every update to the notifier', async () => {
  const handled = [];
  const { telegram, calls } = scriptedTelegram([
    [
      { update_id: 10, message: { text: 'first' } },
      { update_id: 11, callback_query: { data: 'tn:aaaaaaaa:0' } },
    ],
    [{ update_id: 12, message: { text: 'second' } }],
  ]);

  const receiver = new PollingReceiver({
    telegram,
    onUpdate: async (update) => handled.push(update.update_id),
    timeoutSeconds: 5,
  });

  await receiver.start({ clearWebhook: true });
  for (let i = 0; i < 100 && handled.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
  await receiver.stop();

  assert.deepEqual(handled, [10, 11, 12]);
  assert.equal(receiver.offset, 13);
  assert.equal(receiver.status().handled, 3);
  assert.ok(calls.some((call) => call.deleteWebhook), 'the webhook is removed first');
  assert.ok(calls.some((call) => call && call.timeout === 5));
});

test('a 409 stops polling with the reason recorded', async () => {
  const telegram = {
    async getUpdates() {
      throw new Error('Telegram getUpdates failed (409): Conflict: can\'t use getUpdates while webhook is active');
    },
  };
  const receiver = new PollingReceiver({ telegram, onUpdate: async () => {}, retryDelayMs: 5 });
  await receiver.start();
  for (let i = 0; i < 100 && receiver.running; i += 1) await new Promise((r) => setTimeout(r, 10));

  assert.equal(receiver.running, false);
  assert.match(receiver.status().lastError, /webhook is registered/);
  await receiver.stop();
});

test('other errors are retried instead of ending the loop', async () => {
  let attempts = 0;
  const telegram = {
    async getUpdates() {
      attempts += 1;
      if (attempts < 3) throw new Error('network hiccup');
      return [];
    },
  };
  const receiver = new PollingReceiver({ telegram, onUpdate: async () => {}, retryDelayMs: 1 });
  await receiver.start();
  for (let i = 0; i < 100 && attempts < 3; i += 1) await new Promise((r) => setTimeout(r, 10));

  assert.ok(attempts >= 3, `retried (${attempts} attempts)`);
  assert.equal(receiver.running, true);
  await receiver.stop();
  assert.equal(receiver.running, false);
});

test('a failing handler does not kill the loop', async () => {
  const seen = [];
  const { telegram } = scriptedTelegram([[{ update_id: 1 }, { update_id: 2 }]]);
  const receiver = new PollingReceiver({
    telegram,
    onUpdate: async (update) => {
      seen.push(update.update_id);
      if (update.update_id === 1) throw new Error('handler exploded');
    },
  });
  await receiver.start();
  for (let i = 0; i < 100 && seen.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
  await receiver.stop();
  assert.deepEqual(seen, [1, 2]);
});

test('stop during an idle poll returns promptly', async () => {
  const telegram = {
    async getUpdates() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [];
    },
  };
  const receiver = new PollingReceiver({ telegram, onUpdate: async () => {} });
  await receiver.start();
  await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  await receiver.stop();
  assert.ok(Date.now() - started < 500);
  assert.equal(receiver.running, false);
});

test('webhook disabled means polling mode, and the secret is not required', () => {
  const config = normalizeConfig(
    { botToken: '123456789:abcdefghijklmnopqrstuvwxyz', chatId: '42', webhookEnabled: false },
    { env: {} },
  );
  assert.equal(config.webhookEnabled, false);
  assert.deepEqual(validateConfig(config), [], 'no secret token needed when the webhook is off');
});

test('webhook enabled still requires the secret token', () => {
  const config = normalizeConfig({ botToken: '123456789:abcdefghijklmnopqrstuvwxyz', chatId: '42' }, { env: {} });
  assert.equal(config.webhookEnabled, true);
  assert.ok(validateConfig(config).some((problem) => problem.includes('webhookSecretToken')));
});
