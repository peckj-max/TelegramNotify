import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.mjs';
import { ALL_SETTINGS } from './settings.mjs';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const AGENTS = /** @type {const} */ (['copilot', 'claude', 'opencode']);

export const DEFAULTS = {
  webhookHost: '0.0.0.0',
  webhookPort: 8787,
  webhookPath: '/telegram/webhook',
  publicUrl: '',
  notificationsEnabled: true,
  webhookEnabled: true,
  pollingTimeoutSeconds: 25,
  replyTimeoutSeconds: 900,
  notifyOnCompleted: true,
  notifyOnStart: false,
  maxMessageLength: 3800,
  remotePromptEnabled: false,
  claudeOpenSession: true,
  // Seconds a permission/question waits in Telegram before it is handed to the
  // prompt the editor or terminal shows. 0 turns the Telegram step off. Despite
  // the name it governs every agent; it began as a Claude-only switch.
  claudeAskWindowSeconds: 20,
  // Seconds a permission or question may sit in the panel before Telegram is told.
  // Unlike the ask window above this never blocks: the agent's own prompt owns the
  // request, and the event log only says whether it is still waiting.
  panelWaitSeconds: 20,
  // Seconds a completion is held when its turn stopped without reporting a result.
  // The Copilot agent host nudges such a turn to continue, and that nudge drops the
  // held message instead of Telegram showing an answer that is immediately overtaken.
  completionHoldSeconds: 15,
};

/**
 * @typedef {object} RuntimeConfig
 * @property {string} botToken
 * @property {string[]} chatIds
 * @property {boolean} notificationsEnabled
 * @property {Record<'copilot'|'claude'|'opencode', boolean>} agents
 * @property {boolean} webhookEnabled
 * @property {number} webhookPort
 * @property {string} webhookHost
 * @property {string} webhookPath
 * @property {string} webhookSecretToken
 * @property {string} publicUrl
 * @property {number} pollingTimeoutSeconds
 * @property {number} replyTimeoutSeconds
 * @property {boolean} notifyOnCompleted
 * @property {boolean} notifyOnStart
 * @property {number} maxMessageLength
 * @property {boolean} remotePromptEnabled
 * @property {boolean} claudeOpenSession
 * @property {number} claudeAskWindowSeconds
 * @property {number} panelWaitSeconds
 * @property {number} completionHoldSeconds
 * @property {string|null} sourcePath
 */

export function legacyConfigPath() {
  return path.join(process.env.APPDATA || os.homedir(), 'Code', 'User', 'telegram-notify.json');
}

/**
 * VS Code's user settings file — the source of truth for the settings UI. Hooks
 * are spawned by the agent CLIs, not by VS Code, so they read this file to learn
 * the bridge port and timeouts. That is why no separate config file is needed.
 *
 * @returns {string[]} candidates, most specific first
 */
export function vscodeSettingsPaths() {
  if (process.env.TELEGRAM_NOTIFY_SETTINGS) return [path.resolve(process.env.TELEGRAM_NOTIFY_SETTINGS)];

  const home = os.homedir();
  const appData = process.env.APPDATA;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');

  if (process.platform === 'win32') {
    return [
      // Stable
      path.join(appData || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json'),
      // Insiders and other builds
      path.join(appData || path.join(home, 'AppData', 'Roaming'), 'Code - Insiders', 'User', 'settings.json'),
      path.join(appData || path.join(home, 'AppData', 'Roaming'), 'VSCodium', 'User', 'settings.json'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
      path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'settings.json'),
    ];
  }
  return [
    path.join(configHome, 'Code', 'User', 'settings.json'),
    path.join(configHome, 'Code - Insiders', 'User', 'settings.json'),
    path.join(configHome, 'VSCodium', 'User', 'settings.json'),
  ];
}

/**
 * @returns {string|null} the first VS Code settings file that exists
 */
export function vscodeSettingsPath() {
  for (const candidate of vscodeSettingsPaths()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Where user data lives. This must never be the extension folder: the extension
 * is often linked straight to a source checkout, and a config file there would
 * put the bot token in a repository.
 *
 * @returns {string}
 */
export function userConfigDir() {
  if (process.env.TELEGRAM_NOTIFY_HOME) return path.resolve(process.env.TELEGRAM_NOTIFY_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TelegramNotify');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TelegramNotify');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'telegram-notify');
}

/**
 * @returns {string}
 */
export function userConfigPath() {
  return path.join(userConfigDir(), 'config.json');
}

/**
 * The file the extension writes. An explicit path still wins, so `--config` and
 * `TELEGRAM_NOTIFY_CONFIG` behave as before.
 *
 * @param {string} [explicitPath]
 * @returns {string}
 */
export function configFilePath(explicitPath) {
  const explicit = explicitPath || process.env.TELEGRAM_NOTIFY_CONFIG;
  return explicit ? path.resolve(explicit) : userConfigPath();
}

/**
 * First readable standalone config file wins. An explicit path is authoritative:
 * when it does not exist the caller gets null instead of a surprising fallback.
 *
 * Only user-data locations are consulted, so a file in a source checkout is
 * never picked up.
 *
 * @param {string|undefined} explicitPath
 * @returns {string|null}
 */
export function resolveConfigPath(explicitPath) {
  const explicit = explicitPath || process.env.TELEGRAM_NOTIFY_CONFIG;
  const candidates = explicit ? [path.resolve(explicit)] : [userConfigPath(), legacyConfigPath()];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

function readFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError([`${file} is not valid JSON (${err.message})`]);
  }
}

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** Like `asPositiveInt`, but 0 is a value of its own ("off"), not a fallback. */
function asNonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function splitChatIds(value) {
  if (Array.isArray(value)) return value.map((id) => String(id).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function joinUrl(base, webhookPath) {
  if (!base) return '';
  const trimmed = String(base).trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith(webhookPath)) return trimmed;
  return `${trimmed}${webhookPath}`;
}

/**
 * @param {Record<string, any>} raw
 * @param {{ env?: Record<string, string|undefined>, sourcePath?: string|null }} [options]
 * @returns {RuntimeConfig}
 */
export function normalizeConfig(raw, options = {}) {
  const env = options.env ?? process.env;
  const agentsInput = raw.agents && typeof raw.agents === 'object' ? raw.agents : {};

  const config = {
    botToken: String(env.TELEGRAM_NOTIFY_BOT_TOKEN || raw.botToken || '').trim(),
    chatIds: splitChatIds(env.TELEGRAM_NOTIFY_CHAT_ID || raw.chatId || raw.chatIds),
    notificationsEnabled: asBoolean(
      env.TELEGRAM_NOTIFY_NOTIFICATIONS_ENABLED ?? raw.notificationsEnabled,
      DEFAULTS.notificationsEnabled,
    ),
    agents: {
      copilot: asBoolean(env.TELEGRAM_NOTIFY_AGENT_COPILOT ?? agentsInput.copilot, true),
      claude: asBoolean(env.TELEGRAM_NOTIFY_AGENT_CLAUDE ?? agentsInput.claude, true),
      opencode: asBoolean(env.TELEGRAM_NOTIFY_AGENT_OPENCODE ?? agentsInput.opencode, true),
    },
    webhookEnabled: asBoolean(env.TELEGRAM_NOTIFY_WEBHOOK_ENABLED ?? raw.webhookEnabled, DEFAULTS.webhookEnabled),
    webhookPort: asPositiveInt(env.TELEGRAM_NOTIFY_WEBHOOK_PORT || raw.webhookPort, DEFAULTS.webhookPort),
    webhookHost: String(raw.webhookHost || DEFAULTS.webhookHost).trim(),
    webhookPath: normalizePath(raw.webhookPath),
    webhookSecretToken: String(env.TELEGRAM_NOTIFY_WEBHOOK_SECRET || raw.webhookSecretToken || '').trim(),
    publicUrl: String(raw.publicUrl || env.TELEGRAM_NOTIFY_PUBLIC_URL || '').trim(),
    pollingTimeoutSeconds: asPositiveInt(raw.pollingTimeoutSeconds, DEFAULTS.pollingTimeoutSeconds),
    replyTimeoutSeconds: asPositiveInt(raw.replyTimeoutSeconds, DEFAULTS.replyTimeoutSeconds),
    notifyOnCompleted: asBoolean(raw.notifyOnCompleted, DEFAULTS.notifyOnCompleted),
    notifyOnStart: asBoolean(env.TELEGRAM_NOTIFY_NOTIFY_ON_START ?? raw.notifyOnStart, DEFAULTS.notifyOnStart),
    maxMessageLength: asPositiveInt(raw.maxMessageLength, DEFAULTS.maxMessageLength),
    remotePromptEnabled: asBoolean(
      env.TELEGRAM_NOTIFY_REMOTE_PROMPT ?? raw.remotePromptEnabled,
      DEFAULTS.remotePromptEnabled,
    ),
    claudeOpenSession: asBoolean(
      env.TELEGRAM_NOTIFY_CLAUDE_OPEN_SESSION ?? raw.claudeOpenSession,
      DEFAULTS.claudeOpenSession,
    ),
    claudeAskWindowSeconds: asNonNegativeInt(
      env.TELEGRAM_NOTIFY_CLAUDE_ASK_WINDOW ?? raw.claudeAskWindowSeconds,
      DEFAULTS.claudeAskWindowSeconds,
    ),
    panelWaitSeconds: asNonNegativeInt(
      env.TELEGRAM_NOTIFY_PANEL_WAIT ?? raw.panelWaitSeconds,
      DEFAULTS.panelWaitSeconds,
    ),
    completionHoldSeconds: asNonNegativeInt(
      env.TELEGRAM_NOTIFY_COMPLETION_HOLD ?? raw.completionHoldSeconds,
      DEFAULTS.completionHoldSeconds,
    ),
    sourcePath: options.sourcePath ?? null,
  };

  return config;
}

function normalizePath(value) {
  const raw = String(value || DEFAULTS.webhookPath).trim();
  if (!raw) return DEFAULTS.webhookPath;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * @param {RuntimeConfig} config
 * @returns {string[]}
 */
export function validateConfig(config) {
  const problems = [];
  if (!config.botToken) problems.push('botToken is required (Telegram bot token from @BotFather)');
  else if (!/^\d+:[\w-]{20,}$/.test(config.botToken)) problems.push('botToken does not look like <bot id>:<token>');
  if (!config.chatIds.length) problems.push('chatId is required (numeric chat id that receives the notifications)');
  else if (config.chatIds.some((id) => !/^-?\d+$/.test(id))) problems.push('chatId must be numeric (a group id starts with -)');

  if (config.webhookEnabled) {
    if (!config.webhookSecretToken) {
      problems.push('webhookSecretToken is required (Telegram secret token, 1-256 chars of A-Z a-z 0-9 _ -)');
    } else if (!/^[A-Za-z0-9_-]{1,256}$/.test(config.webhookSecretToken)) {
      problems.push('webhookSecretToken may only contain A-Z a-z 0-9 _ - and must be at most 256 characters');
    }
    if (!Number.isInteger(config.webhookPort) || config.webhookPort < 1 || config.webhookPort > 65535) {
      problems.push('webhookPort must be a TCP port between 1 and 65535');
    }
  }
  if (config.publicUrl) normalizePublicUrl(config.publicUrl, problems);
  return problems;
}

function normalizePublicUrl(value, problems) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') problems.push('publicUrl must be https:// (Telegram only calls HTTPS webhooks)');
  } catch {
    problems.push('publicUrl must be an absolute https:// URL');
  }
}

/**
 * Loads the config and validates it. Commands that only inspect state pass
 * `allowPartial` so a half-configured install can still be diagnosed.
 *
 * Order: an explicit `--config` file, then VS Code's `settings.json` (so the
 * settings UI is the single source of truth), then a standalone config file in
 * the user data folder for CLI-only installs. Hooks run outside the editor and
 * rely on the same order.
 *
 * @param {{ configPath?: string, allowPartial?: boolean, env?: Record<string, string|undefined>, settingsPath?: string }} [options]
 * @returns {RuntimeConfig}
 */
export function loadConfig(options = {}) {
  const explicitPath = options.configPath || process.env.TELEGRAM_NOTIFY_CONFIG;

  if (explicitPath) {
    const file = resolveConfigPath(explicitPath);
    const raw = file ? readFile(file) : {};
    return finish(raw, { env: options.env, sourcePath: file, allowPartial: options.allowPartial });
  }

  const settingsFile = options.settingsPath || vscodeSettingsPath();
  const fromSettings = settingsFile ? readSettingsFile(settingsFile) : null;
  if (fromSettings) {
    return finish(fromSettings.raw, {
      env: options.env,
      sourcePath: fromSettings.file,
      allowPartial: options.allowPartial,
    });
  }

  const file = resolveConfigPath();
  const raw = file ? readFile(file) : {};
  return finish(raw, { env: options.env, sourcePath: file, allowPartial: options.allowPartial });
}

/**
 * @param {Record<string, any>} raw
 * @param {{ env?: any, sourcePath: string|null, allowPartial?: boolean }} options
 * @returns {RuntimeConfig}
 */
function finish(raw, options) {
  const config = normalizeConfig(raw, { env: options.env, sourcePath: options.sourcePath });
  if (!options.allowPartial) {
    const problems = validateConfig(config);
    if (problems.length) throw new ConfigError(problems);
  }
  return config;
}

/**
 * Reads the `telegramNotify` section out of a VS Code settings file. A malformed
 * file is not fatal here: hooks must never fail an agent over a JSON typo.
 *
 * @param {string} file
 * @returns {{ raw: Record<string, any>, file: string }|null}
 */
function readSettingsFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const document = parseJsonc(text);
    const raw = {};
    for (const key of ALL_SETTINGS) {
      const value = document[`telegramNotify.${key}`];
      if (value !== undefined) raw[key] = value;
    }
    // An empty section is not a usable configuration.
    if (!Object.keys(raw).length) return null;
    return { raw, file };
  } catch {
    return null;
  }
}

/**
 * VS Code tolerates comments and trailing commas in settings.json.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseJsonc(text) {
  const stripped = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

/**
 * Never throws. Hook processes use this so a broken config cannot fail an agent.
 *
 * @returns {RuntimeConfig}
 */
export function loadConfigForHooks() {
  try {
    return loadConfig({ allowPartial: true });
  } catch {
    return normalizeConfig({});
  }
}

/**
 * Persists a standalone config for a CLI-only install. Written to a temp file
 * first so a hook reading the same path never sees a partial file.
 *
 * @param {string} file
 * @param {Record<string, any>} contents
 */
export function writeConfigFile(file, contents) {
  const body = `${JSON.stringify(contents, null, 2).replace(/\n/g, '\r\n')}\r\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  // The file holds the bot token and webhook secret, so keep it owner-only.
  fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * @param {RuntimeConfig} config
 */
export function webhookUrl(config) {
  return joinUrl(config.publicUrl, config.webhookPath);
}

/**
 * @param {RuntimeConfig} config
 */
export function localApiUrl(config) {
  return process.env.TELEGRAM_NOTIFY_URL || `http://127.0.0.1:${config.webhookPort}`;
}

/**
 * @param {RuntimeConfig} config
 */
export function isAgentEnabled(config, agent) {
  return Boolean(config.agents[agent]);
}

/**
 * Masks secrets so the config can be printed or logged.
 *
 * @param {RuntimeConfig} config
 */
export function redactConfig(config) {
  const mask = (value) => (value ? `${String(value).slice(0, 4)}***` : '');
  const resolved = {
    ...config,
    agents: { ...config.agents },
    botToken: mask(config.botToken),
    webhookSecretToken: mask(config.webhookSecretToken),
    webhookUrl: webhookUrl(config),
    localApiUrl: localApiUrl(config),
  };
  delete resolved.sourcePath;
  return resolved;
}
