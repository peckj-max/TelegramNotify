import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeTelegram, testConfig, waitFor } from './helpers.mjs';
import { Notifier } from '../src/notifier.mjs';
import { closeServer, startServer } from '../src/server.mjs';

async function withServer(run, overrides = {}) {
  const telegram = new FakeTelegram();
  const config = testConfig(overrides);
  const notifier = new Notifier(config, { telegram });
  const bridge = await startServer(config, { notifier });
  const port = bridge.address.port;
  try {
    await run({ config, notifier, telegram, base: `http://127.0.0.1:${port}`, port });
  } finally {
    await closeServer(bridge.server, notifier);
  }
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

test('health reports configuration and agents', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.ready, true);
    assert.deepEqual(body.agents, { copilot: true, claude: true, opencode: true });
    assert.equal(body.pending, 0);
  });
});

test('webhook rejects a missing or wrong secret token', async () => {
  await withServer(async ({ base }) => {
    const missing = await postJson(`${base}/telegram/webhook`, { update_id: 1 });
    assert.equal(missing.status, 401);

    const wrong = await postJson(`${base}/telegram/webhook`, { update_id: 1 }, {
      'x-telegram-bot-api-secret-token': 'not-the-secret',
    });
    assert.equal(wrong.status, 401);
  });
});

test('webhook routes a reply back to the waiting agent', async () => {
  await withServer(async ({ base, telegram }) => {
    const pendingResponse = postJson(`${base}/event/claude`, {
      type: 'question',
      message: 'Deploy now?',
      waitForReply: true,
    });

    await waitFor(() => telegram.sent.length === 1);
    const messageId = telegram.last.message_id;

    const update = {
      update_id: 7,
      message: {
        message_id: 900,
        chat: { id: 42 },
        from: { is_bot: false },
        text: 'yes, deploy',
        reply_to_message: { message_id: messageId },
      },
    };
    const accepted = await postJson(`${base}/telegram/webhook`, update, {
      'x-telegram-bot-api-secret-token': 'test-secret-token',
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ok, true);

    const response = await pendingResponse;
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.text, 'yes, deploy');
    assert.equal(result.source, 'reply');
  });
});

test('button presses resolve the waiting event', async () => {
  await withServer(async ({ base, telegram }) => {
    const pendingResponse = postJson(`${base}/event/claude`, {
      type: 'permission',
      options: ['Allow once', 'Deny'],
      waitForReply: true,
    });

    await waitFor(() => telegram.sent.length === 1);
    const data = telegram.last.replyMarkup.inline_keyboard[0][0].callback_data;

    await postJson(
      `${base}/telegram/webhook`,
      { update_id: 8, callback_query: { id: 'cb', data, message: { chat: { id: 42 } } } },
      { 'x-telegram-bot-api-secret-token': 'test-secret-token' },
    );

    const result = await (await pendingResponse).json();
    assert.equal(result.answer, 'Allow once');
    assert.equal(result.optionIndex, 0);
  });
});

test('disabled agents are skipped without calling Telegram', async () => {
  await withServer(
    async ({ base, telegram }) => {
      const response = await postJson(`${base}/event/claude`, { type: 'completed' });
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.skipped, true);
      assert.equal(body.reason, 'agent-disabled');
      assert.equal(telegram.sent.length, 0);
    },
    { agents: { copilot: true, claude: false, opencode: true } },
  );
});

test('unknown agents and invalid bodies are rejected', async () => {
  await withServer(async ({ base }) => {
    const unknown = await postJson(`${base}/event/gemini`, { type: 'completed' });
    assert.equal(unknown.status, 400);

    const invalid = await postJson(`${base}/event/claude`, { type: 'completed' }, {});
    assert.equal(invalid.status, 200); // valid body, just no reply expected
  });
});

test('pending endpoint lists waiting requests', async () => {
  await withServer(async ({ base, telegram }) => {
    const pendingResponse = postJson(`${base}/event/copilot`, {
      type: 'question',
      message: 'Still working?',
      waitForReply: true,
    });
    await waitFor(() => telegram.sent.length === 1);

    const response = await fetch(`${base}/pending`);
    const body = await response.json();
    assert.equal(body.pending.length, 1);
    assert.equal(body.pending[0].agent, 'copilot');

    const id = body.pending[0].id;
    const cancelled = await fetch(`${base}/pending/${id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);

    const result = await (await pendingResponse).json();
    assert.equal(result.source, 'cancelled');
  });
});

test('unknown routes answer 404', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
  });
});
