import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerOf, isToolPart } from './answer.mjs';
import { log } from './logger.mjs';

/**
 * OpenCode integration.
 *
 * Two separate problems, both solved without the plugin API:
 *
 *   Reading turns    OpenCode 2.x runs a local HTTP server that the desktop app and
 *                    the sidebar both use. `GET /api/session` and
 *                    `GET /api/session/<id>/message` report every turn, so the
 *                    bridge can watch for a new `idle` message and post the
 *                    assistant's text. The v2 plugin API cannot be used for this:
 *                    a plugin must be a *directory*, its `event.subscribe()`
 *                    returns an Effect stream that plain JavaScript cannot iterate,
 *                    and `session.hook()` handlers never fired.
 *
 *   Sending prompts  `POST /api/session/<id>/prompt` runs the turn inside that same
 *                    server, so the sidebar and the desktop app show it while it is
 *                    written; the run polls the session for the turn's `idle`
 *                    message and returns its answer. `opencode run --format json`
 *                    stays the fallback when no server answers: the same runtime,
 *                    with the answer on a JSONL stream.
 */

/** Service file the desktop app and the sidebar extension both publish. */
const SERVICE_FILE = path.join(os.homedir(), '.config', 'opencode', 'service.json');

/** How long a request may take. */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * @typedef {{ baseUrl: string, password: string }} OpenCodeEndpoint
 */

/**
 * Finds the local OpenCode server.
 *
 * @param {{ serviceFile?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {OpenCodeEndpoint|null}
 */
export function discoverEndpoint(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = String(env.TELEGRAM_NOTIFY_OPENCODE_URL || '').trim();
  if (fromEnv) {
    const password = String(env.TELEGRAM_NOTIFY_OPENCODE_PASSWORD || '').trim();
    return { baseUrl: fromEnv.replace(/\/+$/, ''), password };
  }

  const file = options.serviceFile ?? SERVICE_FILE;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hostname = String(parsed.hostname || '127.0.0.1');
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { baseUrl: `http://${hostname}:${port}`, password: String(parsed.password || '') };
  } catch {
    return null;
  }
}

/**
 * VS Code hands back a lowercase drive letter; the server keys projects by the
 * canonical path, so it has to be normalised or the session list comes back empty.
 *
 * @param {string} directory
 */
export function canonicalDirectory(directory) {
  const value = String(directory || '').trim();
  if (!value) return '';
  return value.replace(/^([a-z]):/, (match, drive) => `${drive.toUpperCase()}:`).replace(/\\+$/, '');
}

/**
 * Whether two canonical directories name the same folder. Windows paths differ in
 * case between the editor and OpenCode, so the comparison ignores it.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameDirectory(a, b) {
  const left = canonicalDirectory(a);
  const right = canonicalDirectory(b);
  if (!left || !right) return true;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Whether a session belongs to one of the open folders. A session without a
 * location is kept, and so is every session when the editor has no folder open —
 * better to report than to silently watch nothing.
 *
 * @param {string} sessionDirectory
 * @param {string[]} directories
 * @returns {boolean}
 */
export function belongsTo(sessionDirectory, directories) {
  const wanted = (Array.isArray(directories) ? directories : [directories]).filter(Boolean);
  if (!wanted.length || !sessionDirectory) return true;
  const session = canonicalDirectory(sessionDirectory).toLowerCase().replace(/\\+$/, '');
  return wanted.some((directory) => {
    const folder = canonicalDirectory(directory).toLowerCase().replace(/\\+$/, '');
    // A session opened in a subfolder of the workspace belongs to it too.
    return session === folder || session.startsWith(`${folder}\\`);
  });
}

/** @param {OpenCodeEndpoint} endpoint */
function authHeader(endpoint) {
  if (!endpoint.password) return {};
  const token = Buffer.from(`opencode:${endpoint.password}`).toString('base64');
  return { authorization: `Basic ${token}` };
}

/**
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} apiPath
 * @param {{ method?: string, body?: unknown, directory?: string, timeoutMs?: number }} [options]
 */
async function request(endpoint, apiPath, options = {}) {
  const directory = canonicalDirectory(options.directory ?? '');
  const headers = {
    ...authHeader(endpoint),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);

  const response = await fetch(`${endpoint.baseUrl}${apiPath}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const body = text ? safeJson(text) : null;
  if (!response.ok) throw new Error(`${apiPath} answered ${response.status}`);
  return body;
}

/** @param {string} text */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether the server is there and accepts our credentials.
 *
 * @param {OpenCodeEndpoint|null} endpoint
 * @returns {Promise<boolean>}
 */
export async function isServerReachable(endpoint) {
  if (!endpoint) return false;
  try {
    await request(endpoint, '/api/info', { timeoutMs: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Newest sessions, newest first.
 *
 * The folder is sent as a query parameter as well as a header: the header selects
 * the project, while only `directory` narrows the list, so without it a busy
 * machine answers with other projects' sessions and an open folder's newest
 * session can fall outside the window.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {{ directory?: string, limit?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ id: string, title: string, updated: number, idle: number, directory: string, model?: any }[]>}
 */
export async function listSessions(endpoint, options = {}) {
  const directory = canonicalDirectory(options.directory ?? '');
  const path =
    `/api/session?limit=${options.limit ?? 10}&order=desc` +
    (directory ? `&directory=${encodeURIComponent(directory)}` : '');
  const body = await request(endpoint, path, { directory, timeoutMs: options.timeoutMs });
  return (body?.data ?? []).map((session) => ({
    id: String(session.id),
    title: String(session.title ?? ''),
    updated: Number(session.time?.updated ?? session.time?.created ?? 0),
    // When the server last went idle. `updated` stops moving once a turn has
    // finished, so this is the only field that changes when a turn completes.
    idle: Number(session.time?.idle ?? 0),
    directory: String(session.location?.directory ?? ''),
    model: session.model,
  }));
}

/**
 * Messages of one session, oldest first.
 *
 * The newest messages are fetched (`order=desc`) and reversed, so a long session
 * always yields its latest turns: asking for the oldest window would hide a new
 * turn behind a session's history.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {{ directory?: string, limit?: number }} [options]
 */
export async function sessionMessages(endpoint, sessionId, options = {}) {
  const body = await request(
    endpoint,
    `/api/session/${encodeURIComponent(sessionId)}/message?limit=${options.limit ?? 30}&order=desc`,
    { directory: options.directory },
  );
  const messages = body?.data ?? [];
  return Array.isArray(messages) ? [...messages].reverse() : [];
}

/**
 * One session, or null when it is gone.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {{ directory?: string, timeoutMs?: number }} [options]
 */
export async function fetchSession(endpoint, sessionId, options = {}) {
  try {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}`, {
      directory: options.directory,
      timeoutMs: options.timeoutMs,
    });
    const session = body?.data ?? body;
    return session && session.id ? session : null;
  } catch {
    return null;
  }
}

/**
 * Creates a session in the open folder with the model pinned, so its prompts run
 * on that model instead of the server's own default.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {{ directory?: string, model?: string, title?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string>} the session id
 */
export async function createSession(endpoint, options = {}) {
  const directory = canonicalDirectory(options.directory ?? '');
  const ref = modelRef(options.model);
  const body = await request(endpoint, '/api/session', {
    method: 'POST',
    directory,
    timeoutMs: options.timeoutMs,
    body: {
      ...(options.title ? { title: options.title } : {}),
      ...(ref ? { model: ref } : {}),
      // An adopted server (the desktop app's) would otherwise place the session
      // in its own cwd rather than the open folder.
      ...(directory ? { location: { directory } } : {}),
    },
  });
  const session = body?.data ?? body;
  const id = String(session?.id ?? '');
  if (!id) throw new Error('session create returned no id');
  return id;
}

/**
 * Admits one prompt and schedules the turn.
 *
 * Sent over HTTP rather than through `opencode run`, because the turn then runs
 * inside the server every editor is attached to: its event stream carries the
 * turn to the OpenCode sidebar and the desktop app, so the answer is visible
 * there while it is written instead of only after a reload.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {{ text: string, directory?: string, timeoutMs?: number, delivery?: 'queue'|'interrupt' }} options
 */
export async function sendPrompt(endpoint, sessionId, options) {
  const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    directory: options.directory,
    timeoutMs: options.timeoutMs,
    body: { text: String(options.text ?? ''), delivery: options.delivery ?? 'queue' },
  });
  return body?.data ?? body;
}

/**
 * Pins a session's model. Only used when a session has none of its own, where the
 * server would otherwise answer with its default — which may be an expensive or
 * unauthenticated provider.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {string} model `provider/model`
 * @param {{ directory?: string, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} whether a model was applied
 */
export async function setSessionModel(endpoint, sessionId, model, options = {}) {
  const ref = modelRef(model);
  if (!ref) return false;
  try {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      directory: options.directory,
      timeoutMs: options.timeoutMs,
      body: { model: ref },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What a running turn is blocked on, if anything: a question the model asked, or a
 * permission request. A headless prompt has nobody to click in the editor, so the
 * caller needs to say so instead of waiting in silence — and, with an ask window,
 * answer it from the chat.
 *
 * Each entry carries what answering it needs: the form's field keys (with the
 * options each offers) and, for a permission, the decisions the server accepts.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {{ directory?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ id: string, kind: string, title: string, lines: string[], fields: { key: string, title: string, options: string[] }[] }[]>}
 */
export async function waitingOn(endpoint, sessionId, options = {}) {
  const out = [];
  const directory = options.directory;
  const timeoutMs = options.timeoutMs ?? 4000;

  try {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}/form`, {
      directory,
      timeoutMs,
    });
    for (const form of body?.data ?? []) {
      const fields = Array.isArray(form.fields) ? form.fields : [];
      const visible = fields.filter((field) => field && !field.hidden);
      out.push({
        id: String(form.id),
        kind: String(form.metadata?.kind || 'question'),
        title: String(form.title || 'Questions'),
        // The question itself, then the options it offers — enough to decide
        // whether to go and answer it.
        lines: visible
          .map((field) => {
            const label = String(field.title || field.key || '');
            const detail = String(field.description || '');
            const options = labelsOf(field);
            const parts = [label, detail].filter(Boolean).join(' — ');
            return options.length ? `${parts}: ${options.join(', ')}` : parts;
          })
          .filter(Boolean),
        // What a reply must fill in, in the order the form asks for it.
        fields: visible
          .map((field) => ({ key: String(field.key || ''), title: String(field.title || ''), options: labelsOf(field) }))
          .filter((field) => field.key),
      });
    }
  } catch {
    /* an older server, or the form was answered meanwhile */
  }

  try {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}/permission`, {
      directory,
      timeoutMs,
    });
    for (const ask of body?.data ?? []) {
      out.push({
        id: String(ask.id || ask.requestID || ''),
        kind: 'permission',
        title: String(ask.title || ask.tool || ask.action || 'Permission request'),
        lines: [String(ask.message || ask.description || ask.summary || '')].filter(Boolean),
        fields: [],
      });
    }
  } catch {
    /* no permission requests to report */
  }

  return out.filter((ask) => ask.id);
}

/** @param {any} field */
function labelsOf(field) {
  if (!Array.isArray(field?.options)) return [];
  return field.options.map((option) => String(option?.label ?? option?.value ?? option ?? '')).filter(Boolean);
}

/**
 * Answers a permission request the bridge asked about in Telegram.
 *
 * `once` approves this one call, `always` also saves the rule (what the editor
 * offers as "always allow"), and `reject` declines. A free-text reply travels as
 * the rejection message, which is how the model learns why.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {string} requestId
 * @param {string} decision one of `once`, `always`, `reject`
 * @param {{ directory?: string, message?: string, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function replyToPermission(endpoint, sessionId, requestId, decision, options = {}) {
  const choice = ['once', 'always', 'reject'].includes(decision) ? decision : 'reject';
  try {
    await request(
      endpoint,
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        method: 'POST',
        directory: options.directory,
        timeoutMs: options.timeoutMs ?? 8000,
        body: { decision: choice, ...(options.message ? { message: options.message } : {}) },
      },
    );
    return true;
  } catch (err) {
    log.debug(`OpenCode permission ${requestId} was not answered: ${err.message}`);
    return false;
  }
}

/**
 * Answers a form the bridge asked about in Telegram.
 *
 * @param {OpenCodeEndpoint} endpoint
 * @param {string} sessionId
 * @param {string} formId
 * @param {Record<string, string|string[]>} answer one value per field key
 * @param {{ directory?: string, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function replyToForm(endpoint, sessionId, formId, answer, options = {}) {
  try {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, {
      method: 'POST',
      directory: options.directory,
      timeoutMs: options.timeoutMs ?? 8000,
      body: { answer },
    });
    return true;
  } catch (err) {
    log.debug(`OpenCode form ${formId} was not answered: ${err.message}`);
    return false;
  }
}

/**
 * Stops the turn a session is running. Best effort: the server may already be
 * idle, or gone.
 *
 * @param {OpenCodeEndpoint|null} endpoint
 * @param {string} sessionId
 * @param {{ directory?: string, timeoutMs?: number }} [options]
 */
export async function interruptSession(endpoint, sessionId, options = {}) {
  if (!endpoint || !sessionId) return false;
  try {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      directory: options.directory,
      timeoutMs: options.timeoutMs ?? 4000,
      body: {},
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `'provider/model'` as the server's model reference. An empty value falls back
 * to the pinned model; a value without a provider is not a reference at all.
 *
 * @param {string} [model]
 * @param {string} [fallback]
 * @returns {{ providerID: string, id: string }|null}
 */
export function modelRef(model, fallback = DEFAULT_OPENCODE_MODEL) {
  const value = String(model || fallback || '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

/**
 * The text of the last turn, from the newest `idle` message backwards.
 *
 * Only the answer is taken: the trailing assistant messages that do not come with
 * a tool call. A turn's earlier messages narrate the work ("I'll check the
 * project's state"), and a turn that was interrupted before it answered has no
 * answer text — its progress line is not sent as if it were the result.
 *
 * @param {any[]} messages
 * @returns {{ text: string, error: string, idleId: string, outcome: string }}
 */
export function lastTurnOf(messages) {
  if (!Array.isArray(messages) || !messages.length) return { text: '', error: '', idleId: '', outcome: '' };

  let idleIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === 'idle') {
      idleIndex = index;
      break;
    }
  }
  const idle = idleIndex >= 0 ? messages[idleIndex] : null;
  const end = idleIndex >= 0 ? idleIndex : messages.length;

  // Walk back to the user message that started this turn.
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === 'user') {
      start = index + 1;
      break;
    }
  }

  const turn = messages.slice(start, end);
  const { text, error } = turnAnswer(turn);

  return {
    text,
    error,
    idleId: String(idle?.id ?? ''),
    outcome: String(idle?.outcome ?? ''),
  };
}

/**
 * The answer a run of messages produced: its written text, and the reason a
 * provider gave for failing.
 *
 * Only the answer is taken: the trailing assistant messages that do not come with
 * a tool call. A turn's earlier messages narrate the work ("I'll check the
 * project's state"), and a turn that was interrupted before it answered has no
 * answer text — its progress line is not sent as if it were the result.
 *
 * @param {any[]} messages assistant messages of one turn
 * @returns {{ text: string, error: string }}
 */
function turnAnswer(messages) {
  const text = answerOf(
    (Array.isArray(messages) ? messages : [])
      .filter((message) => message?.type === 'assistant')
      .map((message) => ({
        text: textOf(message),
        toolWork: usesTools(message),
        step: true,
      })),
  );

  // A turn that failed because of the provider has no text, and the reason is the
  // only thing worth sending.
  let error = '';
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.type !== 'assistant') continue;
    const reason = String(message?.error?.message ?? message?.error?.response?.body ?? '').trim();
    if (reason) error = reason;
  }

  return { text, error };
}

/**
 * The answer the turn of one admitted prompt produced, or null while that turn is
 * still running.
 *
 * A session runs one turn at a time but can hold several admitted prompts: a
 * queued prompt's user message is written when it is admitted, and the turn that
 * follows covers both, ending in a single `idle`. The answer to *our* prompt is
 * therefore the text between it and the next user message (or the idle), never the
 * text of a turn that came after it.
 *
 * @param {any[]} messages oldest first
 * @param {string} userId id of the user message the server admitted
 * @returns {{ text: string, error: string, outcome: string }|null} null while running
 */
export function turnOfPrompt(messages, userId) {
  const list = Array.isArray(messages) ? messages : [];
  const id = String(userId ?? '');
  if (!id) return null;
  const at = list.findIndex((message) => String(message?.id ?? '') === id);
  if (at < 0) return null;

  const nextUser = list.findIndex((message, index) => index > at && message?.type === 'user');
  const idleAt = list.findIndex((message, index) => index > at && message?.type === 'idle');

  // A later prompt started before this one went idle: this turn is complete at
  // that point, and the later answer is not ours.
  if (nextUser >= 0 && (idleAt < 0 || nextUser < idleAt)) {
    const { text, error } = turnAnswer(list.slice(at + 1, nextUser));
    return { text, error, outcome: 'succeeded' };
  }
  if (idleAt < 0) return null;

  const { text, error } = turnAnswer(list.slice(at + 1, idleAt));
  return { text, error, outcome: String(list[idleAt]?.outcome ?? '') };
}

/**
 * The written parts of one assistant message, without its reasoning.
 *
 * @param {any} message
 * @returns {string}
 */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * Whether a message was the agent working rather than answering.
 *
 * @param {any} message
 * @returns {boolean}
 */
function usesTools(message) {
  if (String(message?.finish ?? '') === 'tool-calls') return true;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some(isToolPart);
}

/**
 * Model a Telegram prompt uses in OpenCode. Pinned on purpose: `opencode run`
 * otherwise picks whatever the server last used, which may be an expensive one.
 * `TELEGRAM_NOTIFY_OPENCODE_MODEL` overrides it.
 */
export const DEFAULT_OPENCODE_MODEL = 'opencode-go/deepseek-v4.1-flash';

/**
 * How long the session lookup may take. It happens before every prompt, so a
 * server that is not answering must not hold the prompt for long.
 */
const SESSION_LOOKUP_TIMEOUT_MS = 4000;

/**
 * The session a Telegram prompt continues: `TELEGRAM_NOTIFY_OPENCODE_SESSION`
 * when it names one, otherwise the newest session in the open folder — the one the
 * editor shows — so a prompt adds to the conversation instead of starting another.
 * `new` (or `off`) always starts a new session.
 *
 * A server that is not running, or a folder with no sessions yet, yields an empty
 * id and the run creates the session itself.
 *
 * @param {{ directory?: string, endpoint?: OpenCodeEndpoint|null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string>}
 */
export async function continuationSessionId(options = {}) {
  const env = options.env ?? process.env;
  const configured = String(env.TELEGRAM_NOTIFY_OPENCODE_SESSION || '').trim();
  if (configured) {
    return /^(new|off|none|0)$/i.test(configured) ? '' : configured;
  }

  const endpoint = Object.hasOwn(options, 'endpoint') ? options.endpoint : discoverEndpoint();
  if (!endpoint) return '';

  const directory = canonicalDirectory(options.directory ?? '');
  try {
    const sessions = await listSessions(endpoint, { directory, limit: 5, timeoutMs: SESSION_LOOKUP_TIMEOUT_MS });
    const folders = directory ? [directory] : [];
    const usable = sessions
      .filter((session) => !folders.length || belongsTo(session.directory, folders))
      // `updated` stops moving when a turn ends and `idle` is the only field that
      // then changes, so the later of the two is when the session was last used.
      .sort((a, b) => Math.max(b.updated, b.idle) - Math.max(a.updated, a.idle));
    return usable[0]?.id ?? '';
  } catch {
    // No server: the run starts its own and creates the session.
    return '';
  }
}

/**
 * Arguments for a non-interactive run that streams JSON lines.
 *
 * `--standalone` gives the run its own private server, so the CLI path needs nothing
 * else running. The model is always explicit, so a Telegram prompt cannot silently
 * run on a costlier one. `--session` continues an existing conversation (and
 * creates it when the id is unknown).
 *
 * The message is not part of the arguments: it is written to stdin, because
 * OpenCode does not unquote an argument that arrives with quotes around it, and
 * Node quotes every argument that contains a space — a prompt typed as
 * `How much it's cost` was recorded as `"How much it's cost"`.
 *
 * @param {{ model?: string, session?: string }} [options]
 * @returns {string[]}
 */
export function runArguments(options = {}) {
  const model = String(options.model || process.env.TELEGRAM_NOTIFY_OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL).trim();
  const session = String(options.session || '').trim();
  return [
    'run',
    '--standalone',
    '--format',
    'json',
    ...(session ? ['--session', session] : []),
    ...(model ? ['--model', model] : []),
  ];
}

/**
 * Reads the answer out of `opencode run --format json` output.
 *
 * Every line is one part: `{ type: 'text', sessionID, part: { text } }`. Only the
 * newest message's text parts are taken, so a retried or compacted earlier
 * message cannot leak into the answer.
 *
 * A failed run reports itself as `{ type: 'error', error: { type, message } }` and
 * exits non-zero without writing anything else, so that message is the only
 * explanation available and is returned rather than dropped.
 *
 * @param {string} stdout
 * @returns {{ text: string, sessionId: string, error: string }}
 */
export function parseRunOutput(stdout) {
  let sessionId = '';
  let error = '';
  /** @type {Map<string, string[]>} */
  const byMessage = new Map();
  const order = [];

  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.sessionID) sessionId = String(entry.sessionID);
    if (entry.type === 'error') {
      const reason = entry.error?.message || entry.error?.type || entry.message;
      if (typeof reason === 'string' && reason.trim()) error = reason.trim();
      continue;
    }
    if (entry.type !== 'text' || typeof entry.part?.text !== 'string') continue;
    const messageId = String(entry.part.messageID ?? entry.messageID ?? '');
    if (!byMessage.has(messageId)) {
      byMessage.set(messageId, []);
      order.push(messageId);
    }
    byMessage.get(messageId).push(entry.part.text);
  }

  const lastId = order[order.length - 1];
  const text = lastId ? byMessage.get(lastId).join('') : '';
  return { text: text.trim(), sessionId, error };
}

/**
 * Finds the `opencode` executable: an explicit path, `TELEGRAM_NOTIFY_OPENCODE_BIN`,
 * PATH, then the desktop app's bundled CLI.
 *
 * @param {string} [configured]
 * @returns {string|null}
 */
export function resolveOpenCodeBinary(configured) {
  if (configured) {
    const candidate = path.resolve(configured);
    return fs.existsSync(candidate) ? candidate : null;
  }

  const fromEnv = process.env.TELEGRAM_NOTIFY_OPENCODE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode-cli.exe'] : ['opencode'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }

  // The desktop app ships the same CLI under a versioned folder.
  const desktop = process.env.APPDATA ? path.join(process.env.APPDATA, 'ai.opencode.desktop', 'cli') : '';
  try {
    const versions = fs.readdirSync(desktop).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(desktop, version, process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* not installed */
  }
  return null;
}

/**
 * Post a completion once per idle message, never twice for the same turn.
 *
 * The server is discovered on every poll and probed until it answers: OpenCode is
 * usually started after the extension, and it may be restarted (or moved to
 * another port) while VS Code stays open. Failing to reach it once must not end
 * the watch for the rest of the session.
 */
export class OpenCodeWatcher {
  /**
   * @param {object} options
   * @param {() => (OpenCodeEndpoint|null)} options.endpoint
   * @param {() => string|string[]|undefined} [options.directory] open folder(s)
   * @param {(turn: { sessionId: string, title: string, text: string, error: string, outcome: string }) => Promise<void>|void} options.onCompleted
   * @param {(baseUrl: string) => void} [options.onConnect] called when the server starts answering
   * @param {(level: 'info'|'warn'|'debug', message: string) => void} [options.log] receives the watcher's log lines
   * @param {number} [options.intervalMs]
   */
  constructor({ endpoint, directory, onCompleted, onConnect, log: logger, intervalMs = 5000 }) {
    this.getEndpoint = endpoint;
    this.getFolderList = directory ?? (() => undefined);
    this.onCompleted = onCompleted;
    this.onConnect = onConnect;
    this.emitLog = logger;
    this.intervalMs = Math.max(1000, intervalMs);
    /** idle message id → when it was reported, kept small */
    this.seen = new Map();
    /**
     * Sessions whose next finished turn the bridge answered itself. The run that
     * answered it posts the text, so the watcher records the turn and stays quiet.
     * Unlike skipping the session for good, later turns in it are still reported:
     * a Telegram prompt continues the session the editor has open.
     */
    this.answered = new Set();
    /**
     * session id → the freshness stamp already inspected. Both `updated` and
     * `idle` are part of it: a finished turn leaves `updated` alone and only moves
     * `idle`, so comparing `updated` alone would hide every completion.
     */
    this.touched = new Map();
    /** whether the last poll reached the server */
    this.reachable = false;
    this.seeded = false;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Marks a session whose next finished turn the bridge itself answers: the run
   * that answered it posts the text, so reporting the turn would say it twice.
   *
   * @param {string} sessionId
   */
  suppressNextTurn(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return;
    this.answered.add(id);
    while (this.answered.size > 50) this.answered.delete(this.answered.values().next().value);
  }

  /**
   * Drops a mark from {@link suppressNextTurn} when the run produced no turn after
   * all, so a later turn in that session is not swallowed.
   *
   * @param {string} sessionId
   */
  resumeReporting(sessionId) {
    const id = String(sessionId || '').trim();
    if (id) this.answered.delete(id);
  }

  /**
   * Remembers one reported idle message so its turn is never sent twice, and keeps
   * the record from growing without bound.
   *
   * @param {string} idleId
   */
  markSeen(idleId) {
    this.seen.set(idleId, Date.now());
    if (this.seen.size <= 200) return;
    for (const [id, at] of this.seen) if (Date.now() - at > 6 * 3600 * 1000) this.seen.delete(id);
  }

  /** Every folder the editor has open, as a list. */
  folders() {
    const value = this.getFolderList();
    return (Array.isArray(value) ? value : [value]).filter(Boolean);
  }

  /**
   * The newest sessions of every open folder, without duplicates.
   *
   * Each folder is asked for on its own: the list is scoped by folder, and a
   * multi-root workspace would otherwise see only the first folder's sessions.
   *
   * @param {OpenCodeEndpoint} endpoint
   * @param {string[]} folders
   * @returns {Promise<{ id: string, title: string, updated: number, idle: number, directory: string }[]>}
   */
  async listFolders(endpoint, folders) {
    const byId = new Map();
    const wanted = folders.length ? folders : [undefined];
    for (const folder of wanted) {
      const page = await listSessions(endpoint, { directory: folder, limit: 20 });
      for (const session of page) if (!byId.has(session.id)) byId.set(session.id, session);
    }
    return [...byId.values()];
  }

  /** Writes one line through the extension's log when it is wired up. */
  report(level, message) {
    this.emitLog?.(level, message);
    log[level]?.(message);
  }

  /** One poll: inspect only sessions whose last activity is new. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const endpoint = this.getEndpoint();
      // No service file yet: OpenCode has not been started in this session.
      if (!endpoint) return;
      if (!this.reachable) {
        if (!(await isServerReachable(endpoint))) return;
        this.reachable = true;
        this.report('info', `watching opencode sessions at ${endpoint.baseUrl}`);
        this.onConnect?.(endpoint.baseUrl);
      }

      const folders = this.folders();
      const sessions = await this.listFolders(endpoint, folders);
      let inspected = 0;

      for (const session of sessions) {
        // The API answers with every project's sessions, so the open folders are
        // compared here.
        if (!belongsTo(session.directory, folders)) continue;
        // A session whose activity has not moved since the last poll cannot hold a
        // new turn.
        const stamp = `${session.updated}|${session.idle}`;
        if (this.touched.get(session.id) === stamp && this.seeded) continue;

        const messages = await sessionMessages(endpoint, session.id, {
          directory: session.directory || folders[0],
          limit: 40,
        });
        this.touched.set(session.id, stamp);
        inspected += 1;
        const turn = lastTurnOf(messages);
        if (!turn.idleId) continue;
        if (this.seen.has(turn.idleId)) continue;
        this.markSeen(turn.idleId);

        // This turn was answered from Telegram, which already posted the text.
        if (this.answered.has(session.id)) {
          this.answered.delete(session.id);
          this.report('debug', `turn in ${session.id} was answered from Telegram; not reporting it`);
          continue;
        }

        // The first poll only records the backlog; reporting it would replay old
        // turns into the chat every time the extension starts.
        if (!this.seeded) continue;

        try {
          await this.onCompleted({
            sessionId: session.id,
            title: session.title,
            text: turn.text,
            error: turn.error,
            outcome: turn.outcome,
          });
        } catch (err) {
          // Sending is what the reader cares about, so a failure must not consume
          // the turn: forget it and inspect the session again on the next poll.
          this.seen.delete(turn.idleId);
          this.touched.delete(session.id);
          this.report('warn', `could not report the opencode turn of ${session.id}: ${err.message}`);
        }
      }
      if (!this.seeded) {
        this.report('info', `opencode backlog recorded: ${sessions.length} session(s), ${inspected} inspected`);
      }
      this.seeded = true;
    } catch (err) {
      // A dropped connection is expected: OpenCode exits with VS Code, restarts on
      // another port, or is closed by the user. Say so once and probe again.
      if (this.reachable) {
        this.reachable = false;
        this.report('warn', `opencode session watch stopped: ${err.message}; waiting for the server`);
      } else {
        this.report('debug', `opencode watch failed: ${err.message}`);
      }
    } finally {
      this.running = false;
    }
  }
}
