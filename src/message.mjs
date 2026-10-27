import { escapeHtml, markdownToTelegramHtml, splitHtml } from './markdown.mjs';

export { escapeHtml };

const TYPE_LABELS = {
  question: 'Question',
  permission: 'Permission',
  completed: 'Completed',
  info: 'Info',
  error: 'Error',
};

export function truncate(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A folder as Telegram should show it: the last part of the path, with a leading
 * `…` when the rest was dropped. A phone cannot use the whole path, and the tail is
 * what identifies the project.
 *
 * @param {string} value
 * @returns {string}
 */
export function folderLabel(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/[\\/]+$/, '');
  if (!text) return '';
  // Keep the separators the path uses, so a POSIX path does not turn into a Windows one.
  const separator = text.includes('\\') ? '\\' : '/';
  const parts = text.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return '';
  // A drive path of three parts still names the project and fits on a line.
  const onDrive = /^[A-Za-z]:$/.test(parts[0]);
  const rooted = !onDrive && /^[\\/]/.test(text);
  if (parts.length <= 2) return `${rooted ? separator : ''}${parts.join(separator)}`;
  if (onDrive && parts.length <= 3) return parts.join(separator);
  return `…${separator}${parts.slice(-2).join(separator)}`;
}

/**
 * The message header: title, the agent facts, and the answering hint.
 *
 * The facts follow the editor's own style — the folder is a path, so it is shown as
 * one: highlighted, and shortened to the part that identifies it.
 *
 * @param {object} request
 * @returns {string}
 */
export function formatNotification(request) {
  const type = TYPE_LABELS[request.type] ? request.type : 'info';
  const heading = textOf(request.title).trim() || TYPE_LABELS[type];
  const lines = [`<b>${escapeHtml(heading)}</b>`];

  const facts = [];
  if (request.agent) facts.push(`<i>${escapeHtml(request.agent)}</i>`);
  if (request.cwd) facts.push(`<code>${escapeHtml(folderLabel(request.cwd))}</code>`);
  if (facts.length) lines.push(facts.join(' · '));

  if (type === 'completed' && !textOf(request.message) && !textOf(request.detail)) {
    // A bare "finished" line tells the reader nothing; say what is known instead.
    lines.push(request.cwd ? 'Finished — no summary was available from the agent.' : 'Finished.');
  }

  if (request.waitForReply) {
    const hint = request.options?.length ? 'Reply with /1 /2 … or tap a button.' : 'Reply to this message to answer.';
    lines.push(`<i>${hint}</i>`);
    if (request.timeoutSeconds) lines.push(`<i>Expires in ${formatDuration(request.timeoutSeconds)}.</i>`);
  }

  return lines.join('\n');
}

/**
 * Text out of a request field that may not be a string: an agent that posts an error
 * object, or an agent event forwarded as-is. `String(value)` would print
 * `[object Object]`, which tells the reader nothing.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return String(value.message || value.name || '');
  if (typeof value === 'object') {
    const inner = value.message ?? value.error ?? value.reason ?? value.description;
    if (typeof inner === 'string' && inner.trim()) return inner;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }
  return String(value);
}

/**
 * Renders one notification into one or more Telegram messages.
 *
 * Agent output is Markdown, so it is converted to Telegram's HTML subset; when
 * the result is longer than `maxLength` it is split instead of truncated, so no
 * answer or detail is lost.
 *
 * @param {object} request
 * @param {number} maxLength
 * @returns {string[]} at least one message
 */
export function formatAgentMessages(request, maxLength) {
  const head = formatNotification(request);

  const message = textOf(request.message).trim();
  const detailText = textOf(request.detail).trim();

  const parts = [head];
  if (message) parts.push(markdownToTelegramHtml(message));
  if (detailText) {
    const body = markdownToTelegramHtml(detailText);
    // A detail that is already fenced renders as its own pre block; anything
    // else is quoted so it is visibly separate from the message.
    parts.push(body.startsWith('<pre>') ? body : `<blockquote>${body}</blockquote>`);
  }

  const html = parts.filter(Boolean).join('\n\n');
  const chunks = splitHtml(html, maxLength);
  return chunks.length ? chunks : ['<b>TelegramNotify</b>'];
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour12: false });
}

/**
 * Compact, single-line description used in the footers of resolved messages.
 *
 * @param {{ source: string, answer?: string|null, reply?: string|null }} resolution
 */
export function formatResolution(resolution) {
  const via = resolution.source === 'button' ? 'button' : 'reply';
  const value = resolution.answer ?? resolution.reply;
  const shown = value === undefined || value === null || value === '' ? 'no reply' : truncate(value, 300);
  return `✔ ${formatTime()} · ${via} · ${escapeHtml(shown)}`;
}
