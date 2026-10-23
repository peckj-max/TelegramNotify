import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeTelegram, testConfig, waitFor } from './helpers.mjs';
import { Notifier } from '../src/notifier.mjs';
import { closeServer, startServer } from '../src/server.mjs';
import { TelegramNotify } from '../src/hooks/opencode-plugin.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hooks');
const SECRET = 'test-secret-token';

async function withBridge(run) {
  const telegram = new FakeTelegram();
  const notifier = new Notifier(testConfig(), { telegram });
  const bridge = await startServer(testConfig(), { notifier });
  const port = bridge.address.port;
  const base = `http://127.0.0.1:${port}`;
  const previous = process.env.TELEGRAM_NOTIFY_URL;
  process.env.TELEGRAM_NOTIFY_URL = base;
  try {
    await run({ telegram, notifier, base });
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_NOTIFY_URL;
    else process.env.TELEGRAM_NOTIFY_URL = previous;
    await closeServer(bridge.server, notifier);
  }
}

function runHook(script, input, env, args = []) {
  const child = spawn(process.execPath, [path.join(HOOKS, script), ...args], {
    env: { ...process.env, TELEGRAM_NOTIFY_LOG_LEVEL: 'silent', TELEGRAM_NOTIFY_HOOK_TIMEOUT: '20', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(input));
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function pressButton(base, button) {
  const response = await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: 11,
      callback_query: { id: 'cb', data: button.callback_data, message: { chat: { id: 42 } } },
    }),
  });
  assert.equal(response.status, 200);
}

test('claude PermissionRequest hook returns the Telegram decision', async () => {
  await withBridge(async ({ telegram, base }) => {
    const hook = runHook(
      'claude-hook.mjs',
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: 'D:\\w' },
      { TELEGRAM_NOTIFY_URL: base },
    );

    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.text.includes('Bash'));
    await pressButton(base, telegram.last.replyMarkup.inline_keyboard[1][0]);

    const { code, stdout, stderr } = await hook.done;
    assert.equal(code, 0, stderr);
    const output = JSON.parse(stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(output.hookSpecificOutput.decision.behavior, 'deny');
  });
});

test('claude AskUserQuestion hook returns the answer as the tool reason', async () => {
  await withBridge(async ({ telegram, base }) => {
    const hook = runHook(
      'claude-hook.mjs',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which database?', options: [{ label: 'SQL Server' }, { label: 'Postgres' }] }] },
        cwd: 'D:\\w',
      },
      { TELEGRAM_NOTIFY_URL: base },
    );

    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.replyMarkup, 'question options become buttons');

    const response = await fetch(`${base}/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
      body: JSON.stringify({
        update_id: 12,
        message: {
          message_id: 77,
          chat: { id: 42 },
          from: { is_bot: false },
          text: 'Postgres 17',
          reply_to_message: { message_id: telegram.last.message_id },
        },
      }),
    });
    assert.equal(response.status, 200);

    const { code, stdout } = await hook.done;
    assert.equal(code, 0);
    const output = JSON.parse(stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('Postgres 17'));
  });
});

test('claude Stop hook sends a completion notification and exits quietly', async () => {
  await withBridge(async ({ telegram, base }) => {
    const hook = runHook(
      'claude-hook.mjs',
      { hook_event_name: 'Stop', cwd: 'D:\\w', transcript_path: '' },
      { TELEGRAM_NOTIFY_URL: base },
    );
    const { code, stdout } = await hook.done;
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '');
    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.text.includes('Claude Code finished'));
  });
});

test('hook stays silent when the bridge is not running', async () => {
  const hook = runHook(
    'claude-hook.mjs',
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} },
    { TELEGRAM_NOTIFY_URL: 'http://127.0.0.1:1', TELEGRAM_NOTIFY_HOOK_TIMEOUT: '5' },
  );
  const { code, stdout } = await hook.done;
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '');
});

test('copilot preToolUse hook prints a Copilot decision', async () => {
  await withBridge(async ({ telegram, base }) => {
    const hook = runHook(
      'copilot-hook.mjs',
      { hookEventName: 'preToolUse', toolName: 'bash', toolArgs: { command: 'npm test' }, cwd: 'D:\\w' },
      { TELEGRAM_NOTIFY_URL: base },
    );

    await waitFor(() => telegram.sent.length === 1);
    await pressButton(base, telegram.last.replyMarkup.inline_keyboard[0][0]);

    const { code, stdout } = await hook.done;
    assert.equal(code, 0);
    const output = JSON.parse(stdout);
    assert.equal(output.permissionDecision, 'allow');
  });
});

test('copilot sessionEnd hook notifies completion', async () => {
  await withBridge(async ({ telegram, base }) => {
    const hook = runHook(
      'copilot-hook.mjs',
      { hookEventName: 'sessionEnd', cwd: 'D:\\w' },
      { TELEGRAM_NOTIFY_URL: base },
    );
    const { code } = await hook.done;
    assert.equal(code, 0);
    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.text.includes('Copilot finished'));
  });
});

test('copilot agentStop hook infers the event and reads the agent host transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-transcript-'));
  const transcript = path.join(dir, 'events.jsonl');
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'assistant.message', data: { content: 'hook probe ok' } }),
      JSON.stringify({ type: 'assistant.turn_end', data: {} }),
      '',
    ].join('\n'),
  );

  await withBridge(async ({ telegram, base }) => {
    const hook = runHook(
      'copilot-hook.mjs',
      { sessionId: 's1', transcriptPath: transcript, stopReason: 'end_turn', stop_hook_active: false, cwd: 'D:\\w' },
      { TELEGRAM_NOTIFY_URL: base },
    );
    const { code, stderr } = await hook.done;
    assert.equal(code, 0, stderr);
    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.text.includes('Copilot finished'));
    assert.ok(telegram.last.text.includes('hook probe ok'));
  });
});

test('copilot hook accepts the event name as an argument', async () => {
  await withBridge(async ({ telegram, base }) => {
    const hook = runHook('copilot-hook.mjs', {}, { TELEGRAM_NOTIFY_URL: base }, ['agentStop']);
    const { code } = await hook.done;
    assert.equal(code, 0);
    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.text.includes('Copilot finished'));
  });
});

test('copilot sessionEnd does not duplicate a recent agentStop', async () => {
  const sessionId = `dedupe-${process.pid}-${Date.now()}`;
  await withBridge(async ({ telegram, base }) => {
    const stop = runHook('copilot-hook.mjs', { sessionId, stopReason: 'end_turn' }, { TELEGRAM_NOTIFY_URL: base });
    assert.equal((await stop.done).code, 0);
    await waitFor(() => telegram.sent.length === 1);

    const end = runHook('copilot-hook.mjs', { sessionId, reason: 'complete' }, { TELEGRAM_NOTIFY_URL: base });
    assert.equal((await end.done).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(telegram.sent.length, 1);
  });
});

test('opencode plugin answers a permission.asked event', async () => {
  await withBridge(async ({ telegram, base }) => {
    const replies = [];
    const ctx = {
      directory: 'D:\\w',
      client: {
        postSessionIdPermissionsPermissionId: async (args) => {
          replies.push(args);
        },
      },
    };
    const plugin = await TelegramNotify(ctx);
    const handling = plugin.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'perm-1', sessionID: 'ses-1', action: 'bash: npm test', resources: ['npm test'] },
      },
    });

    await waitFor(() => telegram.sent.length === 1);
    assert.ok(telegram.last.text.includes('OpenCode needs permission'));
    await pressButton(base, telegram.last.replyMarkup.inline_keyboard[0][0]);
    await handling;

    assert.equal(replies.length, 1);
    assert.equal(replies[0].path.id, 'ses-1');
    assert.equal(replies[0].body.reply, 'once');
  });
});

test('opencode plugin reports a finished session once', async () => {
  await withBridge(async ({ telegram }) => {
    const plugin = await TelegramNotify({ directory: 'D:\\w' });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-2' } } });
    await plugin.event({ event: { type: 'session.execution.succeeded', properties: { sessionID: 'ses-2' } } });
    await waitFor(() => telegram.sent.length >= 1);
    assert.equal(telegram.sent.length, 1);
    assert.ok(telegram.last.text.includes('OpenCode finished'));
  });
});
