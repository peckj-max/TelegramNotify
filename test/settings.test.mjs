import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, validateConfig, writeConfigFile } from '../src/config.mjs';
import { configFromSettings } from '../src/settings.mjs';

const manifest = JSON.parse(
  fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'package.json'), 'utf8'),
);

test('the manifest contributes the required settings', () => {
  const properties = manifest.contributes.configuration.properties;
  for (const key of [
    'telegramNotify.notificationsEnabled',
    'telegramNotify.botToken',
    'telegramNotify.chatId',
    'telegramNotify.webhookEnabled',
    'telegramNotify.webhookPort',
    'telegramNotify.webhookSecretToken',
    'telegramNotify.agents.copilot',
    'telegramNotify.agents.claude',
    'telegramNotify.agents.opencode',
  ]) {
    assert.ok(properties[key], `${key} is contributed`);
  }
  assert.equal(manifest.contributes.configuration.title, 'TelegramNotify');
  assert.equal(manifest.main, './extension.js');
});

test('the settings are sorted and the webhook fields are contiguous', () => {
  const entries = Object.entries(manifest.contributes.configuration.properties);
  const orders = entries.map(([, value]) => value.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'order is ascending');

  const keys = entries.map(([key]) => key.replace('telegramNotify.', ''));
  const firstWebhook = keys.findIndex((key) => key.startsWith('webhook'));
  const lastWebhook = keys.length - 1 - [...keys].reverse().findIndex((key) => key.startsWith('webhook'));
  const group = keys.slice(firstWebhook, lastWebhook + 1);
  // publicUrl and pollingTimeoutSeconds belong to the webhook group as well.
  assert.ok(group.every((key) => key.startsWith('webhook') || key === 'publicUrl' || key === 'pollingTimeoutSeconds'), group.join(','));
  assert.equal(keys.indexOf('notificationsEnabled'), 0, 'Enable notification comes first');
  assert.equal(keys.indexOf('webhookEnabled'), firstWebhook, 'Enable Webhook opens the webhook group');
  assert.equal(keys[keys.length - 1], 'logLevel', 'the log level stays last');
});

test('the old autoStart switch is gone', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['telegramNotify.autoStart'], undefined);
  assert.ok(properties['telegramNotify.notificationsEnabled']);
});

test('the manifest stays CommonJS-loadable by the extension host', () => {
  assert.equal(manifest.type, undefined, 'no "type": "module" — the host requires the main file');
  assert.ok(fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'extension.js')));
});

test('settings map onto a valid runtime config', () => {
  const raw = configFromSettings({
    notificationsEnabled: false,
    botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
    chatId: '-100123, 42',
    webhookEnabled: true,
    webhookPort: 9001,
    webhookSecretToken: 'abc_DEF-123',
    'agents.copilot': false,
    'agents.claude': true,
    'agents.opencode': false,
  });
  const config = normalizeConfig(raw, { env: {} });
  assert.equal(config.webhookPort, 9001);
  assert.equal(config.notificationsEnabled, false);
  assert.equal(config.webhookEnabled, true);
  assert.deepEqual(config.chatIds, ['-100123', '42']);
  assert.deepEqual(config.agents, { copilot: false, claude: true, opencode: false });
  assert.deepEqual(validateConfig(config), []);
});

test('polling settings survive the mapping', () => {
  const config = normalizeConfig(
    configFromSettings({
      botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
      chatId: '42',
      webhookEnabled: false,
      pollingTimeoutSeconds: 40,
    }),
    { env: {} },
  );
  assert.equal(config.webhookEnabled, false);
  assert.equal(config.pollingTimeoutSeconds, 40);
  assert.equal(config.notificationsEnabled, true);
  assert.deepEqual(validateConfig(config), [], 'a polling install needs no secret token');
});

test('empty settings leave the required fields unset', () => {
  const config = normalizeConfig(configFromSettings({ botToken: '', chatId: '' }), { env: {} });
  const problems = validateConfig(config);
  assert.ok(problems.some((problem) => problem.includes('botToken')));
  assert.ok(problems.some((problem) => problem.includes('chatId')));
});

test('the editor-only switches are not part of the bridge config', () => {
  const config = normalizeConfig(
    configFromSettings({
      botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
      chatId: '42',
      webhookSecretToken: 'abc_DEF-123',
      autoStart: false,
      logLevel: 'debug',
    }),
    { env: {} },
  );
  assert.equal('autoStart' in config, false);
  assert.equal('logLevel' in config, false);
  assert.deepEqual(config.chatIds, ['42']);
  assert.equal(config.webhookSecretToken, 'abc_DEF-123');
});

test('writeConfigFile round-trips with CRLF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-notify-cfg-'));
  const file = path.join(dir, 'config.json');
  writeConfigFile(file, { botToken: 'x', chatId: '1' });

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'no lone LF');
  assert.deepEqual(JSON.parse(text), { botToken: 'x', chatId: '1' });
  assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'no temp file left behind');
});
