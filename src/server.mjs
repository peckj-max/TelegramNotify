import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AGENTS, isAgentEnabled } from './config.mjs';
import { HttpError } from './errors.mjs';
import { Notifier } from './notifier.mjs';
import { PollingReceiver } from './polling.mjs';
import { log } from './logger.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;

/**
 * @param {import('./config.mjs').RuntimeConfig} config
 * @param {{ notifier?: Notifier, polling?: PollingReceiver }} [deps]
 */
export function createServer(config, deps = {}) {
  const notifier = deps.notifier ?? new Notifier(config);
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    handle(req, res, config, notifier, startedAt, deps.polling ?? null).catch((err) => {
      log.error(`unhandled request error: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    });
  });

  server.requestTimeout = 0;
  return server;
}

/**
 * Starts the loopback side (agent API + optional webhook) and, when the webhook
 * is switched off, the long-polling receiver that replaces it.
 *
 * @param {import('./config.mjs').RuntimeConfig} config
 * @param {{ notifier?: Notifier }} [deps]
 */
export function startServer(config, deps = {}) {
  const notifier = deps.notifier ?? new Notifier(config);
  const polling = new PollingReceiver({
    telegram: notifier.telegram,
    onUpdate: (update) => notifier.handleUpdate(update),
    timeoutSeconds: config.pollingTimeoutSeconds,
  });
  const server = createServer(config, { notifier, polling });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.webhookPort, config.webhookHost, async () => {
      server.off('error', reject);
      const address = server.address();

      if (config.webhookEnabled === true) {
        log.info(`webhook mode: Telegram posts to ${config.webhookPath} on port ${address.port}`);
      } else {
        await polling.start({ clearWebhook: true });
        log.info(`polling mode: the webhook is off, updates are pulled from the Bot API`);
      }

      resolve({
        server,
        notifier,
        polling,
        address,
        close: () => closeServer(server, notifier, polling),
      });
    });
  });
}

/**
 * @param {import('node:http').Server} server
 * @param {Notifier} notifier
 * @param {PollingReceiver} [polling]
 */
export function closeServer(server, notifier, polling) {
  // Stopping the bridge must also stop prompts that are still being watched;
  // otherwise their progress heartbeats outlive the bridge.
  notifier.cancelAll('shutdown');
  polling?.stop();
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function handle(req, res, config, notifier, startedAt, polling) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  if (pathname === '/health' && method === 'GET') {
    return sendJson(res, 200, describeHealth(config, notifier, startedAt, isLoopback(req), polling));
  }

  if (isWebhookPath(pathname, config)) {
    // With polling on, Telegram is not allowed to post here: a stale webhook
    // call must not be mistaken for a live delivery path.
    if (config.webhookEnabled !== true) {
      return sendJson(res, 409, { ok: false, error: 'webhook is disabled; updates are received by polling' });
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return await handleWebhook(req, res, config, notifier);
  }

  if (pathname === '/event' || pathname.startsWith('/event/')) {
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local requests only' });
    return await handleEvent(req, res, config, notifier, pathname);
  }

  if (pathname === '/notify' && method === 'POST') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local requests only' });
    return await handleNotify(req, res, notifier);
  }

  if (pathname === '/pending' && method === 'GET') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local requests only' });
    return sendJson(res, 200, {
      ok: true,
      pending: notifier.pending.list(),
      running: [...notifier.activePrompts.values()].map((item) => ({
        id: item.id,
        agent: item.agent,
        startedAt: item.startedAt,
      })),
    });
  }

  if (pathname === '/tasks/cancel' && method === 'POST') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local requests only' });
    return sendJson(res, 200, { ok: true, cancelled: notifier.cancelAll('cancelled') });
  }

  const cancelMatch = /^\/pending\/([0-9a-zA-Z-]{4,32})\/cancel$/.exec(pathname);
  if (cancelMatch && method === 'POST') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'local requests only' });
    const cancelled = notifier.cancel(cancelMatch[1]);
    return sendJson(res, cancelled ? 200 : 404, { ok: cancelled, requestId: cancelMatch[1] });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

function describeHealth(config, notifier, startedAt, local, polling) {
  return {
    ok: true,
    ready: notifier.ready,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    port: config.webhookPort,
    host: config.webhookHost,
    webhookPath: config.webhookPath,
    webhookEnabled: config.webhookEnabled === true,
    delivery: config.webhookEnabled === true ? 'webhook' : 'polling',
    polling: polling ? polling.status() : null,
    agents: config.agents,
    pending: notifier.pending.size,
    ...(local ? { configFile: config.sourcePath } : {}),
  };
}

function isWebhookPath(pathname, config) {
  return pathname === config.webhookPath || pathname === '/telegram/webhook' || pathname === '/webhook';
}

async function handleWebhook(req, res, config, notifier) {
  if (!validateSecret(req, config.webhookSecretToken)) {
    log.warn('rejected webhook call with a bad secret token');
    return sendJson(res, 401, { ok: false, error: 'invalid secret token' });
  }

  let update;
  try {
    update = await readJson(req, MAX_BODY_BYTES);
  } catch (err) {
    return sendJson(res, err instanceof HttpError ? err.status : 400, { ok: false, error: err.message });
  }
  if (!update || typeof update !== 'object') {
    return sendJson(res, 400, { ok: false, error: 'invalid update' });
  }

  // A prompt runs for minutes, but Telegram only waits a few seconds for this
  // answer and then redelivers the update — which started the same prompt again
  // and again. Acknowledge first, then handle it once, out of band.
  sendJson(res, 200, { ok: true, accepted: true });

  Promise.resolve()
    .then(() => notifier.handleUpdate(update))
    .catch((err) => log.error(`webhook update failed: ${err.message}`));
}

async function handleEvent(req, res, config, notifier, pathname) {
  let body;
  try {
    body = await readJson(req, MAX_EVENT_BYTES);
  } catch (err) {
    return sendJson(res, err instanceof HttpError ? err.status : 400, { ok: false, error: err.message });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, error: 'event body must be a JSON object' });
  }

  const agent = String(pathname.slice('/event'.length).replace(/^\/+/, '') || body.agent || '').toLowerCase();
  if (!AGENTS.includes(agent)) {
    return sendJson(res, 400, { ok: false, error: `unknown agent "${agent}"; expected one of ${AGENTS.join(', ')}` });
  }
  if (!isAgentEnabled(config, agent)) {
    log.debug(`event for disabled agent ${agent} ignored`);
    return sendJson(res, 202, { ok: true, skipped: true, reason: 'agent-disabled', agent });
  }

  try {
    const result = await notifier.notify({ ...body, agent });
    return sendJson(res, 200, { ...result, agent, text: result.answer ?? result.reply ?? null });
  } catch (err) {
    log.error(`event for ${agent} failed: ${err.message}`);
    return sendJson(res, 502, { ok: false, error: err.message, agent });
  }
}

async function handleNotify(req, res, notifier) {
  try {
    const body = await readJson(req, MAX_EVENT_BYTES);
    const result = await notifier.notify(body || {});
    return sendJson(res, 200, { ...result, text: result.answer ?? result.reply ?? null });
  } catch (err) {
    return sendJson(res, err instanceof HttpError ? err.status : 400, { ok: false, error: err.message });
  }
}

/**
 * Telegram echoes the configured secret in this header on every call.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} expected
 */
export function validateSecret(req, expected) {
  if (!expected) return false;
  const header = req.headers['x-telegram-bot-api-secret-token'];
  const received = Array.isArray(header) ? header[0] : header;
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/** @param {import('node:http').IncomingMessage} req */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress || '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === 'localhost'
  );
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 */
export function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return reject(new HttpError(400, 'request body is required'));
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
