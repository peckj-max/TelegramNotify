import { randomUUID } from 'node:crypto';
import { formatAgentMessages, formatDuration, formatResolution, truncate } from './message.mjs';
import { fitsOneMessage } from './markdown.mjs';
import { PendingRequests } from './pending.mjs';
import { AGENTS, PROMPT_AGENTS } from './config.mjs';
import { runClaudePrompt, runOpenCodePrompt } from './remote-prompt.mjs';
import { askReplyPrompt } from './hooks/ask.mjs';
import { TelegramClient } from './telegram.mjs';
import { log } from './logger.mjs';

const TYPES = new Set(['question', 'permission', 'completed', 'info', 'error']);
const MAX_PENDING = 50;
/** Telegram clears the typing hint after ~5s; refresh it before that. */
const TYPING_INTERVAL_MS = 10000;
/** How many update ids are remembered to drop Telegram's redeliveries. */
const MAX_SEEN_UPDATES = 500;
/** Sent when the Stop button ends a prompt that came from Telegram. */
const USER_CANCELLED_TEXT = 'Task is cancelled by user.';
/** Agent for a Telegram prompt before any agent has reported an event. */
const DEFAULT_AGENT = 'copilot';
/** What OpenCode accepts for a permission, in the order the buttons are drawn. */
const OPENCODE_PERMISSION_OPTIONS = ['Allow once', 'Always allow', 'Deny'];
/**
 * How long a Claude prompt submitted to Chat waits for its `Stop` hook. The hook
 * is how the turn's answer reaches Telegram, so its completion is the end of the
 * turn; the cap only stops the typing hint when a window has no working hooks.
 */
const CLAUDE_HOOK_WAIT_MS = 30 * 60 * 1000;
/** The wait polls the prompt's flags; a turn reports at most a few times a minute. */
const CLAUDE_HOOK_POLL_MS = 500;

function normalizeType(value) {
  const type = String(value || 'info').toLowerCase();
  if (TYPES.has(type)) return type;
  if (type === 'done' || type === 'success' || type === 'finish' || type === 'finished') return 'completed';
  if (type === 'ask' || type === 'confirm' || type === 'confirmation' || type === 'decision') return 'question';
  return 'info';
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((option) => (typeof option === 'string' ? option : option?.label ?? option?.text ?? ''))
    .map((option) => String(option).trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * A short id for a running prompt, in the same shape as a pending request id, so
 * `/list` shows one kind of id and `/cancel` accepts either. The id is only a
 * handle: it carries no meaning and is not a queue position.
 *
 * @returns {string}
 */
function newPromptId() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * Turns agent events into Telegram messages and routes answers back.
 */
export class Notifier {
  /**
   * @param {import('./config.mjs').RuntimeConfig} config
   * @param {{
   *   telegram?: TelegramClient,
   *   pending?: PendingRequests,
   *   submitPrompt?: (input: { agent: string, prompt: string }) => Promise<any>,
   *   typingIntervalMs?: number,
   *   initialAgent?: string,
   *   rememberAgent?: (agent: string) => void|Promise<void>,
   *   runClaudePrompt?: typeof runClaudePrompt,
   *   runOpenCodePrompt?: typeof runOpenCodePrompt,
   *   openCodeWatcher?: { suppressNextTurn?: (sessionId: string) => void, resumeReporting?: (sessionId: string) => void },
   *   openAgentSession?: (input: { agent: string, sessionId: string }) => any,
   *   defaultCwd?: string | (() => string|undefined),
   * }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.telegram = deps.telegram ?? new TelegramClient(config);
    this.pending = deps.pending ?? new PendingRequests();
    // Injectable so tests never spawn an agent CLI.
    this.runClaudePrompt = deps.runClaudePrompt ?? runClaudePrompt;
    this.runOpenCodePrompt = deps.runOpenCodePrompt ?? runOpenCodePrompt;
    // Working directory for a headless Claude run: the open workspace folder.
    this.defaultCwd = deps.defaultCwd ?? undefined;
    this.typingIntervalMs = Math.max(100, Number(deps.typingIntervalMs) || TYPING_INTERVAL_MS);
    // Set by the extension host: submits to VS Code Chat, the only runner.
    this.submitPrompt = deps.submitPrompt ?? null;
    // Set by the extension host: reads the reply out of the Chat session log.
    this.readChatReply = deps.readChatReply ?? null;
    // Set by the extension host: opens an agent's session in its own panel.
    this.openAgentSession = deps.openAgentSession ?? null;
    // A Telegram prompt goes to the agent that was used last; Copilot until some
    // agent reports an event.
    this.rememberAgent = deps.rememberAgent ?? null;
    this.lastAgent = PROMPT_AGENTS.includes(String(deps.initialAgent || '').toLowerCase())
      ? String(deps.initialAgent).toLowerCase()
      : DEFAULT_AGENT;
    // Prompts still running, so they can be stopped instead of reporting
    // progress until their timeout.
    this.activePrompts = new Map();
    this.promptSeq = 0;
    /**
     * session id → the agent that session really is (`local` when it runs on a
     * locally configured model). The Copilot hooks cannot see the model, so they always
     * report `copilot`; this map corrects the name for the session they belong to.
     */
    this.sessionAgents = new Map();
    // Telegram redelivers an update until it is acknowledged; a redelivered
    // prompt must not start a second session.
    this.seenUpdates = new Map();
    // Set by the extension once the OpenCode watcher runs: a prompt answered here
    // must not be reported again by the watcher.
    this.openCodeWatcher = deps.openCodeWatcher ?? null;
  }

  get ready() {
    return this.telegram.enabled && this.config.chatIds.length > 0;
  }

  /** Notifications are switched off: send nothing, and answer nothing. */
  get notificationsEnabled() {
    return this.config.notificationsEnabled !== false;
  }

  /**
   * Records which agent a session really is, when that has been learned from an event
   * whose source is unambiguous — a harness that reported as `local`. A Copilot hook
   * cannot tell Copilot from a local harness, so it never sets this; once a session is
   * known to be local, its later `copilot`-looking events are labelled `local` too, which
   * is what a harness that only identifies itself for the first turn needs.
   *
   * @param {string} sessionId
   * @param {string} agent
   */
  assignSessionAgent(sessionId, agent) {
    const id = String(sessionId || '').trim();
    const name = String(agent || '').trim().toLowerCase();
    if (!id || !AGENTS.includes(name)) return;
    // The session in use is where the next Telegram prompt belongs.
    this.#rememberAgent(name);
    const known = this.sessionAgents.get(id);
    if (known === name) return;
    this.sessionAgents.set(id, name);
    // The map only exists to correct what the hooks report; keep it small.
    while (this.sessionAgents.size > 200) {
      this.sessionAgents.delete(this.sessionAgents.keys().next().value);
    }
    log.debug(`session ${id} is ${name}`);
  }

  /**
   * The agent a request belongs to: what the session was already known to be, else what
   * the event says. A session is Copilot until something explicitly reported otherwise,
   * because a Copilot hook cannot see which harness ran it.
   *
   * @param {{ agent?: string, sessionId?: string }} request
   * @returns {string}
   */
  #resolveAgent(request) {
    const reported = String(request.agent || '').trim().toLowerCase();
    // OpenCode and Claude events name themselves; only the harness that cannot see which
    // one ran it (Copilot's) is resolved from what the session was reported to be.
    if (reported && reported !== 'copilot' && reported !== 'local') return reported;
    const known = this.sessionAgents.get(String(request.sessionId || '').trim());
    return known || reported;
  }

  /** @param {string|number} chatId */
  acceptsChat(chatId) {
    return this.config.chatIds.includes(String(chatId));
  }

  /**
   * Remembers which agent is in use, so the next Telegram prompt is delivered to
   * it rather than to a configured one. Calls that are not real prompt targets — the
   * extension's own test message reports `vscode`, and a local harness has no session
   * the bridge can drive — are ignored.
   *
   * @param {unknown} value
   */
  #rememberAgent(value) {
    const agent = String(value ?? '').trim().toLowerCase();
    if (!PROMPT_AGENTS.includes(agent) || agent === this.lastAgent) return;
    this.lastAgent = agent;
    log.debug(`last agent is now ${agent}`);
    try {
      Promise.resolve(this.rememberAgent?.(agent)).catch((err) => log.debug(`could not remember the agent: ${err.message}`));
    } catch (err) {
      log.debug(`could not remember the agent: ${err.message}`);
    }
  }

  /**
   * @param {object} request
   * @param {'question'|'permission'|'completed'|'info'|'error'} [request.type]
   * @param {string} [request.agent]
   * @param {string} [request.title]
   * @param {string} [request.message]
   * @param {string} [request.detail]
   * @param {string} [request.cwd]
   * @param {string[]} [request.options]
   * @param {boolean} [request.waitForReply]
   * @param {number} [request.timeoutSeconds]
   * @param {string} [request.replyPrompt]
   */
  async notify(request = {}) {
    const type = normalizeType(request.type);
    // The event's own agent is what the harness reported; a session already known to be
    // local keeps that name. The title is built from the same name, so a message can never
    // say "Copilot finished" above `local`.
    const reported = String(request.agent || '').trim().toLowerCase();
    if (reported === 'local' && request.sessionId) this.assignSessionAgent(request.sessionId, 'local');
    const agent = this.#resolveAgent(request) || reported;
    request = { ...request, agent, title: titleForAgent(request.title, agent, type) };
    this.#rememberAgent(request.agent);

    // A prompt the agent host writes for itself ("you have not yet marked the task
    // as complete") is not the user asking again: it is the same task continuing, so
    // nothing is listed for it.
    if (request.promptStart === true && request.synthetic === true) {
      log.debug(`the agent continued ${request.sessionId || 'the session'} on its own`);
      return { ok: true, skipped: true, reason: 'synthetic-prompt' };
    }

    // A prompt an agent received from its own panel or terminal is still work in
    // progress, so it is listed with the prompts the bridge runs.
    if (request.promptStart === true) {
      this.trackRunningPrompt({
        agent: String(request.agent || ''),
        prompt: String(request.message || request.prompt || ''),
        sessionId: request.sessionId,
        startedAt: request.startedAt,
      });
    }

    // The turn is over: stop watching any prompt this completion belongs to, so
    // its typing hint ends and the answer is not posted twice. Done before the
    // early returns below: a completion never waits for a reply, and the prompt
    // must end even when this notification is skipped.
    if (type === 'completed') {
      this.#finishPromptsAnsweredByHook(String(request.agent || ''));
      this.finishRunningPrompt(request.sessionId);
    }
    if (request.silent === true) {
      // A hook using the bridge only to say which agent is in use: nothing to send.
      log.debug(`silent ${request.agent || 'agent'} event recorded`);
      return { ok: true, skipped: true, reason: 'silent' };
    }
    if (!this.notificationsEnabled) {
      log.debug('notification skipped: notifications are disabled');
      return { ok: false, skipped: true, reason: 'notifications-disabled' };
    }
    if (!this.ready) {
      log.warn('notification skipped: bot token or chat id is not configured');
      return { ok: false, skipped: true, reason: 'not-configured' };
    }
    if (type === 'completed' && !this.config.notifyOnCompleted) {
      return { ok: false, skipped: true, reason: 'completed-disabled' };
    }

    const chatId = String(request.chatId || this.config.chatIds[0]);
    if (!this.acceptsChat(chatId)) {
      return { ok: false, skipped: true, reason: 'chat-not-allowed' };
    }

    // A turn is sent as soon as it finishes: no message is held back. If the agent host
    // continues the turn and reports a `task_complete` summary afterwards, that summary
    // arrives as its own message.

    const waitForReply = Boolean(request.waitForReply);
    const timeoutSeconds = Math.min(
      Math.max(1, Number(request.timeoutSeconds) || this.config.replyTimeoutSeconds),
      7 * 24 * 3600,
    );
    const options = normalizeOptions(request.options);
    // A misbehaving agent must not grow the pending map without bound.
    const canWait = waitForReply && this.pending.size < MAX_PENDING;
    if (waitForReply && !canWait) log.warn(`pending queue is full (${MAX_PENDING}); sending without waiting for an answer`);

    const entry = canWait
      ? this.pending.create({ agent: String(request.agent || ''), type, chatId, options, timeoutSeconds, title: request.title })
      : null;
    const messages = formatAgentMessages(
      {
        ...request,
        type,
        options,
        waitForReply: canWait,
        timeoutSeconds,
        message: request.replyPrompt ? [request.message, request.replyPrompt].filter(Boolean).join('\n\n') : request.message,
      },
      this.config.maxMessageLength,
    );

    // The keyboard belongs on the first message so it sits with the question.
    const sentIds = [];
    let sent;
    try {
      for (const [index, text] of messages.entries()) {
        const result = await this.telegram.sendMessage({
          chatId,
          text,
          replyMarkup: index === 0 && entry && options.length ? optionKeyboard(entry.id, options) : undefined,
        });
        sentIds.push(result.message_id);
        if (index === 0) sent = result;
      }
    } catch (err) {
      log.error(`sendMessage failed: ${err.message}`);
      entry?.resolve({ source: 'cancelled', answer: null, reply: null, optionIndex: null, timedOut: false });
      return { ok: false, reason: 'telegram-error', error: err.message, messageIds: sentIds };
    }

    const messageIds = sentIds;

    if (!entry) return { ok: true, messageId: sent.message_id, messageIds, chatId };

    this.pending.attachMessage(entry.id, sent.message_id);
    log.debug(`waiting for ${entry.id} (${type}, ${timeoutSeconds}s, ${messages.length} message(s))`);

    const resolution = await entry.wait;
    const footer =
      resolution.source === 'timeout'
        ? `⌛ no answer after ${formatDuration(timeoutSeconds)}`
        : resolution.source === 'cancelled'
          ? '✖ cancelled'
          : formatResolution(resolution);

    await this.#markResolved({ chatId, messages, messageIds, footer });

    return {
      ok: true,
      requestId: entry.id,
      messageId: sent.message_id,
      messageIds,
      chatId,
      source: resolution.source,
      answer: resolution.answer ?? null,
      reply: resolution.reply ?? null,
      optionIndex: resolution.optionIndex ?? null,
      timedOut: resolution.source === 'timeout',
    };
  }

  /**
   * Shows the outcome on the notification itself: the footer is appended where
   * it fits, and the keyboard is cleared either way.
   *
   * @param {{ chatId: string, messages: string[], messageIds: number[], footer: string }} input
   */
  async #markResolved({ chatId, messages, messageIds, footer }) {
    const limit = this.config.maxMessageLength;
    const clearKeyboard = { inline_keyboard: [] };
    const first = { chatId, messageId: messageIds[0], text: messages[0], replyMarkup: clearKeyboard };

    if (fitsOneMessage(messages[0], footer, limit)) {
      await this.telegram.tryEditMessageText({ ...first, text: `${messages[0]}\n\n${footer}` });
      return;
    }

    // A full first message: unfreeze it, then put the footer where it fits.
    await this.telegram.tryEditMessageText(first);
    const lastIndex = messageIds.length - 1;
    if (lastIndex > 0 && fitsOneMessage(messages[lastIndex], footer, limit)) {
      await this.telegram.tryEditMessageText({
        chatId,
        messageId: messageIds[lastIndex],
        text: `${messages[lastIndex]}\n\n${footer}`,
      });
      return;
    }
    try {
      await this.telegram.sendMessage({ chatId, text: footer });
    } catch (err) {
      log.debug(`could not send the footer: ${err.message}`);
    }
  }

  /** @param {string} requestId */
  cancel(requestId) {
    if (!requestId || requestId === 'all' || requestId === '*') return this.cancelAll() > 0;
    const entry = this.pending.get(requestId);
    if (entry) {
      entry.resolve({ source: 'cancelled', answer: null, reply: null, optionIndex: null, timedOut: false });
      return true;
    }
    const active = this.activePrompts.get(requestId);
    if (!active) return false;
    return this.#cancelPrompt(active);
  }

  /**
   * Stops every waiting request and every running prompt. Returns how many
   * tasks were cancelled.
   *
   * @param {'cancelled'|'shutdown'} [reason]
   */
  cancelAll(reason = 'cancelled') {
    const pendingCount = this.pending.size;
    this.pending.cancelAll(reason);
    let activeCount = 0;
    for (const active of this.activePrompts.values()) {
      if (this.#cancelPrompt(active)) activeCount += 1;
    }
    return pendingCount + activeCount;
  }

  /**
   * @param {{ id: string, agent: string, prompt: string, chatId: string|number }} input
   */
  #trackPrompt({ id, agent, prompt, chatId }) {
    const active = {
      id,
      agent,
      prompt,
      chatId,
      // A prompt the bridge runs itself, as opposed to one an agent is running in
      // its own panel or terminal.
      source: 'telegram',
      sessionId: '',
      startedAt: Date.now(),
      cancelled: false,
      // Set when the agent hooks report the turn ended, so the bridge stops
      // watching a prompt whose answer already reached Telegram.
      hookAnswered: false,
      stopTyping: () => {},
      controller: new AbortController(),
    };
    this.activePrompts.set(id, active);
    return active;
  }

  /**
   * Records a prompt an agent is running although the bridge did not start it — a
   * turn typed into the editor panel or the agent's terminal. `/list` and
   * `/status` show it, and `/cancel` stops it through `interrupt`.
   *
   * The session identifies the turn, so polling the same running turn again
   * refreshes the entry instead of adding a second one.
   *
   * @param {object} input
   * @param {string} [input.agent]
   * @param {string} [input.prompt]
   * @param {'external'} [input.source]
   * @param {string} [input.sessionId]
   * @param {number} [input.startedAt]
   * @param {() => Promise<boolean>|boolean} [input.interrupt]
   */
  trackRunningPrompt({ agent, prompt, source = 'external', sessionId, startedAt, interrupt } = {}) {
    const session = String(sessionId || '').trim();
    const key = session ? `session:${session}` : '';
    const name = String(agent || '').trim().toLowerCase();
    if (key) {
      for (const active of this.activePrompts.values()) {
        if (active.key !== key) continue;
        if (prompt) active.prompt = String(prompt);
        // The turn is already listed, and its agent is the one running it. This is
        // what moves `/status` the moment a prompt starts, rather than only when
        // its completion arrives.
        this.#rememberAgent(active.agent || name);
        return active;
      }
    }

    // The bridge may have submitted this very prompt through the editor, and the
    // agent's hook then reports the same turn. What the bridge runs is already
    // listed, so a second entry would only show one prompt twice.
    const twin = this.#telegramPromptFor(prompt);
    if (twin) {
      if (session) twin.sessionId = twin.sessionId || session;
      return twin;
    }

    // An agent starting a turn is the agent in use, so the next Telegram prompt
    // belongs to it. Without this, `/status` kept naming whatever ran last — a
    // Copilot or local turn — until the OpenCode turn *completed*, because only a
    // completion went through `notify()` and remembered its agent.
    this.#rememberAgent(name);

    this.promptSeq += 1;
    const id = newPromptId();
    const started = Number(startedAt);
    const active = {
      id,
      key,
      agent: String(agent || ''),
      prompt: String(prompt || ''),
      chatId: null,
      source,
      sessionId: session,
      startedAt: Number.isFinite(started) && started > 0 ? started : Date.now(),
      cancelled: false,
      hookAnswered: false,
      stopTyping: () => {},
      controller: new AbortController(),
      interrupt: typeof interrupt === 'function' ? interrupt : null,
    };
    this.activePrompts.set(id, active);
    log.debug(`tracking running prompt ${id} (${active.agent || 'agent'}, ${session || 'no session'})`);
    return active;
  }

  /**
   * Forgets the running prompt of a session that finished.
   *
   * @param {string} sessionId
   * @returns {boolean} whether an entry was removed
   */
  finishRunningPrompt(sessionId) {
    const session = String(sessionId || '').trim();
    if (!session) return false;
    const key = `session:${session}`;
    for (const [id, active] of this.activePrompts) {
      if (active.key !== key) continue;
      active.stopTyping?.();
      this.activePrompts.delete(id);
      return true;
    }
    return false;
  }

  /**
   * The prompt the bridge itself is running, when it matches this text. Only a
   * recent one counts: an old prompt that happened to say the same thing is a
   * different task.
   *
   * @param {string} [prompt]
   * @returns {object|null}
   */
  #telegramPromptFor(prompt) {
    const normalize = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
    const wanted = normalize(prompt);
    if (!wanted) return null;
    for (const active of this.activePrompts.values()) {
      if (active.source !== 'telegram') continue;
      if (Date.now() - active.startedAt > 60000) continue;
      if (normalize(active.prompt) === wanted) return active;
    }
    return null;
  }

  /** @param {{ cancelled: boolean, controller: AbortController, stopTyping: () => void, interrupt?: (() => Promise<boolean>|boolean)|null, source?: string, id: string }} active */
  #cancelPrompt(active) {
    if (active.cancelled) return false;
    active.cancelled = true;
    active.stopTyping?.();
    try {
      active.controller.abort();
    } catch {
      /* already aborted */
    }
    // A prompt the bridge did not start belongs to another runtime: stop it there.
    if (active.interrupt) {
      try {
        Promise.resolve(active.interrupt())
          .then((stopped) => {
            if (!stopped) log.warn(`could not stop the ${active.agent || 'agent'} turn of ${active.sessionId || active.id}`);
          })
          .catch((err) => log.warn(`could not stop the ${active.agent || 'agent'} turn: ${err.message}`));
      } catch (err) {
        log.warn(`could not stop the ${active.agent || 'agent'} turn: ${err.message}`);
      }
    }
    // Its runtime will report the turn ending; keeping the entry would leave
    // /status listing a prompt that was just stopped.
    if (active.source !== 'telegram') this.activePrompts.delete(active.id);
    return true;
  }

  #cancelledPrompt(id, agent) {
    return { handled: true, command: 'prompt', ok: false, cancelled: true, agent, promptId: id };
  }

  /**
   * Handles one Telegram update. Always resolves: a thrown error would make
   * Telegram retry the same update forever.
   *
   * @param {any} update
   */
  async handleUpdate(update) {
    if (this.#isRedelivery(update)) {
      log.debug(`ignored redelivered update ${update?.update_id}`);
      return { handled: false, reason: 'duplicate-update', updateId: update?.update_id };
    }
    try {
      if (update?.callback_query) return await this.handleCallbackQuery(update.callback_query);
      if (update?.message) return await this.handleMessage(update.message);
      return { handled: false };
    } catch (err) {
      log.error(`update handling failed: ${err.message}`);
      return { handled: false, error: err.message };
    }
  }

  /**
   * A slow handler (a prompt runs for minutes) makes Telegram resend the same
   * update. Both the update id and the message identity are remembered so a
   * retry is dropped even when Telegram assigns it a new update id.
   *
   * @param {any} update
   */
  #isRedelivery(update) {
    const message = update?.message;
    const keys = [];
    if (typeof update?.update_id === 'number') keys.push(`u:${update.update_id}`);
    if (message?.message_id !== undefined) keys.push(`m:${message.chat?.id}:${message.message_id}`);
    if (!keys.length) return false;

    const seen = keys.some((key) => this.seenUpdates.has(key));
    for (const key of keys) this.seenUpdates.set(key, Date.now());
    while (this.seenUpdates.size > MAX_SEEN_UPDATES) {
      const oldest = this.seenUpdates.keys().next().value;
      this.seenUpdates.delete(oldest);
    }
    return seen;
  }

  /**
   * Keeps the "typing…" hint alive while a prompt runs. Telegram drops the hint
   * after a few seconds, so it is refreshed on a timer instead of posting
   * "still working" messages that pile up in the chat.
   *
   * The refresh has no deadline of its own: the prompt that owns it stops it when
   * the task really finishes, fails or is cancelled.
   *
   * @param {string|number} chatId
   * @returns {() => void} stops the refresh
   */
  #startTyping(chatId) {
    if (!this.notificationsEnabled || !this.telegram.enabled) return () => {};
    const target = String(chatId ?? this.config.chatIds[0]);
    const ping = () => {
      try {
        Promise.resolve(this.telegram.sendChatAction({ chatId: target })).catch((err) =>
          log.debug(`typing hint failed: ${err.message}`),
        );
      } catch (err) {
        log.debug(`typing hint failed: ${err.message}`);
      }
    };

    ping();
    const timer = setInterval(ping, this.typingIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * A completion reported by the agent hooks means the turn ended and the answer
   * is already in Telegram. The prompt that caused it stops being watched, so its
   * typing hint ends and the answer is not posted a second time later.
   *
   * @param {string} [agent]
   */
  /**
   * Marks the running prompts a completion belongs to as answered, so their
   * typing hint stops and the answer is not posted twice. This is bookkeeping: it
   * happens before the notification checks below, because the turn really did end
   * even when the user asked not to be notified of it.
   *
   * @param {string} agent
   */
  #finishPromptsAnsweredByHook(agent) {
    for (const active of this.activePrompts.values()) {
      if (agent && active.agent && active.agent !== agent) continue;
      active.hookAnswered = true;
      active.stopTyping?.();
    }
  }

  async handleCallbackQuery(query) {
    const chatId = query?.message?.chat?.id;
    if (!this.acceptsChat(chatId)) {
      log.warn(`ignored callback query from chat ${chatId}`);
      return { handled: false, reason: 'chat-not-allowed' };
    }

    const parsed = parseCallbackData(query.data);
    if (!parsed) return { handled: false, reason: 'unknown-callback' };

    const entry = this.pending.getByCode(parsed.id);
    await safeAnswer(this.telegram, query.id, entry ? parsed.label(entry) : 'This request is no longer active.');

    if (!entry) return { handled: false, reason: 'expired' };
    if (parsed.index >= entry.options.length) {
      return { handled: false, reason: 'bad-option' };
    }

    entry.resolve({
      source: 'button',
      answer: entry.options[parsed.index],
      reply: null,
      optionIndex: parsed.index,
      timedOut: false,
    });
    return { handled: true, requestId: entry.id, answer: entry.options[parsed.index] };
  }

  async handleMessage(message) {
    if (message.from?.is_bot) return { handled: false, reason: 'bot-message' };
    const chatId = message.chat?.id;
    if (!this.acceptsChat(chatId)) {
      log.warn(`ignored message from chat ${chatId}`);
      return { handled: false, reason: 'chat-not-allowed' };
    }

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) return { handled: false, reason: 'no-text' };

    const replyToId = message.reply_to_message?.message_id;
    if (replyToId !== undefined) {
      const entry = this.pending.getByMessageId(replyToId);
      if (entry) {
        entry.resolve({ source: 'reply', answer: text, reply: text, optionIndex: null, timedOut: false });
        return { handled: true, requestId: entry.id, answer: text };
      }
    }

    const command = parseCommand(text);
    switch (command.name) {
      case 'start':
      case 'help':
        await this.sendHelp();
        return { handled: true, command: command.name };
      case 'list':
        await this.sendList();
        return { handled: true, command: 'list' };
      case 'status':
        await this.sendStatus();
        return { handled: true, command: 'status' };
      case 'cancel': {
        if (!command.arg || /^(all|\*)$/i.test(command.arg)) {
          const cancelled = this.cancelAll();
          await this.sendText(cancelled ? `Cancelled ${cancelled} ongoing task(s).` : 'No ongoing tasks.');
          return { handled: true, command: 'cancel', ok: cancelled > 0, cancelled };
        }
        const ok = this.cancel(command.arg);
        await this.sendText(ok ? `Cancelled <code>${escapeText(command.arg)}</code>.` : `Nothing is running with id <code>${escapeText(command.arg)}</code>.`);
        return { handled: true, command: 'cancel', ok };
      }
      case 'answer':
        return await this.answerCommand(command.arg);
      case 'option': {
        // `/1` … `/8` pick an option of the newest request, like tapping its
        // button. The number is an option index, not a request id.
        const newest = this.pending.list().at(-1);
        if (!newest) {
          await this.sendText('Nothing is waiting for an answer. Use /list to see running work.');
          return { handled: true, command: 'option', ok: false };
        }
        const picked = Number(command.arg) - 1;
        if (!(picked >= 0 && picked < newest.options.length)) {
          await this.sendText(
            newest.options.length
              ? `That request has ${newest.options.length} option(s): ${newest.options
                  .map((option, index) => `${index + 1}. ${escapeText(truncate(option, 40))}`)
                  .join(' · ')}`
              : 'That request takes a free-text reply, so it has no numbered options.',
          );
          return { handled: true, command: 'option', ok: false };
        }
        return await this.answerOption(newest.id, command.arg);
      }
      default:
        break;
    }

    // A bare number is a shortcut for the newest pending request's option.
    if (/^\d{1,2}$/.test(text)) {
      const newest = this.pending.list().at(-1);
      if (newest) return await this.answerOption(newest.id, text);
    }

    // Anything else can be a prompt for a new agent session, when that is enabled.
    if (this.config.remotePromptEnabled) {
      const running = this.#runningPromptFor(text, message.chat.id);
      if (running) {
        // A second delivery of the same prompt must not start the work twice.
        log.warn(`prompt is already running as ${running.id}; the duplicate was ignored`);
        return { handled: true, command: 'prompt', ok: false, duplicate: true, promptId: running.id };
      }
      return await this.runRemotePrompt(text, message.chat.id);
    }

    return { handled: false, reason: 'no-match' };
  }

  /**
   * @param {string} prompt
   * @param {string|number} chatId
   */
  #runningPromptFor(prompt, chatId) {
    const normalize = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
    const wanted = normalize(prompt);
    for (const active of this.activePrompts.values()) {
      // A turn running in a panel or terminal is the user's own; it must not make
      // the same text sent from Telegram look like a redelivery.
      if (active.source !== 'telegram') continue;
      if (String(active.chatId) !== String(chatId)) continue;
      if (normalize(active.prompt) === wanted) return active;
    }
    return null;
  }

  /**
   * Runs the message as a prompt for the agent that was used last, and posts the
   * answer back to the chat.
   *
   * Copilot, Claude and OpenCode accept a prompt through the editor, where the
   * session is visible. Claude and OpenCode also have their own runtime: Claude
   * falls back to it when Chat will not take the prompt (a bridge outside VS Code,
   * or a window that refuses the command), and OpenCode always runs there because
   * its sidebar has no prompt command yet.
   *
   * @param {string} prompt
   * @param {string|number} chatId
   */
  async runRemotePrompt(prompt, chatId) {
    const agent = this.lastAgent;
    this.promptSeq += 1;
    const id = newPromptId();
    const active = this.#trackPrompt({ id, agent, prompt, chatId });
    log.info(`remote prompt ${id} → ${agent} (${prompt.length} chars)`);

    try {
      // A Claude prompt belongs in the Claude session the user has in front of
      // them, which only the editor can reach; OpenCode has no prompt command, so
      // it runs in its own runtime instead.
      if (agent === 'opencode' || (agent === 'claude' && !this.submitPrompt)) {
        active.stopTyping = this.#startTyping(chatId);
        return await this.#runCliPrompt({ id, prompt, chatId, agent, active });
      }

      if (!this.submitPrompt) {
        // A bridge started from a terminal has no editor to submit to. Say so
        // instead of pretending the prompt was accepted.
        log.warn('a remote prompt arrived, but this bridge is not inside VS Code');
        await this.sendText(
          '✖ Remote prompts need the VS Code extension: start TelegramNotify from VS Code, then send the prompt again.',
          chatId,
        );
        return { handled: true, command: 'prompt', ok: false, agent, error: 'not running inside VS Code' };
      }

      active.stopTyping = this.#startTyping(chatId);
      return await this.#runEditorPrompt({
        id,
        prompt,
        chatId,
        agent,
        active,
        // A window that will not take the prompt (no Chat session on screen, a
        // command that is unavailable) must not swallow it: Claude's own runtime
        // still answers it.
        fallback:
          agent === 'claude'
            ? () => this.#runCliPrompt({ id, prompt, chatId, agent, active })
            : undefined,
      });
    } finally {
      active.stopTyping?.();
      active.stopTyping = () => {};
      this.activePrompts.delete(id);
    }
  }

  /**
   * Runs the prompt through the agent's own runtime and posts the answer.
   *
   * Claude runs through its CLI when the editor will not take the prompt. The CLI
   * is the same runtime the extension drives, so the turn is resumed into the
   * session the panel shows and runs in that session's permission mode (no
   * approval round trip for what the panel would have allowed). Nothing is posted
   * while it runs: the answer arrives in one message when the turn ends, the same
   * way a Copilot answer does.
   *
   * OpenCode prefers its HTTP server, because a turn run there is streamed to the
   * OpenCode sidebar and the desktop app while it happens; `opencode run` is the
   * fallback for when no server answers. Both continue the session the editor has
   * open.
   *
   * @param {{ id: string, prompt: string, chatId: string|number, agent: string, active: any }} input
   */
  async #runCliPrompt({ id, prompt, chatId, agent, active }) {
    const runner = agent === 'opencode' ? this.runOpenCodePrompt : this.runClaudePrompt;
    const product = agent === 'opencode' ? 'OpenCode' : 'Claude Code';
    // Only OpenCode has a session watcher that could report the same turn again.
    const watcher = agent === 'opencode' ? this.openCodeWatcher : null;

    await this.sendText(
      [
        `▶ <b>${escapeText(agent)}</b> is working on your prompt in ${product}.`,
        `<blockquote>${escapeText(truncate(prompt, 300))}</blockquote>`,
        `${product} runs the turn; the session is in its history and can be resumed there.`,
      ].join('\n'),
      chatId,
    );

    const result = await runner({
      prompt,
      cwd: typeof this.defaultCwd === 'function' ? this.defaultCwd() : this.defaultCwd || undefined,
      signal: active.controller.signal,
      // Sessions that another process reports on: an OpenCode turn also reaches the
      // completion watcher, which would otherwise post the same turn twice, and a
      // Claude turn joining the editor's session is the one the panel shows.
      onSession: (sessionId) => {
        watcher?.suppressNextTurn?.(sessionId);
        if (sessionId) active.sessionId = String(sessionId);
      },
      // Put the conversation the turn belongs to on screen, so the prompt is visibly
      // part of that session and the panel is one click from its history.
      onJoined: (sessionId) => {
        if (agent === 'claude' && sessionId) this.#focusClaudeSession(sessionId);
      },
      // A turn that stops to ask something is answered here first, then handed
      // back: with a window the chat offers the same options the editor does, and
      // an unanswered request simply stays in the panel where it already shows.
      // Started, not awaited: the turn must keep being watched while the chat waits.
      onWaiting: (ask) => {
        void this.#answerWaiting({ agent, product, chatId, ask });
      },
    });
    // A run that never produced a turn must not leave the session silenced. One
    // that did — even a failed turn — is answered here, so the watcher must skip it
    // instead of posting the same outcome a second time.
    if (!result.ok && !result.turnSeen) watcher?.resumeReporting?.(result.sessionId);

    if (active.cancelled || result.cancelled) {
      return this.#cancelledPrompt(id, agent);
    }
    if (active.hookAnswered) {
      // A hook already posted the answer; the CLI's output would repeat it.
      log.info(`remote prompt ${id} ended when the ${product} hook reported the turn finished`);
      return { handled: true, command: 'prompt', ok: true, agent, answeredByHook: true, sessionId: result.sessionId };
    }
    if (!result.ok) {
      await this.sendText(
        `✖ <b>${escapeText(agent)}</b> could not complete the prompt:\n${escapeText(truncate(result.error || 'unknown error', 1200))}`,
        chatId,
      );
      return { handled: true, command: 'prompt', ok: false, agent, error: result.error };
    }

    const answer = formatAgentMessages(
      {
        type: 'completed',
        // The heading names the agent that answered, the same way the line below does.
        title: titleForAgent('answered', agent, 'completed'),
        message: result.text,
        // Say where the turn went: a run that joined the editor's session is part of
        // the conversation the panel shows, and one that started its own is a new
        // entry in its history. Without this the prompt looks lost.
        detail: result.resumed
          ? 'This turn was added to the session Claude Code has open, so it is part of that conversation. Claude Code renders a session when it loads it, so reload or reopen that tab to see the turn there.'
          : agent === 'claude'
            ? 'No Claude Code session was open in this folder, so the turn started a new one (see the session list).'
            : '',
      },
      this.config.maxMessageLength,
    );
    try {
      // One message with the finished answer, the same way a Copilot turn is
      // posted: no half-written copy on the way.
      for (const part of answer) await this.telegram.sendMessage({ chatId: String(chatId), text: part });
    } catch (err) {
      log.error(`could not post the prompt answer: ${err.message}`);
      return { handled: true, command: 'prompt', ok: false, agent, error: err.message };
    }

    return {
      handled: true,
      command: 'prompt',
      ok: true,
      agent,
      sessionId: result.sessionId,
      resumed: result.resumed || '',
      permissionMode: result.permissionMode || '',
      answer: result.text,
    };
  }

  /**
   * Waits until the hooks report the turn ended (or the prompt is cancelled), so
   * the typing hint lives as long as the turn does. Bounded: a window without
   * working hooks must not keep a prompt alive forever.
   *
   * @param {{ cancelled: boolean, hookAnswered: boolean }} active
   */
  async #waitForHookAnswer(active) {
    const deadline = Date.now() + CLAUDE_HOOK_WAIT_MS;
    while (!active.cancelled && !active.hookAnswered && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CLAUDE_HOOK_POLL_MS));
    }
  }

  /**
   * Answers a request an agent's own turn is blocked on: Telegram asks first, the
   * agent's own prompt takes over when the window closes.
   *
   * Only OpenCode reaches here — Claude and Copilot decide inside a hook process —
   * and its panel keeps showing the request either way, so a Telegram answer is a
   * second way in rather than a race.
   *
   * @param {{ agent: string, product: string, chatId: string|number, ask: any }} input
   */
  async #answerWaiting({ agent, product, chatId, ask }) {
    const window = this.askWindowSeconds();
    // No window: the panel or terminal is the only place that asks, exactly as the
    // hooks do, so the chat is not given a request it cannot act on.
    if (!window || typeof ask?.reply !== 'function') return;

    const permission = ask.kind === 'permission';
    const options = permission
      ? OPENCODE_PERMISSION_OPTIONS
      : Array.isArray(ask.fields?.[0]?.options)
        ? ask.fields[0].options.slice(0, 6)
        : [];

    const result = await this.notify({
      agent,
      type: permission ? 'permission' : 'question',
      title: truncate(ask.title || `${product} question`, 200),
      message: ask.lines?.length
        ? ask.lines.map((line) => truncate(line, 300)).join('\n')
        : `${product} is waiting for you.`,
      chatId,
      options,
      waitForReply: true,
      timeoutSeconds: window,
      replyPrompt: askReplyPrompt(window, `the ${product} panel asks`),
    });

    const answer = String(result?.answer ?? '').trim();
    if (!answer) {
      // The window closed: the panel still has the request, so nothing else to do.
      log.info(`${product} request ${ask.id} was not answered in the chat; the panel keeps it`);
      return;
    }

    try {
      const answered = await ask.reply(answer, result?.optionIndex ?? null);
      if (!answered) log.info(`${product} request ${ask.id} was answered in the panel first`);
    } catch (err) {
      log.warn(`could not answer ${product} request ${ask.id}: ${err.message}`);
    }
  }

  /**
   * How long the chat may hold a request before the agent's own prompt takes over.
   * 0 when notifications are off: then only the panel or terminal asks.
   *
   * @returns {number}
   */
  askWindowSeconds() {
    if (this.notificationsEnabled === false) return 0;
    const window = Number(this.config.claudeAskWindowSeconds);
    return Number.isFinite(window) && window > 0 ? Math.floor(window) : 0;
  }

  /**
   * Brings the Claude Code session to the front, when the extension host allows it.
   *
   * The turn runs in that session, so opening it is what makes the prompt part of
   * what the user is looking at rather than something invisible.
   *
   * @param {string} sessionId
   */
  #focusClaudeSession(sessionId) {
    if (!this.openAgentSession || this.config.claudeOpenSession === false) return;
    try {
      Promise.resolve(this.openAgentSession({ agent: 'claude', sessionId })).catch((err) =>
        log.debug(`could not open the Claude Code session: ${err.message}`),
      );
    } catch (err) {
      log.debug(`could not open the Claude Code session: ${err.message}`);
    }
  }

  /**
   * Submits the prompt through the editor and tells the chat what happened.
   * The answer stays in the editor, where the session is visible and manageable.
   *
   * @param {{ id: string, prompt: string, chatId: string|number, agent: string, active: any, fallback?: () => Promise<any> }} input
   */
  async #runEditorPrompt({ id, prompt, chatId, agent, active, fallback }) {
    const since = Date.now();
    let submitted;
    try {
      submitted = await this.submitPrompt({ agent, prompt });
    } catch (err) {
      // A submitter that throws is the same as one that refuses: the prompt still
      // has to be answered.
      submitted = { ok: false, outcome: 'unsupported', agent, error: err?.message || String(err) };
    }

    if (active.cancelled) return this.#cancelledPrompt(id, agent);
    if (!submitted.ok && fallback) {
      // Chat would not take it (no session on screen, or the command is missing):
      // the agent's own runtime still answers the prompt.
      log.info(`${agent} could not be submitted to Chat (${submitted.error || 'unknown error'}); using its runtime`);
      return await fallback();
    }
    if (!submitted.ok) {
      await this.sendText(
        `✖ <b>${escapeText(agent)}</b> could not be started from here:\n${escapeText(truncate(submitted.error || 'unknown error', 800))}`,
        chatId,
      );
      return { handled: true, command: 'prompt', ok: false, agent, error: submitted.error };
    }

    const where =
      agent === 'opencode' ? 'the OpenCode sidebar' : 'VS Code Chat (the session is in your Chat list)';

    await this.sendText(
      [
        `▶ <b>${escapeText(agent)}</b> received your prompt in ${escapeText(where)}.`,
        `<blockquote>${escapeText(truncate(prompt, 300))}</blockquote>`,
        submitted.detail ? escapeText(submitted.detail) : '',
      ]
        .filter(Boolean)
        .join('\n'),
      chatId,
    );

    // A Claude turn has no Chat log the bridge can read: its `Stop` hook posts the
    // transcript's complete answer when the turn ends. Waiting for that keeps the
    // typing hint alive for the whole turn and stops the prompt (and its Stop
    // button) from being dropped right after submission.
    if (agent === 'claude') {
      await this.#waitForHookAnswer(active);
      if (active.cancelled) return this.#cancelledPrompt(id, agent);
      return {
        handled: true,
        command: 'prompt',
        ok: true,
        agent,
        submittedInEditor: true,
        ...(active.hookAnswered ? { answeredByHook: true } : { answeredInEditor: true }),
      };
    }

    // VS Code owns the session, and it persists every chat as an operation log;
    // the answer is read from there so it can come back to Telegram too. The
    // session stays visible and resumable in the Chat list either way.
    if (!this.readChatReply) {
      return { handled: true, command: 'prompt', ok: true, agent, outcome: submitted.outcome, submittedInEditor: true, promptId: id };
    }

    // The wait is deliberately unbounded: a long turn is not a failure, and the
    // typing hint keeps the chat informed while it runs. The request's own state
    // (finished, failed, stopped) or a hook completion ends it.
    const reply = await this.readChatReply({
      agent,
      prompt,
      sinceMs: since,
      timeoutMs: 0,
      shouldStop: () => active.cancelled || active.hookAnswered,
    });

    if (active.cancelled) return this.#cancelledPrompt(id, agent);
    if (reply?.unsupported) {
      // The acknowledgement already told the chat where the prompt went; there is
      // nothing to wait for.
      return { handled: true, command: 'prompt', ok: true, agent, submittedInEditor: true, answeredInEditor: true };
    }
    if (active.hookAnswered) {
      // The agent hooks already posted the answer; posting the session text too
      // would duplicate it.
      log.info(`remote prompt ${id} ended when the agent reported the turn finished`);
      return {
        handled: true,
        command: 'prompt',
        ok: true,
        agent,
        submittedInEditor: true,
        answeredByHook: true,
        sessionId: reply?.sessionId,
      };
    }
    if (reply.cancelled) {
      // The Stop button in the Chat ends the request; the prompt is not running
      // any more, so the chat is told rather than left waiting for a timeout.
      log.info(`remote prompt ${id} was stopped in the chat`);
      await this.sendText(USER_CANCELLED_TEXT, chatId);
      return {
        handled: true,
        command: 'prompt',
        ok: false,
        cancelled: true,
        agent,
        submittedInEditor: true,
        sessionId: reply.sessionId,
      };
    }
    if (reply.timedOut) {
      // A bounded wait (the CLI mode) ends with the answer already posted above;
      // a timeout is not an outcome worth a message of its own.
      return { handled: true, command: 'prompt', ok: Boolean(reply.ok), agent, submittedInEditor: true, sessionId: reply.sessionId };
    }
    if (!reply.ok || !reply.text) {
      await this.sendText(
        `ℹ <b>${escapeText(agent)}</b> finished, but the answer could not be read from the Chat session: ${escapeText(truncate(reply.error || 'no text yet', 400))}`,
        chatId,
      );
      return { handled: true, command: 'prompt', ok: Boolean(reply.ok), agent, submittedInEditor: true, sessionId: reply.sessionId };
    }

    const answer = formatAgentMessages(
      { type: 'completed', title: titleForAgent('answered', agent, 'completed'), message: reply.text },
      // No cwd here: the session's own folder is already in the chat, and the heading says
      // which agent answered.
      this.config.maxMessageLength,
    );
    try {
      for (const part of answer) await this.telegram.sendMessage({ chatId: String(chatId), text: part });
    } catch (err) {
      log.error(`could not post the prompt answer: ${err.message}`);
      return { handled: true, command: 'prompt', ok: false, agent, error: err.message };
    }

    return {
      handled: true,
      command: 'prompt',
      ok: true,
      agent,
      submittedInEditor: true,
      sessionId: reply.sessionId,
      answer: reply.text,
    };
  }

  async answerCommand(arg) {
    const [id, ...rest] = String(arg || '').split(/\s+/);
    if (!id || !rest.length) {
      await this.sendText('Usage: <code>/answer &lt;id&gt; &lt;text&gt;</code>');
      return { handled: true, command: 'answer', ok: false };
    }
    const entry = this.pending.getByCode(id);
    if (!entry) {
      await this.sendText(`No pending request <code>${escapeText(id)}</code>. Use /list to see them.`);
      return { handled: true, command: 'answer', ok: false };
    }
    return await this.answerOption(id, rest.join(' '));
  }

  async answerOption(id, text) {
    const entry = this.pending.getByCode(id);
    if (!entry) {
      await this.sendText(`No pending request <code>${escapeText(id)}</code>. Use /list to see them.`);
      return { handled: true, ok: false };
    }
    const index = Number(text) - 1;
    if (Number.isInteger(index) && index >= 0 && index < entry.options.length) {
      entry.resolve({ source: 'button', answer: entry.options[index], reply: null, optionIndex: index, timedOut: false });
      return { handled: true, requestId: entry.id, answer: entry.options[index] };
    }
    entry.resolve({ source: 'reply', answer: text, reply: text, optionIndex: null, timedOut: false });
    return { handled: true, requestId: entry.id, answer: text };
  }

  /**
   * @param {string} html
   * @param {string|number} [chatId] defaults to the first configured chat
   */
  async sendText(html, chatId) {
    try {
      await this.telegram.sendMessage({ chatId: String(chatId ?? this.config.chatIds[0]), text: html });
    } catch (err) {
      log.error(`sendMessage failed: ${err.message}`);
    }
  }

  async sendHelp() {
    const lines = [
      '<b>TelegramNotify</b>',
      'Replies reach the agent that raised the request.',
      '',
      '/list — pending requests',
      '/status — bridge status',
      '/answer &lt;id&gt; &lt;text&gt; — answer by id',
      '/1 … /8 — pick an option on the latest request',
      '/cancel &lt;id&gt; — stop waiting and return to the agent',
      '/cancel all — stop every waiting request and running prompt',
      '',
      'Or reply to the notification message. Requests expire after the configured timeout.',
    ];
    if (this.config.remotePromptEnabled) {
      lines.push(
        '',
        `Any other message is sent as a prompt to <b>${escapeText(agentLabel(this.lastAgent))}</b> in VS Code Chat.`,
      );
    }
    await this.sendText(lines.join('\n'));
  }

  async sendList() {
    const pending = this.pending.list();
    const running = [...this.activePrompts.values()];
    if (!pending.length && !running.length) {
      await this.sendText('No ongoing tasks.');
      return;
    }
    const lines = pending.map(
      (item) =>
        `<code>${item.id}</code> ${escapeText(item.agent || 'agent')} · ${escapeText(item.type)} · ${
          item.title ? escapeText(truncate(item.title, 60)) : '—'
        } · ${item.expiresInSeconds}s left`,
    );
    const runningLines = running.map((item) => {
      // Say where the prompt came from: one the panel or terminal started cannot be
      // resumed from here, but it is work in progress all the same.
      const origin = item.source === 'telegram' ? 'prompt' : item.source === 'external' ? 'panel/terminal' : 'prompt';
      return `<code>${item.id}</code> ${escapeText(item.agent || 'agent')} · ${origin} · ${escapeText(
        truncate(item.prompt || '—', 60),
      )} · ${Math.round((Date.now() - item.startedAt) / 1000)}s`;
    });
    await this.sendText(
      [
        ...(lines.length ? ['<b>Waiting for an answer</b>', ...lines] : []),
        ...(runningLines.length ? ['<b>Running prompts</b>', ...runningLines] : []),
        '',
        'Use <code>/cancel all</code> to stop everything.',
      ].join('\n'),
    );
  }

  async sendStatus() {
    const agents = Object.entries(this.config.agents)
      .map(([name, on]) => `${name}: ${on ? 'on' : 'off'}`)
      .join(' · ');
    await this.sendText(
      [
        '<b>TelegramNotify status</b>',
        `ready: ${this.ready ? 'yes' : 'no'}`,
        `port: ${this.config.webhookPort}`,
        `pending: ${this.pending.size}`,
        `running prompts: ${this.activePrompts.size}`,
        `agents: ${agents}`,
        ...(this.config.remotePromptEnabled ? [`prompt agent: ${escapeText(agentLabel(this.lastAgent))}`] : []),
      ].join('\n'),
    );
  }
}

/**
 * How an agent is named in the chat. The event names stay lowercase (`local`,
 * `copilot`), so a reader sees the same word `/list` shows.
 *
 * @param {string} agent
 * @returns {string}
 */
function agentLabel(agent) {
  return String(agent || 'agent');
}

/** The display name of an agent, for a notification title. */
const AGENT_TITLES = {
  local: 'Local agent',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  claude: 'Claude Code',
};

/** Phrases that read naturally straight after an agent's name. */
const NATURAL_SUFFIX = new Set([
  'finished',
  'error',
  'needs attention',
  'received a prompt',
  'continued the task on its own',
  'needs your answer',
  'task completed',
  'done',
  'answered',
]);

/**
 * A title that names the agent that reported the event.
 *
 * A hook sends its own title ("Copilot finished"), which is wrong for a local harness
 * reusing the adapter. The title is rebuilt from the agent, so the heading and the
 * `agent: …` line of a message always agree.
 *
 * @param {string} [title]
 * @param {string} [agent]
 * @param {string} [type]
 * @returns {string}
 */
export function titleForAgent(title, agent, type) {
  const name = String(agent || '').trim().toLowerCase();
  const text = String(title || '').trim();
  const display = AGENT_TITLES[name];
  if (!display) return text || TYPE_HINTS[type] || 'TelegramNotify';

  // A title that already names this agent is kept as written.
  if (text.toLowerCase().startsWith(display.toLowerCase())) return text;

  // A title naming another agent is rebuilt around this one, keeping the rest.
  const other = /\b(copilot|local agent|opencode|claude code)\b/i.exec(text);
  const rest = other ? text.slice(other.index + other[0].length).trim() : text;
  if (other) return `${display}${rest ? ` ${rest}` : ''}`;
  if (!text) return `${display} ${TYPE_HINTS[type] || 'update'}`;
  // "finished" and friends read as a sentence after the name; anything else is joined.
  return NATURAL_SUFFIX.has(text.toLowerCase()) ? `${display} ${text}` : `${display} — ${text}`;
}

/** The default title for a notification type when the agent sends none. */
const TYPE_HINTS = {
  completed: 'finished',
  error: 'error',
  question: 'question',
  permission: 'needs approval',
  info: 'update',
};
function escapeText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function safeAnswer(telegram, callbackQueryId, text) {
  try {
    await telegram.answerCallbackQuery({ callbackQueryId, text });
  } catch (err) {
    log.debug(`answerCallbackQuery failed: ${err.message}`);
  }
}

export function optionKeyboard(id, options) {
  return {
    inline_keyboard: options.map((option, index) => [
      { text: `${index + 1}. ${truncate(option, 48)}`, callback_data: `tn:${id}:${index}` },
    ]),
  };
}

/**
 * @param {string} data
 */
export function parseCallbackData(data) {
  const match = /^tn:([0-9a-f]{8}):(\d)$/i.exec(String(data || ''));
  if (!match) return null;
  const index = Number(match[2]);
  return {
    id: match[1],
    index,
    label(entry) {
      const option = entry.options[index];
      return option ? `Selected: ${truncate(option, 180)}` : 'Unknown option.';
    },
  };
}

/**
 * @param {string} text
 */
export function parseCommand(text) {
  const numeric = /^\/(\d{1,2})(?:@\w+)?$/.exec(text);
  if (numeric) return { name: 'option', arg: numeric[1], text: numeric[1] };

  const match = /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { name: '', arg: '', text: '' };
  return { name: match[1].toLowerCase(), arg: (match[2] || '').trim(), text: (match[2] || '').trim() };
}
