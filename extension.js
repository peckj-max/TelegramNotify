'use strict';

/**
 * TelegramNotify — VS Code extension host.
 *
 * The settings in the `telegramNotify` section are the single source of truth.
 * On activation they are validated and used to start the bridge in this
 * extension host; the agent hooks read the same VS Code settings file, so no
 * configuration is duplicated anywhere.
 *
 * Two switches drive everything:
 *   notificationsEnabled  status bar click; off means the bridge stops
 *   webhookEnabled        on runs the bridge as a webhook server, off uses polling
 */

const vscode = require('vscode');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const SECTION = 'telegramNotify';

/**
 * Settings that require a running bridge to be restarted so it picks them up.
 * `notificationsEnabled` and `logLevel` deliberately are not here: the first is
 * toggled by the extension itself and the second is read on the fly.
 * `webhookEnabled` is handled separately because it switches delivery mode.
 */
const BRIDGE_SETTING_KEYS = [
  'botToken',
  'chatId',
  'webhookPort',
  'webhookSecretToken',
  'publicUrl',
  'webhookHost',
  'webhookPath',
  'replyTimeoutSeconds',
  'notifyOnCompleted',
  'notifyOnStart',
  'maxMessageLength',
  'pollingTimeoutSeconds',
  'agents.copilot',
  'agents.claude',
  'agents.opencode',
];

/** A double click delivers two command invocations; collapse them into one. */
const TOGGLE_GUARD_MS = 400;

/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.StatusBarItem} */
let statusItem;
/** @type {{ server: import('node:http').Server, notifier: any }|null} */
let bridge = null;
/** @type {any} */
let modules = null;
let starting = null;
let stopping = false;
let lastToggleAt = 0;
let toggleQueue = Promise.resolve();

/** @type {vscode.ExtensionContext|undefined} */
let context;

async function loadModules() {
  if (modules) return modules;
  const from = (name) => import(pathToFileURL(path.join(ROOT, 'src', name)).href);
  const [config, server, settings, notifier, telegram] = await Promise.all([
    from('config.mjs'),
    from('server.mjs'),
    from('settings.mjs'),
    from('notifier.mjs'),
    from('telegram.mjs'),
  ]);
  modules = { config, server, settings, notifier, telegram };
  return modules;
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function readSettings() {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return modules.settings.readSettingsSection((key) => configuration.get(key));
}

/**
 * A Telegram secret token must be `A-Za-z0-9_-`. Generating one on first run
 * removes the most common setup failure without hiding the value from the user.
 *
 * Only needed in webhook mode: polling does not use the header.
 */
async function ensureSecretToken(settings) {
  if (settings.webhookEnabled === false) return settings.webhookSecretToken ?? '';
  if (settings.webhookSecretToken && /^[A-Za-z0-9_-]{8,256}$/.test(settings.webhookSecretToken)) {
    return settings.webhookSecretToken;
  }
  const generated = randomBytes(24).toString('base64url');
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('webhookSecretToken', generated, vscode.ConfigurationTarget.Global);
  log('generated a new webhook secret token');
  return generated;
}

async function buildConfig() {
  const settings = readSettings();
  settings.webhookSecretToken = await ensureSecretToken(settings);
  const raw = modules.settings.configFromSettings(settings);
  return modules.config.normalizeConfig(raw, { env: process.env, sourcePath: settingsFileLabel() });
}

/**
 * VS Code is the config store: the section in settings.json is the single source
 * of truth, and the hooks read that file directly. Nothing is written here.
 */
function settingsFileLabel() {
  return modules.config.vscodeSettingsPath() || '(VS Code settings, not found on disk yet)';
}

async function startBridge({ silent = false } = {}) {
  if (starting) return starting;
  if (bridge) return bridge;

  starting = (async () => {
    const { config, server, notifier } = await loadModules();
    const runtime = await buildConfig();

    const problems = config.validateConfig(runtime);
    if (problems.length) {
      log(`configuration problems:\n  - ${problems.join('\n  - ')}`);
      if (!silent) {
        vscode.window
          .showWarningMessage(
            `TelegramNotify: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}. Open settings to finish setup.`,
            'Open Settings',
          )
          .then((choice) => {
            if (choice === 'Open Settings') openSettings();
          });
      }
      return null;
    }

    const instance = new notifier.Notifier(runtime);
    const started = await server.startServer(runtime, { notifier: instance });

    bridge = started;
    setStatus(true, runtime);
    log(
      `bridge listening on ${runtime.webhookHost}:${started.address.port} — ` +
        (started.polling?.active ? 'polling mode (webhook off)' : 'webhook mode'),
    );
    if (!silent) {
      vscode.window.showInformationMessage(
        started.polling?.active
          ? `TelegramNotify is listening on port ${started.address.port} and polling Telegram (webhook off).`
          : `TelegramNotify is listening on port ${started.address.port}.`,
      );
    }

    // Polling took the bot over already, so registering a webhook would break it.
    if (runtime.webhookEnabled === true && runtime.publicUrl) await applyWebhook(runtime);
    return started;
  })()
    .catch((err) => {
      log(`could not start the bridge: ${err.stack || err.message}`);
      if (!silent) vscode.window.showErrorMessage(`TelegramNotify could not start: ${err.message}`);
      return null;
    })
    .finally(() => {
      starting = null;
    });

  return starting;
}

/**
 * Registers the webhook when a public URL is configured. A failure here is
 * logged, not thrown: the bridge stays usable for local notifications.
 *
 * @param {import('./src/config.mjs').RuntimeConfig} runtime
 */
async function applyWebhook(runtime) {
  try {
    const { TelegramClient } = await loadModules().then((loaded) => loaded.telegram);
    const { webhookUrl } = await loadModules().then((loaded) => loaded.config);
    const url = webhookUrl(runtime);
    const info = await new TelegramClient(runtime).setWebhook({
      url,
      secretToken: runtime.webhookSecretToken,
    });
    log(`webhook registered: ${info.url}`);
    await warnIfWebhookUnreachable(url);
    return info;
  } catch (err) {
    log(`webhook registration failed: ${err.message}`);
    return null;
  }
}

/**
 * Registering a URL proves nothing: if the nginx site is missing, Telegram only
 * reports it after the first real message. A harmless GET fails fast — the
 * bridge answers 405, so 404 means the site is not deployed.
 *
 * @param {string} url
 */
async function warnIfWebhookUnreachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (response.status === 405 || response.status === 401) return true;

    const reason =
      response.status === 404
        ? 'the nginx site is not deployed for this host name'
        : response.status === 502 || response.status === 504
          ? 'nginx cannot reach the bridge'
          : `unexpected status ${response.status}`;
    log(`webhook URL check failed: ${response.status} — ${reason}`);
    vscode.window
      .showWarningMessage(`TelegramNotify: Telegram cannot reach ${url} (${response.status}: ${reason}).`, 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') output.show(true);
      });
    return false;
  } catch (err) {
    log(`webhook URL is unreachable: ${err.message}`);
    return false;
  }
}

async function stopBridge({ silent = false } = {}) {
  if (!bridge || stopping) return;
  stopping = true;
  try {
    await modules.server.closeServer(bridge.server, bridge.notifier, bridge.polling);
    log('bridge stopped');
    if (!silent) vscode.window.showInformationMessage('TelegramNotify stopped.');
  } finally {
    bridge = null;
    stopping = false;
    refreshStatus();
  }
}

function setStatus(running, config) {
  if (!statusItem) return;
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const enabled = configuration.get('notificationsEnabled') !== false;
  const webhook = configuration.get('webhookEnabled') !== false;

  const lines = [];
  if (running && config) {
    lines.push(`Bridge running on port ${config.webhookPort} — ${webhook ? 'webhook mode' : 'polling mode'}.`);
  } else {
    lines.push('Bridge is stopped.');
  }
  lines.push(`Notifications are ${enabled ? 'ON' : 'OFF'}; delivery by ${webhook ? 'webhook' : 'long polling'}.`);
  lines.push(enabled ? 'Click to turn notifications off.' : 'Click to turn notifications on.');

  statusItem.text = `${enabled ? '$(bell)' : '$(bell-slash)'} TG`;
  statusItem.tooltip = lines.join('\n');
  statusItem.backgroundColor = undefined;
  statusItem.show();
}

function refreshStatus() {
  setStatus(Boolean(bridge), bridge?.notifier?.config);
}

/**
 * Writes one setting, skipping the write when it already holds the value.
 *
 * @param {string} key
 * @param {unknown} value
 */
async function updateSetting(key, value) {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  if (configuration.get(key) === value) return false;
  await configuration.update(key, value, vscode.ConfigurationTarget.Global);
  log(`${key} = ${JSON.stringify(value)}`);
  return true;
}

/**
 * Status bar click: turn notifications on or off, and save the switch.
 *
 * The bridge keeps running so answers still arrive while notifications are off
 * — only sending stops. Serialized so a double click runs one toggle.
 */
function toggleNotifications() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_GUARD_MS) {
    log('second click collapsed into the first toggle');
    return toggleQueue;
  }
  lastToggleAt = now;

  toggleQueue = toggleQueue.then(performToggle).catch((err) => {
    log(`toggle failed: ${err.stack || err.message}`);
    vscode.window.showErrorMessage(`TelegramNotify: ${err.message}`);
  });
  return toggleQueue;
}

async function performToggle() {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const next = configuration.get('notificationsEnabled') === false;
  await updateSetting('notificationsEnabled', next);

  // Off means nothing runs: no sending and no Telegram round trips. On starts
  // the bridge in whichever delivery mode the webhook switch selects.
  if (next) await startBridge({ silent: true });
  else await stopBridge({ silent: true });

  log(`notifications ${next ? 'enabled' : 'disabled'}`);
  refreshStatus();
}

function openSettings() {
  const id = context?.extension?.id ?? 'local.telegram-notify';
  return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${id} telegramNotify`);
}

async function showStatus() {
  const pending = bridge ? bridge.notifier.pending.list() : [];
  const config = bridge ? bridge.notifier.config : null;
  const lines = [
    `${bridge ? `Bridge: running on ${config?.webhookPort} (${config?.webhookEnabled === false ? 'polling' : 'webhook'})` : 'Bridge: stopped'}`,
    `Notifications: ${vscode.workspace.getConfiguration(SECTION).get('notificationsEnabled') !== false ? 'on' : 'off'}`,
    `Webhook: ${vscode.workspace.getConfiguration(SECTION).get('webhookEnabled') !== false ? 'on' : 'off (polling)'}`,
    `Agents: ${Object.entries(config?.agents ?? {}).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(' ')}`,
    `Pending: ${pending.length}`,
    `Config: ${settingsFileLabel()}`,
  ].filter(Boolean);

  const choice = await vscode.window.showQuickPick(
    [
      ...lines.map((line) => ({ label: line, kind: vscode.QuickPickItemKind.Default })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...pending.map((item) => ({ label: `${item.id} · ${item.agent} · ${item.type}`, description: `${item.expiresInSeconds}s left` })),
    ],
    { title: 'TelegramNotify', placeHolder: 'Bridge status' },
  );
  if (choice && /^(?<id>[0-9a-f]{8}) ·/.test(choice.label)) {
    const id = /^(?<id>[0-9a-f]{8}) ·/.exec(choice.label).groups.id;
    bridge?.notifier.cancel(id);
    log(`cancelled ${id}`);
  }
}

async function installHooks() {
  const scope = await vscode.window.showQuickPick(
    [
      { label: 'This project', description: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no folder open', target: 'project' },
      { label: 'User settings', description: 'Copilot, Claude Code and OpenCode', target: 'global' },
    ],
    { title: 'Install TelegramNotify hooks' },
  );
  if (!scope) return;

  const root = scope.target === 'global' ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (scope.target === 'project' && !root) {
    vscode.window.showErrorMessage('Open a folder first, or install into user settings.');
    return;
  }

  const agents = await vscode.window.showQuickPick(
    [
      { label: 'All agents', picked: true, value: 'all' },
      { label: 'Claude Code', picked: true, value: 'claude' },
      { label: 'GitHub Copilot', picked: true, value: 'copilot' },
      { label: 'OpenCode', picked: true, value: 'opencode' },
    ],
    { title: 'Agents to hook', canPickMany: true },
  );
  if (!agents?.length) return;

  const approvals = await vscode.window.showQuickPick(
    [
      { label: 'Notifications only', description: 'No blocking tool prompts', value: false },
      { label: 'Also answer Copilot tool permissions', description: 'Every tool call waits for Telegram', value: true },
    ],
    { title: 'Copilot approvals' },
  );
  if (!approvals) return;

  try {
    const installer = await import(pathToFileURL(path.join(ROOT, 'src', 'install.mjs')).href);
    const selected = agents.some((item) => item.value === 'all') ? ['copilot', 'claude', 'opencode'] : agents.map((item) => item.value);
    if (!selected.length) {
      vscode.window.showWarningMessage('Nothing to install.');
      return;
    }

    const files = [];
    for (const agent of selected) {
      const result = installer.install(root ?? process.cwd(), {
        agent,
        global: scope.target === 'global',
        approvals: Boolean(approvals.value),
      });
      files.push(...result.files);
    }
    for (const file of files) log(`installed ${file}`);
    vscode.window
      .showInformationMessage(
        `Hooks installed (${files.length} files). Restart ${['Claude Code', 'Copilot', 'OpenCode'].join(', ')} to pick them up.`,
        'Show Files',
      )
      .then((choice) => {
        if (choice === 'Show Files') log(files.join('\n'));
      });
  } catch (err) {
    log(`install failed: ${err.stack || err.message}`);
    vscode.window.showErrorMessage(`TelegramNotify could not install hooks: ${err.message}`);
  }
}

async function sendTest() {
  if (!bridge) {
    vscode.window.showWarningMessage('Start TelegramNotify first.');
    return;
  }
  const text = await vscode.window.showInputBox({
    title: 'Send a Telegram message',
    prompt: 'Message text',
    value: 'TelegramNotify test message',
    ignoreFocusOut: true,
  });
  if (!text) return;
  const result = await bridge.notifier.notify({ type: 'info', agent: 'vscode', message: text, title: 'VS Code test' });
  if (result.ok) vscode.window.showInformationMessage('Sent.');
  else vscode.window.showErrorMessage(`Not sent: ${result.reason || result.error}`);
}

async function registerWebhook() {
  const config = bridge?.notifier.config ?? (await buildConfig());
  const target = await vscode.window.showInputBox({
    title: 'Register the Telegram webhook',
    prompt: 'Public HTTPS base URL (tunnel host). Leave empty to use publicUrl from settings.',
    value: config.publicUrl || '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value) return null;
      try {
        return new URL(value).protocol === 'https:' ? null : 'Telegram only calls HTTPS webhooks.';
      } catch {
        return 'Enter an absolute https:// URL.';
      }
    },
  });
  if (target === undefined) return;

  try {
    const { TelegramClient } = await loadModules().then((m) => m.telegram);
    const client = new TelegramClient(config);
    const url = target ? `${target.replace(/\/+$/, '')}${config.webhookPath}` : modules.config.webhookUrl(config);
    if (!url) {
      vscode.window.showErrorMessage('Set publicUrl in settings, or enter a URL here.');
      return;
    }
    const info = await client.setWebhook({ url, secretToken: config.webhookSecretToken });
    log(`webhook registered: ${info.url}`);
    const reachable = await warnIfWebhookUnreachable(info.url || url);
    if (reachable) vscode.window.showInformationMessage(`Webhook registered: ${info.url}`);
  } catch (err) {
    log(`webhook registration failed: ${err.message}`);
    vscode.window.showErrorMessage(`Could not register the webhook: ${err.message}`);
  }
}

/**
 * @param {vscode.ExtensionContext} ctx
 */
function activate(ctx) {
  context = ctx;
  output = vscode.window.createOutputChannel('TelegramNotify');
  ctx.subscriptions.push(output);

  const logLevel = vscode.workspace.getConfiguration(SECTION).get('logLevel');
  if (logLevel) process.env.TELEGRAM_NOTIFY_LOG_LEVEL = String(logLevel);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  // Clicking the icon toggles notifications; a double click runs one toggle.
  statusItem.command = 'telegramNotify.toggle';
  ctx.subscriptions.push(statusItem);
  setStatus(false);

  const register = (id, handler) => ctx.subscriptions.push(vscode.commands.registerCommand(id, handler));
  register('telegramNotify.toggle', () => toggleNotifications());
  register('telegramNotify.start', () => startBridge({ silent: true }));
  register('telegramNotify.stop', () => stopBridge({ silent: true }));
  register('telegramNotify.restart', async () => {
    await stopBridge({ silent: true });
    await startBridge();
  });
  register('telegramNotify.showStatus', showStatus);
  register('telegramNotify.openSettings', () => openSettings());
  register('telegramNotify.sendTest', sendTest);
  register('telegramNotify.installHooks', installHooks);
  register('telegramNotify.registerWebhook', registerWebhook);
  register('telegramNotify.showLog', () => output.show(true));

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(SECTION)) return;

      if (event.affectsConfiguration(`${SECTION}.logLevel`)) {
        const level = vscode.workspace.getConfiguration(SECTION).get('logLevel');
        if (level) process.env.TELEGRAM_NOTIFY_LOG_LEVEL = String(level);
      }

      // "Enable Webhook" is the bridge's power switch: on starts it, off stops
      // it and hands delivery to long polling.
      if (event.affectsConfiguration(`${SECTION}.webhookEnabled`)) {
        const wantsWebhook = vscode.workspace.getConfiguration(SECTION).get('webhookEnabled') !== false;
        log(`webhook ${wantsWebhook ? 'enabled' : 'disabled'}`);
        await stopBridge({ silent: true });
        await startBridge({ silent: true });
        refreshStatus();
        return;
      }

      const bridgeChanged = BRIDGE_SETTING_KEYS.some((key) => event.affectsConfiguration(`${SECTION}.${key}`));
      if (!bridgeChanged) {
        // notificationsEnabled and logLevel are handled here or by the toggle
        // itself; restarting on their write would undo it.
        log('setting change does not affect a running bridge');
        refreshStatus();
        return;
      }

      log('settings changed');
      if (!bridge && !starting) return;
      await stopBridge({ silent: true });
      await startBridge({ silent: true });
    }),
  );

  loadModules()
    .catch((err) => {
      log(`failed to load the bridge modules: ${err.message}`);
      return null;
    })
    .then(async () => {
      if (!modules) return;
      await buildConfig().catch((err) => log(`config read failed: ${err.message}`));
      const configuration = vscode.workspace.getConfiguration(SECTION);
      if (configuration.get('notificationsEnabled') === false) {
        log('notifications are disabled; click the TG icon or use "TelegramNotify: Start Bridge"');
        refreshStatus();
        return;
      }
      await startBridge({ silent: true });
    });

  return { start: () => startBridge(), stop: () => stopBridge(), toggle: () => toggleNotifications() };
}

async function deactivate() {
  await stopBridge({ silent: true });
}

module.exports = { activate, deactivate };
