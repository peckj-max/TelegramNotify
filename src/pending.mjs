import { randomUUID } from 'node:crypto';

/**
 * Requests waiting for a human answer, keyed by both the internal id and the
 * Telegram message that carries the buttons, so a plain reply matches too.
 */
export class PendingRequests {
  constructor() {
    this.byId = new Map();
    this.byMessageId = new Map();
    this.byCode = new Map();
  }

  get size() {
    return this.byId.size;
  }

  /**
   * @param {{ agent: string, type: string, chatId: string, options?: string[], timeoutSeconds: number, title?: string }} request
   * @returns {{ wait: Promise<Resolution>, resolve: (r: Resolution) => void, id: string }}
   */
  create(request) {
    const id = randomUUID().slice(0, 8);
    const code = id;
    /** @type {Resolution|undefined} */
    let settled;
    let resolveFn = (_value) => {};
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    const entry = {
      id,
      code,
      agent: request.agent,
      type: request.type,
      chatId: request.chatId,
      title: request.title ?? '',
      options: request.options ?? [],
      createdAt: Date.now(),
      messageId: null,
      timer: null,
      settled: false,
      detail: '',
    };

    const finish = (resolution) => {
      if (entry.settled) return;
      entry.settled = true;
      settled = { ...resolution, id };
      if (entry.timer) clearTimeout(entry.timer);
      this.byId.delete(id);
      this.byCode.delete(code);
      if (entry.messageId !== null) this.byMessageId.delete(entry.messageId);
      resolveFn(settled);
    };

    entry.resolve = finish;
    entry.wait = promise;
    entry.timeoutSeconds = request.timeoutSeconds;
    entry.timer = setTimeout(() => {
      finish({ source: 'timeout', answer: null, reply: null, optionIndex: null, timedOut: true });
    }, Math.max(1, request.timeoutSeconds) * 1000);

    this.byId.set(id, entry);
    this.byCode.set(code, entry);
    return entry;
  }

  /**
   * @param {string} id
   * @param {number|null} [messageId]
   */
  attachMessage(id, messageId) {
    const entry = this.byId.get(id);
    if (!entry || messageId === null || messageId === undefined) return;
    entry.messageId = messageId;
    this.byMessageId.set(messageId, entry);
  }

  /**
   * @param {string} id
   */
  get(id) {
    return this.byId.get(id) ?? this.byCode.get(id) ?? null;
  }

  /**
   * @param {string} key
   */
  getByCode(key) {
    return this.byCode.get(key) ?? null;
  }

  /**
   * @param {number} messageId
   */
  getByMessageId(messageId) {
    return this.byMessageId.get(messageId) ?? null;
  }

  list() {
    return [...this.byId.values()].map((entry) => ({
      id: entry.id,
      agent: entry.agent,
      type: entry.type,
      title: entry.title,
      chatId: entry.chatId,
      messageId: entry.messageId,
      options: entry.options,
      waitingSeconds: Math.round((Date.now() - entry.createdAt) / 1000),
      expiresInSeconds: Math.max(0, entry.timeoutSeconds - Math.round((Date.now() - entry.createdAt) / 1000)),
    }));
  }

  /** Settles every pending request, used on shutdown. */
  cancelAll(reason = 'cancelled') {
    for (const entry of [...this.byId.values()]) {
      entry.resolve({ source: reason, answer: null, reply: null, timedOut: false });
    }
  }
}

/**
 * @typedef {{ source: 'reply'|'button'|'timeout'|'cancelled'|'shutdown', answer: string|null, reply: string|null, optionIndex: number|null, timedOut: boolean, id?: string }} Resolution
 */
