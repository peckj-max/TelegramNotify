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
 * The readable text of an error a host reported.
 *
 * Every host sends something different — a string, an `Error`-shaped object
 * (`{ name, message, stack }`), or a message that is itself JSON
 * (`{"message":"Cannot have more than 128 tools per request.","type":"api_error"}`).
 * Passing the object on would reach the chat as `[object Object]`, which says nothing,
 * so the message inside it is used and unwrapped.
 *
 * @param {any} error
 * @param {string} [fallback]
 * @returns {string}
 */
export function errorTextOf(error, fallback = '') {
  const text = unwrapMessage(error);
  return text || fallback;
}

/**
 * @param {any} value
 * @returns {string}
 */
function unwrapMessage(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return unwrapJsonMessage(value.trim());
  if (value instanceof Error) return unwrapJsonMessage(String(value.message || '').trim()) || String(value.name || '');
  if (typeof value !== 'object') return String(value);

  const inner = value.message ?? value.error ?? value.reason ?? value.description ?? value.cause;
  const text = unwrapMessage(inner);
  if (text) return text;
  // No message field: a short JSON rendering beats "[object Object]".
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A message that is JSON (`{"message":"…","type":"api_error"}`) reads as the message it
 * carries; anything else is returned unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
function unwrapJsonMessage(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) return text;
  try {
    const parsed = JSON.parse(text);
    const inner = parsed?.message ?? parsed?.error?.message ?? parsed?.error;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
  } catch {
    /* not JSON after all */
  }
  return text;
}

/**
 * Which harness sent a Copilot-style hook payload.
 *
 * Two harnesses run these hooks with the same command line, so the argument cannot tell
 * them apart and neither can the transcript's contents:
 *
 * - **Copilot** (the agent host) sends camelCase fields — `sessionId`,
 *   `transcriptPath`, `stopReason` — and keeps its session under
 *   `~/.copilot/session-state/<id>/events.jsonl`.
 * - **Local harness** (VS Code's in-process Copilot Chat agent) sends the Claude-style
 *   snake_case fields — `hook_event_name`, `session_id`, `transcript_path` — and keeps
 *   its transcript under `…/workspaceStorage/<ws>/GitHub.copilot-chat/transcripts/`.
 *
 * @param {any} input the hook payload
 * @param {{ forced?: string }} [options] an explicit `--agent` / env override
 * @returns {'local'|'copilot'}
 */
export function agentOf(input, options = {}) {
  if (String(options.forced || '').trim().toLowerCase() === 'local') return 'local';
  if (input && typeof input === 'object') {
    if (input.hook_event_name !== undefined || input.session_id !== undefined) return 'local';
    if (/\bGitHub\.copilot-chat[\\/]transcripts[\\/]/i.test(String(input.transcript_path ?? ''))) return 'local';
    if (/\bGitHub\.copilot-chat[\\/]transcripts[\\/]/i.test(String(input.transcriptPath ?? ''))) return 'local';
  }
  return 'copilot';
}

/**
 * Agent hooks must never fail loudly: a crash in a notification hook would break the
 * turn it reports on.
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
