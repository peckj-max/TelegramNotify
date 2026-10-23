const TYPE_LABELS = {
  question: 'Question',
  permission: 'Permission',
  completed: 'Completed',
  info: 'Info',
  error: 'Error',
};

const MAX_DETAIL = 1200;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
export function truncate(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function detailBlock(value) {
  if (!value) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return `<pre>${escapeHtml(truncate(text, MAX_DETAIL))}</pre>`;
}

/**
 * @param {object} request
 * @param {'question'|'permission'|'completed'|'info'|'error'} request.type
 * @param {string} [request.agent]
 * @param {string} [request.title]
 * @param {string} [request.message]
 * @param {string} [request.detail]
 * @param {string} [request.cwd]
 * @param {string[]} [request.options]
 * @param {boolean} [request.waitForReply]
 * @param {number} [request.timeoutSeconds]
 */
export function formatNotification(request) {
  const type = TYPE_LABELS[request.type] ? request.type : 'info';
  const heading = request.title?.trim() || TYPE_LABELS[type];
  const lines = [`<b>${escapeHtml(heading)}</b>`];

  const facts = [];
  if (request.agent) facts.push(`agent: ${escapeHtml(request.agent)}`);
  if (request.cwd) facts.push(`cwd: ${escapeHtml(truncate(request.cwd, 120))}`);
  if (facts.length) lines.push(`<i>${facts.join(' · ')}</i>`);

  if (request.message) lines.push(escapeHtml(truncate(request.message, 3000)));

  if (type === 'completed' && !request.message) lines.push('The task finished.');

  if (request.waitForReply) {
    const hint = request.options?.length ? 'Reply with /1 /2 … or tap a button.' : 'Reply to this message to answer.';
    lines.push(`<i>${hint}</i>`);
    if (request.timeoutSeconds) lines.push(`<i>Expires in ${formatDuration(request.timeoutSeconds)}.</i>`);
  }

  return lines.join('\n');
}

/**
 * @param {object} request
 * @param {number} maxLength
 */
export function formatAgentMessage(request, maxLength) {
  const head = formatNotification(request);
  const body = request.detail ? detailBlock(request.detail) : '';
  const full = body ? `${head}\n${body}` : head;
  if (full.length <= maxLength) return full;
  return `${truncate(full, Math.max(64, maxLength - 1))}`;
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
