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

  const notify = [{ hooks: [{ type: 'command', command, timeout: 20, async: true }] }];

  // Older versions asked permissions in Telegram from this hook. Nothing may block
  // the prompt Claude Code shows now, so the entry is removed on every install.
  removeEvent(settings.hooks, 'PermissionRequest');
  replaceEvent(settings.hooks, 'PreToolUse', [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, timeout }] }]);
  replaceEvent(settings.hooks, 'UserPromptSubmit', notify);
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

/**
 * Removes the entries this installer wrote for an event, leaving anyone else's.
 */
function removeEvent(hooks, eventName) {
  if (!Array.isArray(hooks[eventName])) return;
  const kept = hooks[eventName].filter((entry) => !isOurEntry(entry));
  if (kept.length) hooks[eventName] = kept;
  else delete hooks[eventName];
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
 * No permission hook is installed: `permissionRequest` runs before Copilot decides
 * whether to ask, so it cannot tell an auto-approved call from a prompt. The
 * agent host's event log is watched instead (src/copilot-events.mjs).
 *
 * @param {string} root
 * @param {{ global?: boolean }} [options]
 */
export function installCopilot(root, options = {}) {
  const script = hookScript('copilot-hook.mjs');
  // Only events the Copilot runtime knows: agentStop is the end of a turn,
  // sessionEnd closes the session, and taskComplete is not a supported event.
  const hooks = {
    userPromptSubmitted: [copilotHook(script, 20, 'userPromptSubmitted')],
    sessionEnd: [copilotHook(script, 20, 'sessionEnd')],
    agentStop: [copilotHook(script, 20, 'agentStop')],
    errorOccurred: [copilotHook(script, 20, 'errorOccurred')],
  };

  const file = options.global
    ? path.join(os.homedir(), '.copilot', 'hooks', 'telegram-notify.json')
    : path.join(root, '.github', 'hooks', 'telegram-notify.json');
  writeJson(file, { version: 1, hooks });
  return {
    files: [file],
    notes: [
      'Permission requests and questions are reported from Copilot\'s own event log; no blocking hook is installed.',
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
 * OpenCode needs no install step.
 *
 * OpenCode 2.x loads a plugin only from a *directory*, its `event.subscribe()`
 * returns an Effect stream that plain JavaScript cannot iterate, and
 * `session.hook()` handlers never fired — so a plugin cannot report turns any
 * more. The bridge watches OpenCode's own HTTP API instead and sends a Telegram
 * prompt to its server, with `opencode run` as the fallback (see
 * src/opencode-log.mjs).
 *
 * @param {string} root
 * @param {{ global?: boolean }} [options]
 */
export function installOpencode(root, options = {}) {
  return {
    files: [],
    notes: [
      'OpenCode needs no files: TelegramNotify watches its HTTP API for finished turns, and sends prompts to that server ("opencode run" when it is not running).',
      options.global ? 'Nothing was written to ~/.config/opencode.' : 'Nothing was written to this project.',
      'A plugin entry left by an older version is removed automatically when the extension starts.',
    ],
  };
}

/**
 * @param {string} root
 * @param {{ agent?: string, global?: boolean }} options
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

function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2).replace(/\n/g, '\r\n')}\r\n`);
}

function writeText(file, text) {
  const normalized = text.replace(/\r?\n/g, '\r\n');
  try {
    if (fs.readFileSync(file, 'utf8') === normalized) {
      // Re-installing on every start must not churn the user's files.
      log.debug(`${file} is already up to date`);
      return;
    }
  } catch {
    /* not written yet */
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, normalized, 'utf8');
  log.info(`wrote ${file}`);
}

/**
 * Whether an agent is present on this machine, which decides if its hooks are
 * worth installing automatically. Each agent keeps a folder in the home
 * directory, so a plain existence check is enough.
 *
 * @param {'copilot'|'claude'|'opencode'} agent
 * @returns {boolean}
 */
export function isAgentInstalled(agent) {
  const home = os.homedir();
  const exists = (candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  };

  if (agent === 'claude') return exists(path.join(home, '.claude'));
  if (agent === 'copilot') return exists(path.join(home, '.copilot'));
  if (agent === 'opencode') {
    return exists(path.join(home, '.config', 'opencode')) || exists(path.join(home, '.opencode'));
  }
  return false;
}
