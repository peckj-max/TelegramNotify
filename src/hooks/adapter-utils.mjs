import { localApiUrl, loadConfigForHooks } from '../config.mjs';
import { log } from '../logger.mjs';

/**
 * Reads the JSON payload an agent hook receives on stdin. Hooks are also
 * invoked by hand during setup, so empty stdin must not throw.
 *
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<any>}
 */
export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Posts an event to the bridge. Returns null when the bridge is not running,
 * which callers treat as "no answer available".
 *
 * @param {'copilot'|'claude'|'opencode'} agent
 * @param {object} payload
 * @param {{ timeoutMs?: number, config?: import('../config.mjs').RuntimeConfig }} [options]
 */
export async function postEvent(agent, payload, options = {}) {
  const config = options.config ?? loadConfigForHooks();
  const base = localApiUrl(config);
  const timeoutMs = options.timeoutMs ?? Math.max(5000, (config.replyTimeoutSeconds + 30) * 1000);

  try {
    const response = await fetch(`${base}/event/${agent}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      log.warn(`bridge rejected ${agent} event (${response.status}): ${data.error || 'no details'}`);
      return null;
    }
    return data;
  } catch (err) {
    log.warn(`bridge unreachable at ${base}: ${err.message}`);
    return null;
  }
}

/**
 * @param {any} value
 * @param {number} limit
 */
export function shorten(value, limit = 4000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Writes a hook result and exits. Agent hooks must never fail loudly: a crash
 * in a notification hook would break the turn it is reporting on.
 *
 * @param {object|null} payload
 * @param {{ code?: number }} [options]
 */
export function finish(payload, options = {}) {
  const code = options.code ?? 0;
  try {
    if (payload !== null && payload !== undefined) process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    log.error(`could not write hook output: ${err.message}`);
  }
  process.exit(code);
}
