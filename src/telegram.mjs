import http from 'node:http';
import https from 'node:https';
import { TelegramError } from './errors.mjs';
import { log } from './logger.mjs';

const API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 45000;

/**
 * Concurrency matters here: long polling holds one request open for up to
 * `pollingTimeoutSeconds`, while answers and notifications must still go out.
 * Node's global `fetch` serialises requests to the same origin, which made every
 * send wait for the poll to return, so the Bot API is called over `node:http(s)`
 * with an explicit socket pool instead.
 *
 * `TELEGRAM_NOTIFY_API_BASE` points the client at a local Bot API server or a
 * test double; it defaults to the public API.
 */
export class TelegramClient {
  /**
   * @param {{ botToken: string }} config
   * @param {{ baseUrl?: string, maxSockets?: number }} [options]
   */
  constructor(config, options = {}) {
    this.botToken = config.botToken;
    this.baseUrl = (options.baseUrl ?? process.env.TELEGRAM_NOTIFY_API_BASE ?? API_BASE).replace(/\/+$/, '');
    const maxSockets = options.maxSockets ?? 8;
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets });
  }

  get enabled() {
    return Boolean(this.botToken);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [payload]
   * @param {{ timeoutMs?: number }} [options]
   */
  async call(method, payload = {}, options = {}) {
    if (!this.botToken) throw new TelegramError(method, 0, 'bot token is not configured');
    const url = `${this.baseUrl}/bot${this.botToken}/${method}`;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

    let response;
    try {
      response = await this.#post(url, payload, timeoutMs);
    } catch (err) {
      throw new TelegramError(method, 0, err?.message || 'network error');
    }

    let body;
    try {
      body = JSON.parse(response.text);
    } catch {
      throw new TelegramError(method, response.status, 'response was not JSON');
    }

    if (response.status < 200 || response.status >= 300 || body.ok !== true) {
      const description = body?.description || `HTTP ${response.status}`;
      throw new TelegramError(method, response.status, description);
    }
    return body.result;
  }

  /**
   * @param {string} url
   * @param {unknown} payload
   * @param {number} timeoutMs
   * @returns {Promise<{ status: number, text: string }>}
   */
  #post(url, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const secure = target.protocol !== 'http:';
      const transport = secure ? https : http;
      const agent = secure ? this.httpsAgent : this.httpAgent;
      const body = Buffer.from(JSON.stringify(payload), 'utf8');

      const request = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          agent,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
          response.on('error', reject);
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`timed out after ${timeoutMs}ms`));
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  /** Releases the pooled sockets, used by tests and shutdown. */
  close() {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /** @param {{chatId: string, text: string, replyMarkup?: unknown}} message */
  sendMessage({ chatId, text, replyMarkup }) {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    return this.call('sendMessage', payload);
  }

  /** @param {{chatId: string, messageId: number, text: string, replyMarkup?: unknown}} message */
  editMessageText({ chatId, messageId, text, replyMarkup }) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (replyMarkup !== undefined) payload.reply_markup = replyMarkup;
    return this.call('editMessageText', payload);
  }

  answerCallbackQuery({ callbackQueryId, text }) {
    const payload = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;
    return this.call('answerCallbackQuery', payload);
  }

  /**
   * Registers the webhook and returns Telegram's description of it.
   *
   * @param {{ url: string, secretToken: string, dropPendingUpdates?: boolean }} options
   */
  async setWebhook({ url, secretToken, dropPendingUpdates = false }) {
    const payload = {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: dropPendingUpdates,
      max_connections: 10,
    };
    await this.call('setWebhook', payload);
    return this.getWebhookInfo();
  }

  deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo', {});
  }

  /**
   * Long polling, used when the webhook is switched off. Returns only the
   * updates newer than `offset`; `timeout` is Telegram's own wait in seconds.
   *
   * Telegram holds the request open for `timeout` seconds, so the client
   * timeout has to be longer than the poll itself.
   *
   * @param {{ offset?: number, timeout?: number }} [options]
   */
  async getUpdates({ offset = 0, timeout = 25 } = {}) {
    return this.call(
      'getUpdates',
      {
        offset,
        timeout,
        allowed_updates: ['message', 'callback_query'],
      },
      { timeoutMs: (timeout + 25) * 1000 },
    );
  }

  getMe() {
    return this.call('getMe', {});
  }

  /**
   * Best-effort message edit. Edits fail when the text did not change or the
   * message is too old, which must not surface as a hook failure.
   *
   * @param {{chatId: string, messageId: number, text: string, replyMarkup?: unknown}} message
   */
  async tryEditMessageText(message) {
    try {
      return await this.editMessageText(message);
    } catch (err) {
      log.debug(`editMessageText skipped: ${err.message}`);
      return null;
    }
  }
}
