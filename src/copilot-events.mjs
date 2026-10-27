/**
 * Reports the Copilot prompts that are waiting in the panel.
 *
 * A `permissionRequest` hook runs before Copilot's permission service, so it is
 * called for every tool call — including the ones the service auto-approves and
 * the user never sees. The session event log is written after that point: a
 * `permission.requested` exists only when the service is actually asking, and a
 * pending `ask_user` call exists only while its form waits for an answer.
 *
 * `~/.copilot/session-state/<sessionId>/events.jsonl` is written by the agent
 * host for both VS Code chats and CLI sessions, and new lines appear at once.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './logger.mjs';

export const DEFAULT_PANEL_WAIT_SECONDS = 20;

/** A prompt this old belongs to a session that was abandoned. */
const MAX_AGE_MS = 30 * 60 * 1000;
/** A reported prompt is forgotten after this, so the maps stay small. */
const KEEP_NOTIFIED_MS = 10 * 60 * 1000;
/** A session not written for this long cannot hold an actionable prompt. */
const INACTIVE_MS = 2 * 60 * 60 * 1000;
/** On first sight only the tail is read; a long session keeps its mode there. */
const TAIL_BYTES = 512 * 1024;
/** The session's own header keeps the cwd and the original permission mode. */
const HEAD_BYTES = 256 * 1024;
/** Tool names Copilot uses for a question or a decision. */
const QUESTION_TOOLS = new Set(['ask_user', 'askuser', 'ask_followup_question']);
const AUTOPILOT_MODES = new Set(['autopilot']);

/**
 * @param {{ home?: string }} [options]
 * @returns {string} the folder that holds one directory per Copilot session
 */
export function sessionStateRoot(options = {}) {
  const home =
    options.home ||
    process.env.COPILOT_HOME ||
    process.env.TELEGRAM_NOTIFY_COPILOT_HOME ||
    path.join(os.homedir(), '.copilot');
  return path.join(home, 'session-state');
}

export class CopilotEventWatcher {
  /**
   * @param {{
   *   root?: string,
   *   waitSeconds?: number,
   *   pollMs?: number,
   *   directory?: () => string[],
   *   enabled?: () => boolean,
   *   onPending?: (entry: any) => unknown,
   *   onTurn?: (turn: { type: 'started'|'ended', sessionId: string, prompt: string, cwd: string, at: number }) => void,
   *   log?: (level: 'debug'|'info'|'warn', message: string) => void,
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.root = options.root || sessionStateRoot();
    this.waitSeconds = Math.max(0, Number(options.waitSeconds ?? DEFAULT_PANEL_WAIT_SECONDS) || 0);
    this.pollMs = Math.max(250, Number(options.pollMs) || 1500);
    this.directory = options.directory || (() => []);
    this.enabled = options.enabled || (() => true);
    this.onPending = options.onPending;
    this.onTurn = options.onTurn;
    this.now = options.now || (() => Date.now());
    this.log = options.log || ((level, message) => log[level]?.(message));
    /** @type {Map<string, any>} */
    this.files = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.files.clear();
  }

  /** Reads what was appended since the last pass and reports prompts old enough. */
  tick() {
    let sessions;
    try {
      sessions = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const seen = new Set();
    for (const item of sessions) {
      if (!item.isDirectory()) continue;
      const file = path.join(this.root, item.name, 'events.jsonl');
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        // Only old sessions are skipped: a session that resumes becomes recent
        // again and is picked up on the next pass.
        if (!this.files.has(file) && Date.now() - stat.mtimeMs > INACTIVE_MS) continue;
        seen.add(file);
        this.#read(file, item.name, stat);
      } catch (err) {
        this.log('debug', `could not read ${file}: ${err.message}`);
      }
    }
    // A session folder that is gone should not leave its state behind.
    for (const file of this.files.keys()) {
      if (!seen.has(file)) this.files.delete(file);
    }
    this.#collect();
  }

  /**
   * @param {string} file
   * @param {string} sessionId
   * @param {fs.Stats} [knownStat]
   */
  #read(file, sessionId, knownStat) {
    const stat = knownStat ?? fs.statSync(file);
    let state = this.files.get(file);
    if (!state) {
      // Start at the tail: a long session's mode changes and pending request are
      // near the end, and replaying megabytes on every start is wasted work.
      const start = Math.max(0, stat.size - TAIL_BYTES);
      state = {
        offset: start,
        carry: '',
        skipPartial: start > 0,
        sessionId,
        cwd: '',
        mode: '',
        model: '',
        agent: 'copilot',
        allowAll: false,
        pending: new Map(),
        tools: new Map(),
      };
      this.files.set(file, state);
      if (start > 0) this.#readHead(file, state);
    }
    if (stat.size < state.offset) {
      state.offset = 0;
      state.carry = '';
      state.skipPartial = false;
    }
    if (stat.size === state.offset) return;

    const length = stat.size - state.offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset = stat.size;

    const lines = (state.carry + buffer.toString('utf8')).split('\n');
    state.carry = lines.pop() ?? '';
    if (state.skipPartial && lines.length) {
      // The tail can begin in the middle of a line; drop it only when it is not
      // already valid JSON, so a boundary hit does not lose a real event.
      try {
        JSON.parse(lines[0]);
      } catch {
        lines.shift();
      }
      state.skipPartial = false;
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handle(state, event);
    }

    // A session keeps every tool call it ever made; only the recent ones can
    // still own a pending request.
    if (state.tools.size > 500) {
      for (const key of state.tools.keys()) {
        state.tools.delete(key);
        if (state.tools.size <= 400) break;
      }
    }
  }

  /**
   * Reads the beginning of a session that is too long for one window, so the cwd
   * and the initial mode are known even when the tail no longer contains them.
   *
   * @param {string} file
   * @param {any} state
   */
  #readHead(file, state) {
    const length = Math.min(fs.statSync(file).size, HEAD_BYTES);
    if (!length) return;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, 0);
    } finally {
      fs.closeSync(fd);
    }
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // Only the session's own settings: a request counted here could have been
      // answered somewhere in the middle of the file, which this window cannot see.
      if (
        event?.type === 'session.start' ||
        event?.type === 'session.mode_changed' ||
        event?.type === 'session.permissions_changed'
      ) {
        this.#handle(state, event);
      }
    }
  }

  /**
   * The agent that owns a session.
   *
   * The Copilot CLI harness and a local harness on this machine write the *same*
   * session files — same `producer`, same model, same events — so the model cannot say
   * which one it was. Only the harness itself knows, so it says so when it reports
   * (its own hook config, `TELEGRAM_NOTIFY_HOOK_AGENT`, or a direct `POST /event/local`),
   * and the bridge records it here. Until then a session is Copilot, which is what the
   * installed Copilot hooks report.
   *
   * @param {any} state
   * @returns {string}
   */
  agentOf(state) {
    return String(state?.agent || 'copilot');
  }

  /**
   * Records the agent that reported a session, so its prompts are labelled the same way.
   *
   * @param {string} sessionId
   * @param {string} agent
   */
  setSessionAgent(sessionId, agent) {
    const id = String(sessionId || '').trim();
    const name = String(agent || '').trim().toLowerCase();
    if (!id || !name) return;
    for (const state of this.files.values()) {
      if (state.sessionId === id) state.agent = name;
    }
  }

  /**
   * @param {any} state
   * @param {any} event
   */
  #handle(state, event) {
    const data = event?.data || {};
    switch (event?.type) {
      case 'session.start':
        state.cwd = String(data.context?.cwd || data.cwd || state.cwd || '');
        state.mode = String(data.mode || state.mode || '');
        state.model = String(data.selectedModel || state.model || '');
        break;
      case 'model-switched':
      case 'session.model_change':
        state.model = String(data.newModel || data.model || state.model || '');
        break;
      case 'session.mode_changed':
        state.mode = String(data.newMode || state.mode || '');
        break;
      case 'session.permissions_changed':
        if (typeof data.allowAllPermissions === 'boolean') state.allowAll = data.allowAllPermissions;
        else if (data.allowAllPermissionMode) state.allowAll = String(data.allowAllPermissionMode).toLowerCase() === 'on';
        break;
      case 'permission.requested': {
        const request = data.permissionRequest || {};
        const id = String(data.requestId || request.toolCallId || this.#timeOf(event));
        state.pending.set(`permission:${id}`, {
          kind: 'permission',
          sessionId: state.sessionId,
          agent: this.agentOf(state),
          requestId: String(data.requestId || ''),
          toolCallId: String(request.toolCallId || ''),
          tool: String(state.tools.get(request.toolCallId)?.toolName || ''),
          permissionRequest: request,
          agentMode: String(data.agentMode || ''),
          at: this.#timeOf(event),
          cwd: String(request.workingDirectory || state.cwd || ''),
          notified: false,
        });
        break;
      }
      case 'permission.completed':
        state.pending.delete(`permission:${data.requestId}`);
        break;
      case 'tool.execution_start': {
        state.tools.set(data.toolCallId, { toolName: data.toolName, arguments: data.arguments });
        if (isQuestionTool(data)) {
          state.pending.set(`question:${data.toolCallId}`, {
            kind: 'question',
            sessionId: state.sessionId,
            agent: this.agentOf(state),
            toolCallId: String(data.toolCallId || ''),
            toolName: String(data.toolName || ''),
            arguments: data.arguments || {},
            at: this.#timeOf(event),
            cwd: state.cwd,
            notified: false,
          });
        }
        break;
      }
      case 'tool.execution_complete':
        state.pending.delete(`question:${data.toolCallId}`);
        break;
      // A new user turn, a finished task or a closed session means whatever was
      // waiting has been answered or abandoned.
      case 'user.message':
        state.pending.clear();
        this.#reportTurn(state, 'started', data, event);
        break;
      // The turn is over — finished, stopped from the panel, or interrupted. Whatever
      // was waiting is gone, and the prompt is no longer running, so `/list` stops
      // showing it. `agentStop` does not fire when the stop button is pressed, which is
      // why the event log is the signal here.
      case 'assistant.turn_end':
      case 'abort':
        state.pending.clear();
        this.#reportTurn(state, 'ended', data, event);
        break;
      case 'session.shutdown':
      case 'session.task_complete':
        state.pending.clear();
        this.#reportTurn(state, 'ended', data, event);
        break;
      default:
        break;
    }
  }

  /**
   * Tells the bridge that a session started or stopped working, so a prompt the panel
   * or a terminal started is listed while it runs and disappears when it ends.
   *
   * @param {any} state
   * @param {'started'|'ended'} type
   * @param {any} data
   * @param {any} event
   */
  #reportTurn(state, type, data, event) {
    if (!this.onTurn) return;
    if (type === 'started' && !this.enabled()) return;
    const prompt = type === 'started' ? String(data?.content ?? data?.transformedContent ?? '').trim() : '';
    try {
      this.onTurn({
        type,
        sessionId: state.sessionId,
        agent: this.agentOf(state),
        model: state.model,
        prompt,
        cwd: String(state.cwd || ''),
        at: this.#timeOf(event),
      });
    } catch (err) {
      this.log('debug', `could not report the turn of ${state.sessionId}: ${err.message}`);
    }
  }

  #collect() {
    if (!this.waitSeconds) return;
    if (!this.enabled()) return;
    const now = this.now();
    const windowMs = this.waitSeconds * 1000;

    for (const state of this.files.values()) {
      for (const [key, entry] of state.pending) {
        const age = now - entry.at;
        if (!Number.isFinite(age) || age > MAX_AGE_MS) {
          state.pending.delete(key);
          continue;
        }
        if (entry.notified) {
          if (age > KEEP_NOTIFIED_MS) state.pending.delete(key);
          continue;
        }
        if (age < windowMs) continue;
        // Autopilot and "allow all" approve on their own, so a request they leave
        // pending is about to be decided, not about to ask the user.
        if (entry.kind === 'permission' && this.#autoApproved(state, entry)) continue;
        if (!this.#inScope(entry.cwd)) continue;

        entry.notified = true;
        entry.waitedSeconds = Math.round(age / 1000);
        this.log('info', `copilot ${entry.kind} in ${state.sessionId} waited ${entry.waitedSeconds}s; reporting it`);
        try {
          const result = this.onPending?.(entry);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => this.log('warn', `could not report the prompt: ${err.message}`));
          }
        } catch (err) {
          this.log('warn', `could not report the prompt: ${err.message}`);
        }
      }
    }
  }

  /**
   * @param {any} state
   * @param {any} entry
   */
  #autoApproved(state, entry) {
    if (state.allowAll) return true;
    if (AUTOPILOT_MODES.has(String(state.mode || '').toLowerCase())) return true;
    return AUTOPILOT_MODES.has(String(entry.agentMode || '').toLowerCase());
  }

  /** @param {string} cwd */
  #inScope(cwd) {
    const folders = (this.directory() || []).filter(Boolean);
    if (!folders.length || !cwd) return true;
    const target = normalizePath(cwd);
    return folders.some((folder) => {
      const base = normalizePath(folder);
      return target === base || target.startsWith(`${base}/`);
    });
  }

  /** @param {any} event */
  #timeOf(event) {
    const time = Date.parse(String(event?.timestamp || ''));
    return Number.isFinite(time) ? time : this.now();
  }
}

/**
 * The Telegram message for one pending prompt.
 *
 * @param {any} entry
 */
export function notificationFor(entry) {
  const waited = Number(entry.waitedSeconds) || 0;
  const footer = waited ? `The panel has been waiting for ${waited}s.` : '';
  // A session on a locally configured model is a local agent, and the message says so
  // instead of naming Copilot.
  const agent = entry.agent === 'local' ? 'local' : 'copilot';
  const name = agent === 'local' ? 'Local agent' : 'Copilot';
  if (entry.kind === 'question') {
    const args = entry.arguments || {};
    return {
      type: 'question',
      agent,
      cwd: entry.cwd || '',
      title: `${name} is waiting for your answer`,
      message: String(args.message || `${name} asked a question.`),
      detail: [fieldSummary(args.requestedSchema), footer].filter(Boolean).join('\n\n'),
    };
  }

  const request = entry.permissionRequest || {};
  const kind = String(request.kind || entry.tool || 'tool');
  const intention = String(request.intention || '').trim();
  const detail = [permissionDetail(request), footer].filter(Boolean).join('\n\n');
  const titles = {
    shell: `${name} needs approval to run a command`,
    write: `${name} needs approval to write a file`,
    read: `${name} needs approval to read a file`,
    url: `${name} needs approval to open a URL`,
    'extension-management': `${name} needs approval to manage extensions`,
  };
  return {
    type: 'permission',
    agent,
    cwd: entry.cwd || '',
    title: titles[kind] || `${name} needs approval (${kind})`,
    message:
      intention ||
      firstLine(request.fullCommandText) ||
      request.fileName ||
      request.path ||
      request.url ||
      'A tool call is waiting for approval.',
    detail,
  };
}

/** @param {any} request */
function permissionDetail(request) {
  if (request.kind === 'shell') return [request.fullCommandText, request.workingDirectory].filter(Boolean).join('\n\n');
  if (request.kind === 'write') return [request.fileName, request.diff ? 'The diff is in the panel.' : ''].filter(Boolean).join('\n\n');
  if (request.kind === 'read') return String(request.path || '');
  if (request.kind === 'url') return String(request.url || '');
  return '';
}

/** @param {any} schema */
function fieldSummary(schema) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return '';
  return Object.entries(properties)
    .map(([name, field]) => {
      const label = field?.title || name;
      const options = optionLabels(field);
      if (options.length) return `${label}: ${options.join(' / ')}`;
      return field?.description ? `${label} — ${field.description}` : label;
    })
    .join('\n');
}

/** @param {any} field */
function optionLabels(field) {
  const oneOf = Array.isArray(field?.oneOf) ? field.oneOf.map((item) => item?.title || item?.const) : [];
  const values = Array.isArray(field?.enum) ? field.enum : [];
  return [...oneOf, ...values].filter(Boolean).map(String).slice(0, 8);
}

/** @param {any} data */
function isQuestionTool(data) {
  const name = String(data?.toolName || '').toLowerCase();
  if (QUESTION_TOOLS.has(name)) return true;
  return /asking user|ask user/i.test(String(data?.toolTitle || ''));
}

/** @param {string} value */
function firstLine(value) {
  return String(value || '').split('\n')[0].slice(0, 200);
}

/** @param {string} value */
function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
