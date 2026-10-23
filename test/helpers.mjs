import assert from 'node:assert/strict';

/** Minimal stand-in for TelegramClient; records what would have been sent. */
export class FakeTelegram {
  constructor() {
    this.enabled = true;
    this.sent = [];
    this.edits = [];
    this.answers = [];
    this.failNext = null;
    this.nextMessageId = 100;
  }

  async sendMessage(message) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const messageId = this.nextMessageId;
    this.nextMessageId += 1;
    this.sent.push({ ...message, message_id: messageId });
    return { message_id: messageId, chat: { id: message.chatId } };
  }

  async tryEditMessageText(message) {
    this.edits.push(message);
    return {};
  }

  async answerCallbackQuery(query) {
    this.answers.push(query);
    return true;
  }

  /** Long polling is never used in these tests unless a case opts in. */
  async getUpdates() {
    return [];
  }

  async deleteWebhook() {
    this.webhookDeleted = true;
    return true;
  }

  get last() {
    return this.sent[this.sent.length - 1];
  }
}

export function testConfig(overrides = {}) {
  return {
    botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
    chatIds: ['42'],
    notificationsEnabled: true,
    agents: { copilot: true, claude: true, opencode: true },
    webhookEnabled: true,
    webhookPort: 0,
    webhookHost: '127.0.0.1',
    webhookPath: '/telegram/webhook',
    webhookSecretToken: 'test-secret-token',
    publicUrl: '',
    pollingTimeoutSeconds: 1,
    replyTimeoutSeconds: 5,
    notifyOnCompleted: true,
    notifyOnStart: false,
    maxMessageLength: 3800,
    sourcePath: null,
    ...overrides,
  };
}

export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function parseCallback(button) {
  const [, id, index] = /^tn:([0-9a-f]{8}):(\d)$/i.exec(button.callback_data);
  assert.ok(id, 'callback data carries a request id');
  return { id, index: Number(index) };
}
