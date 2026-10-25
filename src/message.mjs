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
 * The message header: title, the agent facts, and the answering hint.
 *
 * @param {object} request
 * @returns {string}
 */
export function formatNotification(request) {
  const type = TYPE_LABELS[request.type] ? request.type : 'info';
  const heading = String(request.title ?? '').trim() || TYPE_LABELS[type];
  const lines = [`<b>${escapeHtml(heading)}</b>`];

  const facts = [];
  if (request.agent) facts.push(`agent: ${escapeHtml(request.agent)}`);
  if (request.cwd) facts.push(`cwd: ${escapeHtml(truncate(request.cwd, 120))}`);
  if (facts.length) lines.push(`<i>${facts.join(' · ')}</i>`);

  if (type === 'completed' && !request.message && !request.detail) {
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

  const message = String(request.message ?? '').trim();
  const detail = request.detail === undefined || request.detail === null ? '' : request.detail;
  const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);

  const parts = [head];
  if (message) parts.push(markdownToTelegramHtml(message));
  if (detailText.trim()) {
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
