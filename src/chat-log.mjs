import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './logger.mjs';

/**
 * Reads the reply of a Copilot Chat session from VS Code's own session log.
 *
 * Why this exists: `workbench.action.chat.open` submits a prompt into a real Chat
 * session — visible, resumable, manageable — but it returns nothing. VS Code
 * persists each session as an append-only operation log, so the answer can be
 * read back from there instead of duplicating the run through another API.
 */

/** How often to look for new text while the session runs. */
const POLL_MS = 1500;

/**
 * Folders where VS Code keeps chat sessions: one per workspace, plus the global
 * set used when no folder is open.
 *
 * @param {{ userDataDir?: string }} [options]
 * @returns {string[]}
 */
export function chatSessionDirs(options = {}) {
  const userData =
    options.userDataDir ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Code', 'User'));

  const dirs = [path.join(userData, 'globalStorage', 'emptyWindowChatSessions')];
  try {
    for (const entry of fs.readdirSync(path.join(userData, 'workspaceStorage'))) {
      const dir = path.join(userData, 'workspaceStorage', entry, 'chatSessions');
      if (fs.existsSync(dir)) dirs.push(dir);
    }
  } catch {
    /* no workspace storage yet */
  }
  return dirs;
}

/**
 * @param {string[]} dirs
 * @param {number} sinceMs
 * @returns {{ file: string, mtimeMs: number }[]} newest first
 */
export function recentSessions(dirs, sinceMs) {
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        // Allow a little slack for clock skew between the write and our timestamp.
        if (stat.mtimeMs + 2000 >= sinceMs) found.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Replays the operation log into the session state.
 *
 * The format is `{kind, k, v}`: 0 seeds the whole state, 1 sets the value at
 * path `k`, 2 pushes the values in `v` onto the array at path `k` (after
 * truncating it to `i` when that is given), and 3 clears the value at `k`.
 *
 * @param {string} file
 * @returns {any|null}
 */
export function readSessionState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.debug(`could not read chat session ${file}: ${err.message}`);
    return null;
  }

  let state = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let op;
    try {
      op = JSON.parse(trimmed);
    } catch {
      continue; // a partially written trailing line
    }
    if (op.kind === 0) {
      state = op.v;
      continue;
    }
    if (!state || !Array.isArray(op.k)) continue;

    if (op.kind === 1) setAtPath(state, op.k, op.v);
    else if (op.kind === 2) pushAtPath(state, op.k, op.v, op.i);
    else if (op.kind === 3) setAtPath(state, op.k, undefined);
  }
  return state;
}

/**
 * @param {any} state
 * @param {(string|number)[]} path
 * @param {unknown} value
 */
function setAtPath(state, path, value) {
  if (!path.length) return;
  const parent = resolveParent(state, path);
  if (!parent) return;
  parent[path[path.length - 1]] = value;
}

/**
 * @param {any} state
 * @param {(string|number)[]} path
 * @param {unknown} value
 * @param {number} [truncateTo]
 */
function pushAtPath(state, path, value, truncateTo) {
  if (!path.length) return;
  const parent = resolveParent(state, path);
  if (!parent) return;
  const key = path[path.length - 1];
  const list = Array.isArray(parent[key]) ? parent[key] : [];
  if (Number.isInteger(truncateTo)) list.length = truncateTo;
  if (Array.isArray(value)) list.push(...value);
  else if (value !== undefined) list.push(value);
  parent[key] = list;
}

/**
 * @param {any} state
 * @param {(string|number)[]} path
 */
function resolveParent(state, path) {
  let target = state;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (target === null || target === undefined) return null;
    target = target[path[index]];
  }
  return target === null || target === undefined ? null : target;
}

/**
 * The assistant's text for one request.
 *
 * VS Code stores a response as a list of parts: prose arrives as a part with a
 * `value` string and no `kind`, while tool calls, edits and the model's thinking
 * carry their own `kind`. Only the prose is taken.
 *
 * @param {any} request
 * @returns {string}
 */
export function responseTextOf(request) {
  const response = request?.response;
  const parts = Array.isArray(response) ? response : response ? [response] : [];
  const isProse = (part) =>
    part &&
    typeof part.value === 'string' &&
    (part.kind === undefined || part.kind === null || part.kind === 'text' || part.kind === 'markdown');

  return parts
    .filter(isProse)
    .map((part) => part.value)
    .join('')
    .trim();
}

/**
 * Whether the user pressed Stop in the Chat view.
 *
 * VS Code records a request's lifecycle in `modelState`: 0 is running, 1 done,
 * 2 cancelled by the user, 3 failed. An older build instead leaves the error
 * details on the result, so both are checked.
 *
 * @param {any} request
 */
export function isCancelledRequest(request) {
  if (!request) return false;
  if (request.isCanceled === true) return true;
  if (request.modelState?.value === 2) return true;
  const response = request.response;
  if (!Array.isArray(response) && response?.modelState?.value === 2) return true;
  return request.result?.errorDetails?.code === 'canceled';
}

/**
 * The lifecycle state of one request, as far as the log records it.
 * `unknown` means the entry predates the state field (or is still being written).
 *
 * @param {any} request
 * @returns {'cancelled'|'complete'|'failed'|'running'|'unknown'}
 */
export function requestStatus(request) {
  const value = request?.modelState?.value ?? request?.response?.modelState?.value;
  if (value === 2) return 'cancelled';
  if (value === 1) return 'complete';
  if (value === 3) return 'failed';
  if (value === 0) return 'running';
  if (request?.result?.timings?.totalElapsed !== undefined || request?.isComplete === true) return 'complete';
  return 'unknown';
}

/**
 * Finds the answer to `prompt` in the newest session that mentions it.
 *
 * @param {{ prompt: string, sinceMs: number, dirs?: string[], requireComplete?: boolean }} options
 * @returns {{ text: string, sessionId: string, file: string, pending: boolean, cancelled: boolean, status: string }|null}
 */
export function findReply({ prompt, sinceMs, dirs, requireComplete = false }) {
  // Telegram sends \n; VS Code stores \r\n. Normalize so a multi-line prompt
  // still matches the request it started.
  const normalize = (value) => String(value ?? '').replace(/\r\n/g, '\n');
  const needle = normalize(prompt).trim().slice(0, 200);
  if (!needle) return null;

  for (const { file } of recentSessions(dirs ?? chatSessionDirs(), sinceMs)) {
    const state = readSessionState(file);
    const requests = state?.requests;
    if (!Array.isArray(requests)) continue;

    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index];
      const asked = normalize(request?.message?.text);
      if (!asked.includes(needle)) continue;
      // A session can hold the same prompt from an earlier day; that answer is
      // not the one being waited for.
      const askedAt = request?.responseTimestamp ?? request?.timestamp;
      if (typeof askedAt === 'number' && askedAt + 2000 < sinceMs) continue;

      const status = requestStatus(request);
      const text = responseTextOf(request);
      if (status === 'cancelled') {
        return { text, sessionId: state.sessionId ?? '', file, pending: false, cancelled: true, status };
      }

      const complete = request?.result?.timings?.totalElapsed !== undefined || request?.isComplete === true;
      if (requireComplete && !complete && !text) {
        return { text: '', sessionId: state.sessionId ?? '', file, pending: true, cancelled: false, status };
      }
      return { text, sessionId: state.sessionId ?? '', file, pending: !text, cancelled: false, status };
    }
  }
  return null;
}

/**
 * Waits for the answer of the request that carries `prompt`.
 *
 * `timeoutMs` of 0 (or less) waits for as long as it takes: the chat request's
 * own state ends the wait, not a clock, because a long agent turn is not a
 * failure.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {number} options.sinceMs
 * @param {number} [options.timeoutMs]
 * @param {string[]} [options.dirs]
 * @param {() => boolean} [options.shouldStop]
 * @returns {Promise<{ ok: boolean, text: string, sessionId?: string, timedOut?: boolean, cancelled?: boolean, error?: string }>}
 */
export async function waitForReply({ prompt, sinceMs, timeoutMs, dirs, shouldStop }) {
  const bounded = Number(timeoutMs) > 0;
  const deadline = bounded ? Date.now() + Math.max(5000, timeoutMs) : Infinity;
  let lastText = '';

  while (Date.now() < deadline) {
    if (shouldStop?.()) return { ok: false, text: lastText, error: 'cancelled' };

    const found = findReply({ prompt, sinceMs, dirs });
    if (found?.cancelled) {
      // The user pressed Stop in the Chat view: stop watching at once instead of
      // waiting for the request to be closed.
      return { ok: false, text: '', sessionId: found.sessionId, cancelled: true, error: 'cancelled in the chat' };
    }

    // The recorded state is authoritative: while it says "running" a pause in the
    // text is a tool call or the model thinking, not the end of the answer.
    if (found && (found.status === 'complete' || found.status === 'failed')) {
      return { ok: true, text: found.text.trim(), sessionId: found.sessionId };
    }

    if (found?.text && found.status === 'unknown' && found.text !== lastText) {
      lastText = found.text;
      // An answer that stops growing for one poll is considered finished.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const settled = findReply({ prompt, sinceMs, dirs });
      if (settled?.text === lastText && settled?.status !== 'running') {
        return { ok: true, text: lastText.trim(), sessionId: found.sessionId };
      }
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return lastText
    ? { ok: true, text: lastText.trim() }
    : { ok: false, text: '', timedOut: true, error: 'no reply appeared in the Chat session' };
}
