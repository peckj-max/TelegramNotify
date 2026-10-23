import { formatAgentMessage, formatDuration, formatResolution, truncate } from './message.mjs';
import { PendingRequests } from './pending.mjs';
import { TelegramClient } from './telegram.mjs';
import { log } from './logger.mjs';

const TYPES = new Set(['question', 'permission', 'completed', 'info', 'error']);
const MAX_PENDING = 50;

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
 * Turns agent events into Telegram messages and routes answers back.
 */
export class Notifier {
  /**
   * @param {import('./config.mjs').RuntimeConfig} config
   * @param {{ telegram?: TelegramClient, pending?: PendingRequests }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.telegram = deps.telegram ?? new TelegramClient(config);
    this.pending = deps.pending ?? new PendingRequests();
  }

  get ready() {
    return this.telegram.enabled && this.config.chatIds.length > 0;
  }

  /** Notifications are switched off: send nothing, and answer nothing. */
  get notificationsEnabled() {
    return this.config.notificationsEnabled !== false;
  }

  /** @param {string|number} chatId */
  acceptsChat(chatId) {
    return this.config.chatIds.includes(String(chatId));
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
    const text = formatAgentMessage(
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

    let sent;
    try {
      sent = await this.telegram.sendMessage({
        chatId,
        text,
        replyMarkup: entry && options.length ? optionKeyboard(entry.id, options) : undefined,
      });
    } catch (err) {
      log.error(`sendMessage failed: ${err.message}`);
      entry?.resolve({ source: 'cancelled', answer: null, reply: null, optionIndex: null, timedOut: false });
      return { ok: false, reason: 'telegram-error', error: err.message };
    }

    if (!entry) return { ok: true, messageId: sent.message_id, chatId };

    this.pending.attachMessage(entry.id, sent.message_id);
    log.debug(`waiting for ${entry.id} (${type}, ${timeoutSeconds}s)`);

    const resolution = await entry.wait;
    const footer =
      resolution.source === 'timeout'
        ? `⌛ no answer after ${formatDuration(timeoutSeconds)}`
        : resolution.source === 'cancelled'
          ? '✖ cancelled'
          : formatResolution(resolution);

    await this.telegram.tryEditMessageText({
      chatId,
      messageId: sent.message_id,
      text: `${text}\n\n${footer}`,
      replyMarkup: resolution.source === 'timeout' ? undefined : { inline_keyboard: [] },
    });

    return {
      ok: true,
      requestId: entry.id,
      messageId: sent.message_id,
      chatId,
      source: resolution.source,
      answer: resolution.answer ?? null,
      reply: resolution.reply ?? null,
      optionIndex: resolution.optionIndex ?? null,
      timedOut: resolution.source === 'timeout',
    };
  }

  /** @param {string} requestId */
  cancel(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve({ source: 'cancelled', answer: null, reply: null, optionIndex: null, timedOut: false });
    return true;
  }

  /**
   * Handles one Telegram update. Always resolves: a thrown error would make
   * Telegram retry the same update forever.
   *
   * @param {any} update
   */
  async handleUpdate(update) {
    try {
      if (update?.callback_query) return await this.handleCallbackQuery(update.callback_query);
      if (update?.message) return await this.handleMessage(update.message);
      return { handled: false };
    } catch (err) {
      log.error(`update handling failed: ${err.message}`);
      return { handled: false, error: err.message };
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
        if (!command.arg) {
          await this.sendText('Usage: <code>/cancel &lt;id&gt;</code>');
          return { handled: true, command: 'cancel', ok: false };
        }
        const ok = this.cancel(command.arg);
        await this.sendText(ok ? `Cancelled <code>${escapeText(command.arg)}</code>.` : `No pending request <code>${escapeText(command.arg)}</code>.`);
        return { handled: true, command: 'cancel', ok };
      }
      case 'answer':
        return await this.answerCommand(command.arg);
      case 'option':
        return await this.answerOption(command.arg, command.text);
      default:
        break;
    }

    // A bare number is a shortcut for the newest pending request's option.
    if (/^\d{1,2}$/.test(text)) {
      const newest = this.pending.list().at(-1);
      if (newest) return await this.answerOption(newest.id, text);
    }

    return { handled: false, reason: 'no-match' };
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

  async sendText(html) {
    try {
      await this.telegram.sendMessage({ chatId: this.config.chatIds[0], text: html });
    } catch (err) {
      log.error(`sendMessage failed: ${err.message}`);
    }
  }

  async sendHelp() {
    await this.sendText(
      [
        '<b>TelegramNotify</b>',
        'Replies reach the agent that raised the request.',
        '',
        '/list — pending requests',
        '/status — bridge status',
        '/answer &lt;id&gt; &lt;text&gt; — answer by id',
        '/1 … /8 — pick an option on the latest request',
        '/cancel &lt;id&gt; — stop waiting and return to the agent',
        '',
        'Or reply to the notification message. Requests expire after the configured timeout.',
      ].join('\n'),
    );
  }

  async sendList() {
    const pending = this.pending.list();
    if (!pending.length) {
      await this.sendText('No pending requests.');
      return;
    }
    const lines = pending.map(
      (item) =>
        `<code>${item.id}</code> ${escapeText(item.agent || 'agent')} · ${escapeText(item.type)} · ${
          item.title ? escapeText(truncate(item.title, 60)) : '—'
        } · ${item.expiresInSeconds}s left`,
    );
    await this.sendText(['<b>Pending requests</b>', ...lines].join('\n'));
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
        `agents: ${agents}`,
      ].join('\n'),
    );
  }
}

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
