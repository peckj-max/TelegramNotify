import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, loadConfig } from './config.mjs';
import { log } from './logger.mjs';

const MARKER = 'TelegramNotify';
const HOOK_TIMEOUT_MARGIN = 60;

function hookScript(name) {
  return path.join(PACKAGE_ROOT, 'src', 'hooks', name);
}

function quote(value) {
  return `"${value}"`;
}

/**
 * Returns a Node executable the hook process can actually run.
 *
 * When the installer runs inside the VS Code extension host, `process.execPath`
 * is Code.exe, and `Code.exe hook.mjs` would open the file in the editor instead
 * of executing it. Prefer a real node from PATH in that case, then fall back to
 * the Electron binary with ELECTRON_RUN_AS_NODE.
 */
function resolveNode() {
  const execPath = process.execPath;
  if (path.basename(execPath).toLowerCase().replace(/\.exe$/, '') === 'node') {
    return { executable: execPath, env: undefined };
  }

  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return { executable: candidate, env: undefined };
    } catch {
      /* not here */
    }
  }

  return { executable: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function nodeCommand(script) {
  // The agent inherits an environment that may not have Node on PATH, so pin
  // the interpreter found by the installer. Bash accepts a quoted command in
  // command position; PowerShell needs the call operator.
  return `${quote(resolveNode().executable)} ${quote(script)}`;
}

function powershellCommand(script) {
  return `& ${nodeCommand(script)}`;
}

function posixPath(value) {
  return value.replace(/\\/g, '/');
}

/**
 * @param {string} root
 * @param {{ global?: boolean }} [options]
 */
export function installClaude(root, options = {}) {
  const timeout = hookTimeoutFor();
  const command = nodeCommand(hookScript('claude-hook.mjs'));
  const file = options.global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(root, '.claude', 'settings.json');

  const settings = readJson(file) ?? {};
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

  const blocking = [{ hooks: [{ type: 'command', command, timeout }] }];
  const notify = [{ hooks: [{ type: 'command', command, timeout: 20, async: true }] }];

  replaceEvent(settings.hooks, 'PermissionRequest', blocking);
  replaceEvent(settings.hooks, 'PreToolUse', [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, timeout }] }]);
  replaceEvent(settings.hooks, 'Notification', notify);
  replaceEvent(settings.hooks, 'Stop', notify);
  replaceEvent(settings.hooks, 'SubagentStop', notify);
  replaceEvent(settings.hooks, 'TaskCompleted', notify);

  writeJson(file, settings);
  return { files: [file], notes: ['Restart Claude Code (or start a new session) so the hooks are reloaded.'] };
}

/**
 * Removes our entries for an event before adding the fresh ones, so running the
 * installer twice updates the command instead of stacking another hook.
 */
function replaceEvent(hooks, eventName, entries) {
  const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  hooks[eventName] = [...existing.filter((entry) => !isOurEntry(entry)), ...entries];
}

function isOurEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (Array.isArray(entry.hooks)) return entry.hooks.some((hook) => String(hook?.command || '').includes(MARKER));
  return String(entry.command || '').includes(MARKER);
}

function hookTimeoutFor() {
  try {
    return loadConfig({ allowPartial: true }).replyTimeoutSeconds + HOOK_TIMEOUT_MARGIN;
  } catch {
    return 900;
  }
}

/**
 * GitHub Copilot CLI hook config: .github/hooks/<name>.json
 *
 * @param {string} root
 * @param {{ approvals?: boolean }} [options]
 */
export function installCopilot(root, options = {}) {
  const script = hookScript('copilot-hook.mjs');
  const timeoutSec = hookTimeoutFor();
  // Only events the Copilot runtime knows: agentStop is the end of a turn,
  // sessionEnd closes the session, and taskComplete is not a supported event.
  const hooks = {
    sessionEnd: [copilotHook(script, 20, 'sessionEnd')],
    agentStop: [copilotHook(script, 20, 'agentStop')],
    errorOccurred: [copilotHook(script, 20, 'errorOccurred')],
  };
  if (options.approvals) {
    hooks.preToolUse = [copilotHook(script, timeoutSec, 'preToolUse')];
  }

  const file = options.global
    ? path.join(os.homedir(), '.copilot', 'hooks', 'telegram-notify.json')
    : path.join(root, '.github', 'hooks', 'telegram-notify.json');
  writeJson(file, { version: 1, hooks });
  return {
    files: [file],
    notes: [
      options.approvals
        ? 'preToolUse approvals are enabled: every tool call waits for a Telegram answer (or the timeout).'
        : 'Approvals are off; notifications only. Re-run with --approvals to answer tool permissions from Telegram.',
      'Copilot reads hooks when a session starts; start a new chat so they reload.',
    ],
  };
}

function copilotHook(script, timeoutSec, eventName) {
  const node = resolveNode();
  return {
    type: 'command',
    // The event name travels as an argument: VS Code's agent host sends no
    // event field on stdin, so the hook cannot infer it from the payload alone.
    bash: `${quote(posixPath(node.executable))} ${quote(posixPath(script))} ${eventName}`,
    powershell: `${powershellCommand(script)} ${eventName}`,
    ...(node.env ? { env: node.env } : {}),
    timeoutSec,
  };
}

/**
 * OpenCode plugin: a re-export stub next to the project plus the plugin entry in
 * opencode.json. The stub keeps the absolute path of this installation in one
 * place, so the source can be moved or updated without touching the project.
 *
 * @param {string} root
 * @param {{ global?: boolean }} [options]
 */
export function installOpencode(root, options = {}) {
  const pluginSource = pathToFileURL(hookScript('opencode-plugin.mjs')).href;
  const stubDir = options.global
    ? path.join(os.homedir(), '.config', 'opencode', 'plugin')
    : path.join(root, '.opencode');
  const stubFile = path.join(stubDir, 'telegram-notify.mjs');
  const stub = [
    '// Generated by TelegramNotify. Re-run "telegram-notify install --agent opencode" after moving the extension.',
    `export { TelegramNotify as default, TelegramNotify } from ${JSON.stringify(pluginSource)};`,
    '',
  ].join('\r\n');
  writeText(stubFile, stub);

  const configFile = options.global
    ? path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
    : path.join(root, 'opencode.json');
  const pluginRef = options.global
    ? pathToFileURL(stubFile).href
    : `./${posixPath(path.relative(root, stubFile))}`;

  const config = readJsonc(configFile) ?? {};
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (!plugins.some((entry) => String(entry).includes('telegram-notify'))) plugins.push(pluginRef);
  config.plugin = plugins;

  writeJson(configFile, config);
  return {
    files: [stubFile, configFile],
    notes: ['Restart OpenCode so the plugin loads. OpenCode plugins run inside the agent process, so the bridge must be running.'],
  };
}

/**
 * @param {string} root
 * @param {{ agent?: string, global?: boolean, approvals?: boolean }} options
 */
export function install(root, options = {}) {
  const agent = options.agent || 'all';
  const targets = agent === 'all' ? ['copilot', 'claude', 'opencode'] : [agent];
  const files = [];
  const notes = [];

  for (const target of targets) {
    if (target === 'claude') {
      const result = installClaude(root, options);
      files.push(...result.files);
      notes.push(...result.notes);
    } else if (target === 'copilot') {
      const result = installCopilot(root, options);
      files.push(...result.files);
      notes.push(...result.notes);
    } else if (target === 'opencode') {
      const result = installOpencode(root, options);
      files.push(...result.files);
      notes.push(...result.notes);
    } else {
      throw new Error(`unknown agent "${target}"`);
    }
  }

  return { files, notes };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it before installing`);
  }
}

/** opencode.json allows comments; strip them before parsing. */
function readJsonc(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
  if (!withoutComments) return null;
  try {
    return JSON.parse(withoutComments);
  } catch (err) {
    log.warn(`could not parse ${file} (${err.message}); writing a fresh file`);
    return null;
  }
}

function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2).replace(/\n/g, '\r\n')}\r\n`);
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text.replace(/\r?\n/g, '\r\n'), 'utf8');
  log.info(`wrote ${file}`);
}
