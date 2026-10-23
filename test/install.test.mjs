import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, installClaude, installCopilot, installOpencode } from '../src/install.mjs';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-notify-'));
}

test('installs Claude Code hooks and stays idempotent', () => {
  const root = tempProject();
  installClaude(root);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const first = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.ok(first.hooks.PermissionRequest.length >= 1);
  assert.equal(first.hooks.PermissionRequest[0].hooks[0].type, 'command');
  assert.ok(first.hooks.PermissionRequest[0].hooks[0].command.includes('claude-hook.mjs'));
  assert.equal(first.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.equal(first.hooks.Stop[0].hooks[0].async, true);

  installClaude(root);
  const second = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(second.hooks.PermissionRequest.length, first.hooks.PermissionRequest.length);
  assert.equal(second.hooks.Stop.length, 1);
});

test('keeps unrelated Claude hooks', () => {
  const root = tempProject();
  const dir = path.join(root, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }),
  );

  installClaude(root);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop.length, 2);
  assert.ok(settings.hooks.Stop.some((entry) => entry.hooks[0].command.includes('echo other')));
});

test('installs Copilot hooks with approvals opt-in', () => {
  const root = tempProject();
  installCopilot(root);
  const file = path.join(root, '.github', 'hooks', 'telegram-notify.json');
  const passive = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(passive.version, 1);
  assert.ok(Array.isArray(passive.hooks.sessionEnd));
  assert.equal(passive.hooks.preToolUse, undefined);
  assert.ok(passive.hooks.sessionEnd[0].powershell.includes('copilot-hook.mjs'));
  assert.ok(passive.hooks.agentStop[0].powershell.endsWith('agentStop'));
  assert.ok(passive.hooks.sessionEnd[0].powershell.endsWith('sessionEnd'));

  installCopilot(root, { approvals: true });
  const withApprovals = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(withApprovals.hooks.preToolUse));
});

test('installs the OpenCode plugin stub and registers it once', () => {
  const root = tempProject();
  installOpencode(root);
  const configPath = path.join(root, 'opencode.json');
  const first = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(first.plugin, ['./.opencode/telegram-notify.mjs']);

  const stub = fs.readFileSync(path.join(root, '.opencode', 'telegram-notify.mjs'), 'utf8');
  assert.ok(stub.includes('opencode-plugin.mjs'));

  installOpencode(root);
  const second = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(second.plugin.length, 1);
});

test('install all reports every file it wrote', () => {
  const root = tempProject();
  const result = install(root, { agent: 'all' });
  assert.equal(result.files.length, 4);
  for (const file of result.files) assert.ok(fs.existsSync(file), file);
});
