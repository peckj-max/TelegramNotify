import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT, configFilePath, resolveConfigPath, userConfigDir, userConfigPath } from '../src/config.mjs';

function withHome(run) {
  const previousHome = process.env.TELEGRAM_NOTIFY_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-notify-home-'));
  process.env.TELEGRAM_NOTIFY_HOME = home;
  try {
    return run(home);
  } finally {
    if (previousHome === undefined) delete process.env.TELEGRAM_NOTIFY_HOME;
    else process.env.TELEGRAM_NOTIFY_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a standalone config lives in user data, not in the extension folder', () => {
  withHome((home) => {
    assert.equal(userConfigDir(), home);
    assert.equal(userConfigPath(), path.join(home, 'config.json'));
    assert.equal(configFilePath(), path.join(home, 'config.json'));
    assert.ok(!configFilePath().startsWith(PACKAGE_ROOT), 'never inside the source');
  });
});

test('an explicit path still wins over user data', () => {
  withHome((home) => {
    const explicit = path.join(home, 'other', 'custom.json');
    assert.equal(configFilePath(explicit), path.resolve(explicit));
    assert.equal(resolveConfigPath(explicit), null);
  });
});

test('TELEGRAM_NOTIFY_CONFIG is honoured', () => {
  withHome(() => {
    const previous = process.env.TELEGRAM_NOTIFY_CONFIG;
    process.env.TELEGRAM_NOTIFY_CONFIG = path.join(os.tmpdir(), 'from-env.json');
    try {
      assert.equal(configFilePath(), path.resolve(process.env.TELEGRAM_NOTIFY_CONFIG));
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_NOTIFY_CONFIG;
      else process.env.TELEGRAM_NOTIFY_CONFIG = previous;
    }
  });
});

test('the user file is found when it exists', () => {
  withHome((home) => {
    const userFile = path.join(home, 'config.json');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(userFile, '{"botToken":"user"}');
    assert.equal(resolveConfigPath(), userFile);
  });
});

test('a config.json in the code folder is not consulted', () => {
  withHome(() => {
    const packageFile = path.join(PACKAGE_ROOT, 'config.json');
    const hadPackageFile = fs.existsSync(packageFile);
    if (!hadPackageFile) fs.writeFileSync(packageFile, '{"botToken":"from-code-folder"}');
    try {
      assert.notEqual(resolveConfigPath(), packageFile, 'the source checkout is never a config source');
    } finally {
      if (!hadPackageFile) fs.rmSync(packageFile, { force: true });
    }
  });
});
