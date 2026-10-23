#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import {
  AGENTS,
  PACKAGE_ROOT,
  configFilePath,
  loadConfig,
  localApiUrl,
  redactConfig,
  resolveConfigPath,
  userConfigPath,
  validateConfig,
  webhookUrl,
  writeConfigFile,
} from './config.mjs';
import { describeReachability, probeWebhook } from './reachability.mjs';
import { ConfigError, TelegramError } from './errors.mjs';
import { install } from './install.mjs';
import { log } from './logger.mjs';
import { Notifier } from './notifier.mjs';
import { closeServer, startServer } from './server.mjs';
import { TelegramClient } from './telegram.mjs';

const HELP = `TelegramNotify — Telegram notifications and replies for coding agents

Usage: telegram-notify <command> [options]

Commands:
  serve                 Run the bridge (webhook + local agent event API)
  init                  Create a standalone config.json for CLI-only installs
  doctor                Check configuration, Telegram connectivity and the webhook
  send <text>           Send a notification; --wait accepts a Telegram reply
  webhook set           Register the Telegram webhook (needs publicUrl)
  webhook info          Show what Telegram currently calls
  webhook delete        Remove the webhook
  install               Install agent hooks (--agent copilot|claude|opencode|all)
  config                Print the effective configuration with secrets masked
  pending               List requests waiting for an answer
  status                Bridge health and pending requests

Common options:
  --config <file>       Read this config file instead of the VS Code settings
  --json                Machine-readable output

serve options:
  --set-webhook         Register the webhook on startup (also when publicUrl is set)
  --port <port>         Override webhookPort
  --polling             Force long polling (webhook off) without editing the config
  --no-polling          Force webhook mode without editing the config

send options:
  --type <type>         question | permission | completed | info | error (default: info)
  --agent <name>        Agent label shown in the message
  --options <a,b,c>     Inline buttons for the answer
  --wait                Wait for a Telegram answer
  --timeout <seconds>   How long to wait (default: replyTimeoutSeconds)

install options:
  --agent <name>        copilot | claude | opencode | all (default: all)
  --project <dir>       Project root (default: current directory)
  --global              Install into the user-level agent config where supported
  --approvals           Copilot only: answer tool permissions from Telegram
`;

/**
 * `AbortSignal.timeout` starts a libuv timer that keeps the event loop alive.
 * On Windows, exiting while one is pending trips an assertion
 * (`UV_HANDLE_CLOSING` in async.c), so signals are created here and aborted
 * before the process leaves.
 */
const liveSignals = new Set();

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    liveSignals.delete(controller);
    controller.abort(new Error(`timed out after ${ms}ms`));
  }, ms);
  timer.unref?.();
  const signal = controller.signal;
  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      liveSignals.delete(controller);
    },
    { once: true },
  );
  liveSignals.add(controller);
  return signal;
}

function abortAllSignals() {
  for (const controller of [...liveSignals]) {
    try {
      controller.abort(new Error('cli exiting'));
    } catch {
      /* already aborted */
    }
  }
  liveSignals.clear();
}

/**
 * Lets Node drain before exiting instead of tearing down handles mid-flight.
 *
 * @param {number} code
 */
async function exit(code) {
  abortAllSignals();
  for (const channel of [process.stdout, process.stderr]) {
    if (!channel.writableEnded) {
      await new Promise((resolve) => channel.write('', resolve));
    }
  }
  process.exitCode = code;
}

async function main(argv) {
  const { command, positionals, flags } = parseArgs(argv);
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const configOptions = { configPath: flags.config };
  const json = Boolean(flags.json);

  switch (command) {
    case 'serve':
      return await serve(configOptions, flags, json);
    case 'init':
      return initCommand(flags, json);
    case 'doctor':
      return await doctor(configOptions, json);
    case 'send':
      return await send(configOptions, positionals.join(' '), flags, json);
    case 'webhook':
      return await webhook(configOptions, positionals[0], flags, json);
    case 'install':
      return installCommand(flags, json);
    case 'config':
      return configCommand(configOptions, json);
    case 'pending':
    case 'status':
      return await statusCommand(configOptions, json);
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function serve(configOptions, flags, json) {
  const config = loadConfig({ ...configOptions, allowPartial: true });
  if (flags.port) config.webhookPort = Number(flags.port);
  if (flags.polling) config.webhookEnabled = false;
  if (flags['no-polling']) config.webhookEnabled = true;

  const problems = validateConfig(config);
  for (const problem of problems) log.warn(`config: ${problem}`);

  const notifier = new Notifier(config);
  const bridge = await startServer(config, { notifier });
  const base = localApiUrl(config);

  if (!json) {
    process.stdout.write(
      [
        `TelegramNotify listening on ${config.webhookHost}:${config.webhookPort}`,
        `Config: ${config.sourcePath || `(none — run "npm run init" to create ${userConfigPath()})`}`,
        `Notifications: ${config.notificationsEnabled ? 'on' : 'off'}`,
        `Delivery: ${config.webhookEnabled ? `webhook POST ${config.webhookPath} (X-Telegram-Bot-Api-Secret-Token required)` : `long polling every ${config.pollingTimeoutSeconds}s`}`,
        `Local API: POST ${base}/event/{${AGENTS.join('|')}} · GET ${base}/pending · GET ${base}/health`,
        `Agents: ${Object.entries(config.agents).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(' ')}`,
        notifier.ready ? 'Telegram: ready' : 'Telegram: NOT configured (set botToken and chatId)',
        '',
      ].join('\n'),
    );
  }

  if (config.webhookEnabled && (flags['set-webhook'] || config.publicUrl)) {
    try {
      const info = await notifier.telegram.setWebhook({
        url: webhookUrl(config),
        secretToken: config.webhookSecretToken,
      });
      log.info(`webhook registered: ${info.url}`);
    } catch (err) {
      log.error(`could not register the webhook: ${err.message}`);
    }
  }

  const shutdown = async () => {
    log.info('shutting down');
    await closeServer(bridge.server, notifier, bridge.polling);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return null; // keep running
}

async function doctor(configOptions, json) {
  const config = loadConfig({ ...configOptions, allowPartial: true });
  const report = {
    configFile: config.sourcePath || resolveConfigPath(configOptions.configPath),
    problems: validateConfig(config),
    notificationsEnabled: config.notificationsEnabled,
    delivery: config.webhookEnabled ? 'webhook' : 'polling',
    telegram: {},
    webhook: {},
    bridge: {},
    agents: config.agents,
  };

  const telegram = new TelegramClient(config);
  if (config.botToken) {
    try {
      const me = await telegram.getMe();
      report.telegram.bot = `@${me.username} (${me.id})`;
    } catch (err) {
      report.telegram.botError = err.message;
    }
    if (config.chatIds[0]) {
      try {
        const chat = await telegram.call('getChat', { chat_id: config.chatIds[0] });
        report.telegram.chat = chat.title || chat.username || String(chat.id);
      } catch (err) {
        report.telegram.chatError = err.message;
      }
    }
    try {
      report.webhook = await telegram.getWebhookInfo();
    } catch (err) {
      report.webhook = { error: err.message };
    }
  }

  try {
    const response = await fetch(`${localApiUrl(config)}/health`, { signal: timeoutSignal(3000) });
    report.bridge = await response.json();
  } catch {
    report.bridge = { running: false };
  }

  // The webhook URL is the only leg Telegram can use, and a site that is not
  // deployed shows up as a 404 in getWebhookInfo after the first real message.
  // Polling does not use it, so it is only probed in webhook mode.
  report.reachability = config.webhookEnabled ? await probeWebhook(config, { timeoutMs: 8000 }) : { url: '', problem: '' };

  const failed = report.problems.length || report.telegram.botError || report.reachability.problem;
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return failed ? 1 : 0;
  }

  const lines = ['TelegramNotify doctor', ''];
  lines.push(`config source    : ${report.configFile || `not found — run "npm run init" to create ${userConfigPath()}`}`);
  lines.push(`problems         : ${report.problems.length ? report.problems.join('; ') : 'none'}`);
  lines.push(`notifications    : ${report.notificationsEnabled ? 'on' : 'off'}`);
  lines.push(`bot              : ${report.telegram.bot || report.telegram.botError || 'not checked'}`);
  lines.push(`chat             : ${report.telegram.chat || report.telegram.chatError || 'not checked'}`);
  const webhook = report.webhook || {};
  if (report.delivery === 'polling') {
    lines.push(`delivery         : long polling (webhook off${webhook.url ? `; Telegram still has ${webhook.url}` : ''})`);
  } else {
    lines.push(`delivery         : webhook`);
    lines.push(`webhook url      : ${webhook.url || '(not set)'}`);
  }
  if (webhook.pending_update_count !== undefined) lines.push(`pending updates  : ${webhook.pending_update_count}`);
  if (webhook.last_error_message) {
    // Telegram keeps the last error after it recovers, so it is history, not
    // current state — the reachability probe below is what decides today.
    const when = webhook.last_error_date ? formatStamp(webhook.last_error_date) : 'unknown time';
    const resolved = report.reachability.status === 405 || report.reachability.status === 401;
    lines.push(`webhook last error: ${webhook.last_error_message} (${when})${resolved ? ' — resolved, the URL answers now' : ''}`);
  }
  if (report.delivery === 'webhook') {
    lines.push(`public reachable : ${describeReachability(report.reachability)}`);
    if (report.reachability.problem) lines.push(`                   ${report.reachability.problem}`);
  }
  const bridgeState = report.bridge.running === false ? 'not running' : `running on port ${report.bridge.port}`;
  const pollingState = report.bridge.polling?.active ? `, polling (${report.bridge.polling.handled} update(s) handled)` : '';
  lines.push(`bridge           : ${bridgeState}${report.delivery === 'polling' ? pollingState : ''}`);
  lines.push(`agents           : ${Object.entries(report.agents).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(' ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return failed ? 1 : 0;
}

/**
 * @param {number} seconds unix timestamp from the Bot API
 */
function formatStamp(seconds) {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
}

async function send(configOptions, text, flags, json) {
  if (!text) {
    process.stderr.write('Nothing to send. Usage: telegram-notify send "message" [--wait]\n');
    return 2;
  }
  const config = loadConfig(configOptions);
  const notifier = new Notifier(config);
  const result = await notifier.notify({
    type: flags.type || 'info',
    agent: flags.agent || 'cli',
    title: flags.title || undefined,
    message: text,
    options: typeof flags.options === 'string' ? flags.options.split(',').map((option) => option.trim()) : undefined,
    waitForReply: Boolean(flags.wait),
    timeoutSeconds: flags.timeout ? Number(flags.timeout) : undefined,
  });

  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!result.ok) process.stderr.write(`Not sent: ${result.reason || result.error}\n`);
  else if (result.waitForReply) process.stdout.write(`Answered: ${result.answer}\n`);
  else process.stdout.write(`Sent (message ${result.messageId})\n`);
  return result.ok ? 0 : 1;
}

async function webhook(configOptions, action, flags, json) {
  const config = loadConfig(configOptions);
  const telegram = new TelegramClient(config);

  if (action === 'set') {
    const url = flags.url || webhookUrl(config);
    if (!url) throw new ConfigError(['publicUrl (or --url) is required to register the webhook']);
    const info = await telegram.setWebhook({ url, secretToken: config.webhookSecretToken });
    process.stdout.write(`${json ? JSON.stringify(info, null, 2) : `Webhook set to ${info.url}`}\n`);
    return 0;
  }
  if (action === 'delete') {
    await telegram.deleteWebhook();
    process.stdout.write('Webhook removed.\n');
    return 0;
  }
  if (action === 'info' || !action) {
    const info = await telegram.getWebhookInfo();
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }
  process.stderr.write('Usage: telegram-notify webhook <set|info|delete>\n');
  return 2;
}

function installCommand(flags, json) {
  const agent = flags.agent || 'all';
  const root = flags.project ? String(flags.project) : process.cwd();
  const result = install(root, {
    agent,
    global: Boolean(flags.global),
    approvals: Boolean(flags.approvals),
  });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Installed hooks for ${agent} in ${root}\n`);
    for (const file of result.files) process.stdout.write(`  ${file}\n`);
    for (const note of result.notes) process.stdout.write(`  note: ${note}\n`);
  }
  return 0;
}

function initCommand(flags, json) {
  // Same location the extension reads: user data, never the source folder.
  const file = configFilePath(flags.config ? String(flags.config) : undefined);
  if (fs.existsSync(file) && !flags.force) {
    process.stderr.write(`${file} already exists. Use --force to replace it.\n`);
    return 1;
  }
  const example = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'config.example.json'), 'utf8'));
  example.botToken = '';
  example.chatId = '';
  example.publicUrl = '';
  example.webhookSecretToken = randomBytes(24).toString('base64url');
  if (flags.port) example.webhookPort = Number(flags.port);
  writeConfigFile(file, example);

  if (json) process.stdout.write(`${JSON.stringify({ file }, null, 2)}\n`);
  else {
    process.stdout.write(
      [
        `Created ${file}`,
        'Next: set botToken and chatId, then start the bridge with "npm start".',
      ].join('\n') + '\n',
    );
  }
  return 0;
}

function configCommand(configOptions, json) {
  const config = loadConfig({ ...configOptions, allowPartial: true });
  const redacted = { ...redactConfig(config), problems: validateConfig(config) };
  if (json) {
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
    process.stdout.write(`\nchats: ${config.chatIds.join(', ') || '(none)'}\n`);
  }
  return 0;
}

async function statusCommand(configOptions, json) {
  const config = loadConfig({ ...configOptions, allowPartial: true });
  const base = localApiUrl(config);
  let health;
  let pending = [];
  try {
    const response = await fetch(`${base}/health`, { signal: timeoutSignal(3000) });
    health = await response.json();
    const pendingResponse = await fetch(`${base}/pending`, { signal: timeoutSignal(3000) });
    pending = (await pendingResponse.json()).pending || [];
  } catch {
    health = { running: false };
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ health, pending }, null, 2)}\n`);
    return health.running === false ? 1 : 0;
  }

  if (health.running === false) {
    process.stdout.write(`Bridge is not running on ${base}. Start it with: telegram-notify serve\n`);
    return 1;
  }
  const lines = [
    `Bridge: ${health.ready ? 'ready' : 'not configured'} · port ${health.port} · ${health.delivery || 'webhook'} · uptime ${health.uptimeSeconds}s`,
    `Agents: ${Object.entries(health.agents || {}).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(' ')}`,
    `Pending: ${pending.length}`,
  ];
  if (health.polling?.active) {
    lines.push(`Polling: ${health.polling.handled} update(s), ${health.polling.errors} error(s)${health.polling.lastError ? ` — ${health.polling.lastError}` : ''}`);
  }
  for (const item of pending) {
    lines.push(`  ${item.id} ${item.agent} ${item.type} ${item.title || ''} (${item.expiresInSeconds}s left)`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{command: string, positionals: string[], flags: Record<string, string|boolean>}} */
  const result = { command: '', positionals: [], flags: {} };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === undefined) break;
    if (arg === '--') {
      result.positionals.push(...args);
      break;
    }
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=');
      const key = rawKey.trim();
      if (key.startsWith('no-')) {
        result.flags[key.slice(3)] = false;
      } else if (inlineValue !== undefined) {
        result.flags[key] = inlineValue;
      } else {
        const next = args[0];
        if (next !== undefined && !next.startsWith('--')) {
          result.flags[key] = next;
          args.shift();
        } else {
          result.flags[key] = true;
        }
      }
      continue;
    }
    if (!result.command) result.command = arg;
    else result.positionals.push(arg);
  }
  return result;
}

  main(process.argv.slice(2))
  .then(async (code) => {
    if (code === null) return; // server keeps the process alive
    await exit(code);
  })
  .catch(async (err) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n`);
    } else if (err instanceof TelegramError) {
      process.stderr.write(`\n${err.message}\n`);
    } else {
      process.stderr.write(`\n${err.stack || err.message}\n`);
    }
    await exit(1);
  });
