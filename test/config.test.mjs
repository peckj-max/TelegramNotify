import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, redactConfig, validateConfig, webhookUrl } from '../src/config.mjs';

test('normalizeConfig applies defaults and keeps the agent switches', () => {
  const config = normalizeConfig(
    { botToken: '1:abc', chatId: 42, webhookSecretToken: 's' },
    { env: {}, sourcePath: 'x.json' },
  );
  assert.equal(config.webhookPort, 8787);
  assert.equal(config.webhookPath, '/telegram/webhook');
  assert.equal(config.webhookHost, '0.0.0.0');
  assert.deepEqual(config.chatIds, ['42']);
  assert.deepEqual(config.agents, { copilot: true, claude: true, opencode: true });
  assert.equal(config.sourcePath, 'x.json');
});

test('normalizeConfig reads comma separated chat ids and per-agent flags', () => {
  const config = normalizeConfig(
    {
      chatId: '1, -100200 ',
      agents: { copilot: false, claude: 'yes', opencode: 'off' },
      webhookPath: 'hook',
    },
    { env: {} },
  );
  assert.deepEqual(config.chatIds, ['1', '-100200']);
  assert.deepEqual(config.agents, { copilot: false, claude: true, opencode: false });
  assert.equal(config.webhookPath, '/hook');
});

test('environment variables override the file', () => {
  const config = normalizeConfig(
    { botToken: 'from-file', chatId: '1', webhookSecretToken: 'file-secret', agents: { claude: false } },
    {
      env: {
        TELEGRAM_NOTIFY_BOT_TOKEN: 'from-env',
        TELEGRAM_NOTIFY_CHAT_ID: '2',
        TELEGRAM_NOTIFY_WEBHOOK_PORT: '9999',
        TELEGRAM_NOTIFY_WEBHOOK_SECRET: 'env-secret',
        TELEGRAM_NOTIFY_AGENT_CLAUDE: 'true',
      },
    },
  );
  assert.equal(config.botToken, 'from-env');
  assert.deepEqual(config.chatIds, ['2']);
  assert.equal(config.webhookPort, 9999);
  assert.equal(config.webhookSecretToken, 'env-secret');
  assert.equal(config.agents.claude, true);
});

test('validateConfig reports every required setting', () => {
  const config = normalizeConfig({}, { env: {} });
  const problems = validateConfig(config);
  assert.ok(problems.some((problem) => problem.includes('botToken')));
  assert.ok(problems.some((problem) => problem.includes('chatId')));
  assert.ok(problems.some((problem) => problem.includes('webhookSecretToken')));
});

test('validateConfig accepts a complete configuration', () => {
  const config = normalizeConfig(
    {
      botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
      chatId: '-1001234567890',
      webhookPort: 8787,
      webhookSecretToken: 'abc_DEF-123',
      publicUrl: 'https://example.com',
    },
    { env: {} },
  );
  assert.deepEqual(validateConfig(config), []);
});

test('validateConfig rejects an insecure public url and a bad secret', () => {
  const config = normalizeConfig(
    {
      botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
      chatId: '42',
      webhookSecretToken: 'bad secret!',
      publicUrl: 'http://example.com',
    },
    { env: {} },
  );
  const problems = validateConfig(config);
  assert.ok(problems.some((problem) => problem.includes('webhookSecretToken')));
  assert.ok(problems.some((problem) => problem.includes('https')));
});

test('webhookUrl appends the path once', () => {
  const config = normalizeConfig({ publicUrl: 'https://x.example.com/', webhookPath: '/telegram/webhook' }, { env: {} });
  assert.equal(webhookUrl(config), 'https://x.example.com/telegram/webhook');

  config.publicUrl = 'https://x.example.com/telegram/webhook';
  assert.equal(webhookUrl(config), 'https://x.example.com/telegram/webhook');
});

test('redactConfig hides the secrets', () => {
  const config = normalizeConfig(
    { botToken: '123456789:abcdefghijklmnopqrstuvwxyz', chatId: '1', webhookSecretToken: 'supersecretvalue' },
    { env: {} },
  );
  const redacted = redactConfig(config);
  assert.ok(!redacted.botToken.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.equal(redacted.webhookSecretToken, 'supe***');
});
