import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadConfigForHooks, vscodeSettingsPath, vscodeSettingsPaths } from '../src/config.mjs';

function tempSettings(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, contents, 'utf8');
  return { dir, file };
}

test('the settings file paths list VS Code builds', () => {
  const paths = vscodeSettingsPaths();
  assert.ok(paths.length >= 1);
  assert.ok(paths.every((candidate) => candidate.endsWith('settings.json')));
  assert.ok(paths.every((candidate) => candidate.includes('User')));
});

test('settings.json is read even with comments and trailing commas', () => {
  const { dir, file } = tempSettings(`{
    // my settings
    "editor.fontSize": 14,
    "telegramNotify.botToken": "123456789:abcdefghijklmnopqrstuvwxyz",
    "telegramNotify.chatId": "42",
    "telegramNotify.webhookPort": 9000,
    "telegramNotify.webhookSecretToken": "abc_DEF-123",
    "telegramNotify.publicUrl": "https://example.com",
  }`);
  try {
    const config = loadConfig({ settingsPath: file, env: {} });
    assert.equal(config.botToken, '123456789:abcdefghijklmnopqrstuvwxyz');
    assert.deepEqual(config.chatIds, ['42']);
    assert.equal(config.webhookPort, 9000);
    assert.equal(config.sourcePath, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only the telegramNotify section is taken from settings.json', () => {
  const { dir, file } = tempSettings(
    JSON.stringify({
      'editor.fontSize': 14,
      'telegramNotify.notificationsEnabled': false,
      'telegramNotify.webhookEnabled': false,
      'telegramNotify.pollingTimeoutSeconds': 40,
    }),
  );
  try {
    const config = loadConfig({ settingsPath: file, env: {}, allowPartial: true });
    assert.equal(config.notificationsEnabled, false);
    assert.equal(config.webhookEnabled, false);
    assert.equal(config.pollingTimeoutSeconds, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit --config file is used instead of the editor settings', () => {
  const { dir, file } = tempSettings(JSON.stringify({ 'telegramNotify.botToken': 'from-settings' }));
  const other = path.join(dir, 'config.json');
  fs.writeFileSync(
    other,
    JSON.stringify({
      botToken: '987654321:zyxwvutsrqponmlkjihgfedcba',
      chatId: '7',
      webhookSecretToken: 'explicit_secret-token',
    }),
  );
  try {
    const config = loadConfig({ configPath: other, env: {} });
    assert.equal(config.botToken, '987654321:zyxwvutsrqponmlkjihgfedcba');
    assert.equal(config.sourcePath, other);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a settings file without the section is ignored', () => {
  const { dir, file } = tempSettings(JSON.stringify({ 'editor.fontSize': 14 }));
  try {
    const config = loadConfig({ settingsPath: file, env: {}, allowPartial: true });
    assert.equal(config.botToken, '');
    assert.notEqual(config.sourcePath, file, 'a file with no telegramNotify section is not the source');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed settings file cannot break a hook', () => {
  const { dir, file } = tempSettings('{ this is not json ');
  const previous = process.env.TELEGRAM_NOTIFY_SETTINGS;
  process.env.TELEGRAM_NOTIFY_SETTINGS = file;
  try {
    const config = loadConfigForHooks();
    assert.ok(config, 'a config object is always returned');
    assert.equal(typeof config.replyTimeoutSeconds, 'number');
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_NOTIFY_SETTINGS;
    else process.env.TELEGRAM_NOTIFY_SETTINGS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the extension no longer needs a config file of its own', () => {
  const { dir, file } = tempSettings(
    JSON.stringify({
      'telegramNotify.botToken': '123456789:abcdefghijklmnopqrstuvwxyz',
      'telegramNotify.chatId': '42',
      'telegramNotify.webhookSecretToken': 'abc_DEF-123',
    }),
  );
  try {
    const config = loadConfig({ settingsPath: file, env: {} });
    assert.equal(config.botToken, '123456789:abcdefghijklmnopqrstuvwxyz');
    assert.deepEqual(config.chatIds, ['42']);
    assert.equal(config.sourcePath, file, 'the settings file itself was the source');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
