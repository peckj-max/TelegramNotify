/**
 * The rule a blocking hook uses for a question.
 *
 * Telegram asks first, and the prompt the user is looking at takes over when the
 * window closes:
 *
 *   - `ask`      TelegramNotify on and a window set: the chat gets tappable options
 *                and the hook waits up to the window. No answer means the hook
 *                hands the request back, so the agent asks in its own prompt and
 *                the bridge replaces the message with `⌛ no answer after Ns`.
 *   - `wait`     a run with no interface of its own (a Telegram prompt running
 *                headless): only the chat can answer, so it waits for the reply
 *                timeout instead of handing the request to nobody.
 *   - `handoff`  TelegramNotify off, or the window is 0: nothing is asked in the
 *                chat and the panel or terminal owns the request, which is also
 *                what happens when an `ask` window closes.
 *
 * Claude Code's `AskUserQuestion` is the hook that still uses this. Permissions do
 * not: Copilot and Claude Code report the prompt they already show (see
 * copilot-events.mjs and claude-hook.mjs), and OpenCode answers its own requests
 * over its HTTP API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * What to do with one pending permission, decision or question.
 *
 * @param {import('../config.mjs').RuntimeConfig} config
 * @param {{ headless?: boolean, automated?: boolean }} [options] whether the run
 *   has an interface of its own, and whether the agent's mode approves everything
 *   by itself
 * @returns {{ mode: 'ask'|'wait'|'handoff', seconds: number }} `seconds` is 0 for
 *   `handoff`, and for `wait`, which uses the reply timeout
 */
export function askPlan(config, options = {}) {
  if (options.headless) return { mode: 'wait', seconds: 0 };
  // A mode that approves on its own has nothing to ask about: the request would be
  // a message the chat has to answer for something that was never blocked.
  if (options.automated) return { mode: 'handoff', seconds: 0 };
  const window = askWindowSeconds(config);
  return window > 0 ? { mode: 'ask', seconds: window } : { mode: 'handoff', seconds: 0 };
}

/**
 * Modes in which the agent approves tool calls itself, so a permission request must
 * never reach the chat.
 *
 * The names are the agents' own: Copilot reports `autopilot` and an "allow all
 * permissions" switch in its session state, Claude Code records
 * `bypassPermissions` on every turn, and OpenCode simply does not create a
 * permission request in its autopilot mode.
 */
export const AUTOMATED_MODES = /** @type {const} */ ({
  copilot: ['autopilot'],
  claude: ['bypassPermissions'],
});

/**
 * The mode a Claude Code turn runs in.
 *
 * The hook payload carries it directly; a payload without it falls back to the
 * transcript, which records `"permissionMode"` on every user entry.
 *
 * @param {any} input the hook payload
 * @returns {string} '' when unknown
 */
export function claudePermissionMode(input = {}) {
  const direct = String(input.permission_mode || input.permissionMode || '').trim();
  if (direct) return direct;
  const transcript = String(input.transcript_path || input.transcriptPath || '').trim();
  if (!transcript) return '';
  try {
    const stat = fs.statSync(transcript);
    if (!stat.isFile() || stat.size === 0) return '';
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(transcript, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    const found = [...buffer.toString('utf8').matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
    return found.length ? found[found.length - 1][1] : '';
  } catch {
    return '';
  }
}

/**
 * Whether a Copilot session is in autopilot or has "allow all permissions" on.
 *
 * Copilot records both in its own session state — `session.mode_changed` and
 * `session.permissions_changed` in
 * `~/.copilot/session-state/<sessionId>/events.jsonl` — so the newest entry wins.
 *
 * @param {string} sessionId
 * @param {{ home?: string }} [options]
 * @returns {boolean}
 */
export function copilotAutomated(sessionId, options = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const root =
    options.home ||
    process.env.COPILOT_HOME ||
    process.env.TELEGRAM_NOTIFY_COPILOT_HOME ||
    path.join(os.homedir(), '.copilot');
  const file = path.join(root, 'session-state', id, 'events.jsonl');

  // The mode is set when the session starts, so a long session's changes are at the
  // beginning of the file, while a change made later is at the end. Both windows are
  // read, head first, so "the newest entry wins" still holds.
  const head = readWindow(file, 'head', 256 * 1024);
  const tail = readWindow(file, 'tail', 256 * 1024);
  if (!head && !tail) return false;

  let mode = '';
  let allowAll = false;
  for (const line of `${head}\n${tail}`.split('\n')) {
    if (!line.includes('session.')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'session.mode_changed' && event.data?.newMode) mode = String(event.data.newMode);
      if (event?.type === 'session.permissions_changed') {
        const data = event.data || {};
        if (typeof data.allowAllPermissions === 'boolean') allowAll = data.allowAllPermissions;
        else if (data.allowAllPermissionMode) allowAll = String(data.allowAllPermissionMode) === 'on';
      }
    } catch {
      /* a partial line at the edge of a window */
    }
  }
  return allowAll || AUTOMATED_MODES.copilot.includes(mode);
}

/**
 * Reads the first or last `length` bytes of a file.
 *
 * @param {string} file
 * @param {'head'|'tail'} where
 * @param {number} length
 * @returns {string} '' when the file cannot be read
 */
function readWindow(file, where, length) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return '';
    const size = Math.min(stat.size, length);
    const start = where === 'head' ? 0 : stat.size - size;
    const buffer = Buffer.allocUnsafe(size);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, size, start);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}


/**
 * How long the chat may hold a request before the agent's own prompt takes over.
 *
 * @param {import('../config.mjs').RuntimeConfig} config
 * @returns {number} seconds; 0 when the chat must not be asked
 */
export function askWindowSeconds(config) {
  if (config?.notificationsEnabled === false) return 0;
  const window = Number(config?.claudeAskWindowSeconds);
  if (!Number.isFinite(window) || window <= 0) return 0;
  return Math.floor(window);
}

/**
 * The note a message carries while it waits for the chat's answer.
 *
 * @param {number} window seconds
 * @param {string} where the interface that asks when the window closes
 * @returns {string}
 */
export function askReplyPrompt(window, where) {
  return `Answer here, or ${where} in ${window}s.`;
}

/**
 * Whether this request may be asked in Telegram now.
 *
 * An agent can invoke its hook for the same decision more than once — Copilot
 * re-runs `preToolUse` when the call goes back for confirmation, and a model that
 * could not get an answer may retry the same tool with a fresh call id. Asking the
 * chat again each time turns one approval into an endless stream of messages, so a
 * request is asked once, and only asked again after the chat has answered one (see
 * `releaseAsk`).
 *
 * The marker is a file, because every hook runs in its own process. No marker can
 * be written (a read-only temp dir) means "ask": losing a de-duplication is better
 * than losing the request.
 *
 * @param {{ agent: string, sessionId?: string, key?: string, ttlMs?: number }} input
 * @returns {boolean} true the first time, false while the marker is still fresh
 */
export function claimAsk({ agent, sessionId, key, ttlMs = 5 * 60 * 1000 }) {
  const file = askMarker({ agent, sessionId, key });
  if (!file) return true;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.now();
    try {
      const previous = Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.at);
      if (Number.isFinite(previous) && now - previous < ttlMs) return false;
    } catch {
      /* no marker yet, or unreadable: ask */
    }
    fs.writeFileSync(file, JSON.stringify({ at: now, agent, sessionId: sessionId || '', key }));
    return true;
  } catch {
    return true;
  }
}

/**
 * Forgets the marker for a request the chat answered, so the next identical
 * request is a new question.
 *
 * @param {{ agent: string, sessionId?: string, key?: string }} input
 */
export function releaseAsk({ agent, sessionId, key }) {
  const file = askMarker({ agent, sessionId, key });
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a marker that cannot be removed only costs one question */
  }
}

/**
 * @param {{ agent: string, sessionId?: string, key?: string }} input
 * @returns {string|null} the marker file, or null when there is nothing to key on
 */
function askMarker({ agent, sessionId, key }) {
  if (!String(key || '').trim()) return null;
  const id = `${agent}|${sessionId || ''}|${key}`;
  const fingerprint = createHash('sha1').update(id).digest('hex').slice(0, 16);
  const dir = process.env.TELEGRAM_NOTIFY_ASK_DIR || path.join(os.tmpdir(), 'telegram-notify');
  return path.join(dir, `ask-${fingerprint}.json`);
}
