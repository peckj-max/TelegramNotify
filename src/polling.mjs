import { log } from './logger.mjs';

const RETRY_MIN_INTERVAL_MS = 200;

/**
 * Long polling as an alternative to the public webhook.
 *
 * Telegram allows one delivery method at a time: a registered webhook wins and
 * `getUpdates` answers 409. So the receiver takes over the bot by deleting the
 * webhook, and hands it back when stopped.
 */
export class PollingReceiver {
  /**
   * @param {object} options
   * @param {import('./telegram.mjs').TelegramClient} options.telegram
   * @param {(update: unknown) => Promise<unknown>} options.onUpdate
   * @param {number} [options.timeoutSeconds] Telegram's own wait per call
   * @param {number} [options.retryDelayMs]
   */
  constructor({ telegram, onUpdate, timeoutSeconds = 25, retryDelayMs = 3000 }) {
    this.telegram = telegram;
    this.onUpdate = onUpdate;
    this.timeoutSeconds = Math.min(Math.max(1, timeoutSeconds), 50);
    this.retryDelayMs = retryDelayMs;

    this.running = false;
    this.offset = 0;
    this.loop = null;
    this.handled = 0;
    this.errors = 0;
    this.lastError = null;
    this.lastUpdateAt = null;
  }

  get active() {
    return this.running;
  }

  /**
   * @param {{ clearWebhook?: boolean }} [options]
   */
  async start(options = {}) {
    if (this.running) return this;

    if (options.clearWebhook) {
      try {
        await this.telegram.deleteWebhook();
        log.info('webhook removed; Telegram will deliver updates to long polling');
      } catch (err) {
        log.warn(`could not remove the webhook before polling: ${err.message}`);
      }
    }

    this.running = true;
    this.loop = this.#run();
    return this;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    try {
      await this.loop;
    } catch {
      /* the loop swallows its own errors */
    }
    this.loop = null;
    log.info(`polling stopped after ${this.handled} update(s)`);
  }

  status() {
    return {
      active: this.running,
      handled: this.handled,
      errors: this.errors,
      lastError: this.lastError,
      lastUpdateAt: this.lastUpdateAt,
      offset: this.offset,
    };
  }

  async #run() {
    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates({ offset: this.offset, timeout: this.timeoutSeconds });
        if (!Array.isArray(updates)) continue;

        for (const update of updates) {
          // Advance before handling: a crash must not replay the same update.
          if (typeof update?.update_id === 'number') this.offset = update.update_id + 1;
          this.handled += 1;
          this.lastUpdateAt = new Date().toISOString();
          try {
            await this.onUpdate(update);
          } catch (err) {
            log.error(`polling handler failed: ${err.message}`);
          }
        }

        // getUpdates normally blocks for `timeout` seconds. When something in
        // front of it answers immediately (a proxy, timeout 0), a tight loop
        // would spin on microtasks and starve every timer in the process.
        if (!updates.length) await this.#sleep(RETRY_MIN_INTERVAL_MS);
        this.lastError = null;
      } catch (err) {
        if (!this.running) break;
        this.errors += 1;
        this.lastError = err.message;

        if (/409/.test(err.message)) {
          this.lastError = 'a webhook is registered, so getUpdates is refused (409) — disable the webhook first';
          log.error(`polling stopped: ${this.lastError}`);
          this.running = false;
          break;
        }

        log.warn(`polling error: ${err.message}`);
        await this.#sleep(this.retryDelayMs);
      }
    }
  }

  /**
   * @param {number} ms
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
