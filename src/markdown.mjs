/**
 * Renders agent output for Telegram.
 *
 * Agents emit Markdown: tables with `|---|` separators, `##` headings, fences,
 * bullets. Telegram shows only a small HTML subset, so the Markdown is converted
 * instead of dumped raw, and a long message is split into several Telegram
 * messages rather than truncated.
 */

/** Telegram's hard limit per message, in UTF-16 code units. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** How many messages one notification may become before it is summarised. */
const MAX_CHUNKS = 10;

/** A monospace table wider than this reads badly on a phone. */
const TABLE_WIDTH_LIMIT = 46;

/** Longest single cell before it is shortened, keeping columns readable. */
const CELL_LIMIT = 32;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (char) => HTML_ESCAPES[char]);
}

/**
 * A path an agent writes when it means "this file": a Windows drive path, a POSIX
 * path, a `./`-relative one, or a relative `folder/file.ext`, optionally with a
 * `:line` suffix. The extension is required, so a bare word is never mistaken for a
 * file, and the match may not stop at a dotted folder name.
 */
const FILE_PATH =
  /(?:[A-Za-z]:[\\/]|\/|\.\/|(?:[A-Za-z0-9_.-]+[\\/])+)[^\s<>"'`|]*?[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}(?::\d+)?(?![\w/\\])/g;

/**
 * A folder, which has no extension to recognise: a drive letter and at least two
 * segments, so `C:\Windows` reads as a path but `C:` on its own does not.
 */
const FOLDER_PATH = /(?<![\w\\/])[A-Za-z]:[\\/](?:[^\s<>"'`|\\/:]+\\)+[^\s<>"'`|\\/:.,;)]+/g;

/** Text that is a URL, not a path: it keeps its own form. */
const URL_TEXT = /(\bhttps?:\/\/[^\s<>"'`]+)/g;

/**
 * How a path is shown: its last two parts, so the folder that identifies the file
 * comes with it (`hooks/transcript.mjs:145`), plus the line the agent pointed at.
 *
 * @param {string} path
 * @returns {string}
 */
function fileLabel(path) {
  const value = String(path);
  const line = /:(\d+)$/.exec(value)?.[1] ?? '';
  const body = line ? value.slice(0, -(line.length + 1)) : value;
  const parts = body.split(/[\\/]+/).filter(Boolean);
  const tail = parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/');
  return `${tail}${line ? `:${line}` : ''}`;
}

/**
 * Inline Markdown inside one already-escaped line. The input has been through
 * `escapeHtml`, so only attribute quotes still need escaping.
 *
 * A link to a local file cannot be opened from Telegram, so it is shown the way
 * the editor shows it — the file name highlighted, with its line number. http(s)
 * links stay links.
 *
 * @param {string} line
 * @returns {string}
 */
function inlineMarkdown(line) {
  const codeSpans = [];
  // Inline code is extracted first so its contents are never reformatted.
  let text = line.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, target) => {
    // `target` is already HTML-escaped, so it goes into the attribute unchanged.
    if (/^https?:\/\//i.test(target)) {
      return `<a href="${target.replace(/"/g, '&quot;')}">${label}</a>`;
    }
    // A local path cannot be opened from Telegram, so it is shown the way the
    // editor shows it: highlighted, with its line. A label that names no file
    // ("the controller", "here") would hide what was changed, so the path wins.
    const line = /:(\d+)$/.exec(target)?.[1] ?? '';
    const named = /[^\\/]+\.\w{1,8}$/.test(label);
    const shown = named ? label : fileLabel(target);
    return `<code>${shown}${named && line ? `:${line}` : ''}</code>`;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');

  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codeSpans[Number(index)]}</code>`);

  return highlightPaths(text);
}

/**
 * Highlights a path the agent wrote as plain text, the same way a link to a file is
 * highlighted. Tags are skipped, so neither an `href` nor the text of a code span is
 * rewritten, and a URL keeps its own form.
 *
 * @param {string} html
 * @returns {string}
 */
function highlightPaths(html) {
  let insideCode = false;
  return html
    .split(/(<\/?[a-zA-Z][^>]*>)/g)
    .map((piece) => {
      if (piece.startsWith('<')) {
        if (/^<code[\s>]/i.test(piece)) insideCode = true;
        else if (/^<\/code>/i.test(piece)) insideCode = false;
        return piece;
      }
      if (insideCode) return piece;
      return piece
        .split(URL_TEXT)
        .map((part) =>
          /^https?:\/\//i.test(part)
            ? part
            : part.replace(FILE_PATH, (path) => `<code>${fileLabel(path)}</code>`).replace(FOLDER_PATH, (folder) => `<code>${folder}</code>`),
        )
        .join('');
    })
    .join('');
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);
}

function looksLikeTableStart(lines, index) {
  const line = lines[index];
  if (!line || !line.includes('|')) return false;
  const next = lines[index + 1];
  return Boolean(next && isSeparatorRow(next) && next.includes('|'));
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * A checklist item becomes a ticked or empty box, the way the session draws it.
 *
 * @param {string} text
 * @returns {string}
 */
function taskStateOf(text) {
  const value = String(text);
  if (/^\[[xX]\]\s+/.test(value)) return `☑ ${value.replace(/^\[[xX]\]\s+/, '')}`;
  if (/^\[ \]\s+/.test(value)) return `☐ ${value.replace(/^\[ \]\s+/, '')}`;
  return value;
}

/**
 * A narrow table stays a monospace block; a wide one becomes a per-row list so
 * it does not turn into a wall of pipes on a phone.
 *
 * @param {string[]} header
 * @param {string[][]} rows
 */
function renderTable(header, rows) {
  const columns = header.length;
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length), 0),
  );
  const total = widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * 2;

  // A narrow table is safe only when no cell has to be shortened. Otherwise use
  // the list layout below, which keeps the complete cell text.
  if (total <= TABLE_WIDTH_LIMIT && widths.every((width) => width <= CELL_LIMIT)) {
    const pad = (cell, index) => String(cell ?? '').slice(0, widths[index]).padEnd(widths[index]);
    const line = (cells) => cells.map(pad).join('  ').trimEnd();
    const body = [line(header), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line)];
    return `<pre>${escapeHtml(body.join('\n'))}</pre>`;
  }

  // Wide: one bullet per row, labelled with the header cells.
  const items = rows.map((row) => {
    const [first, ...rest] = row;
    const heading = inlineMarkdown(escapeHtml(first ?? ''));
    const facts = rest
      .map((cell, index) => {
        const label = header[index + 1];
        if (!cell || !label) return '';
        return `${inlineMarkdown(escapeHtml(label))}: ${inlineMarkdown(escapeHtml(cell))}`;
      })
      .filter(Boolean);
    // Telegram trims leading spaces, so the facts are joined, not indented.
    return facts.length ? `• <b>${heading}</b> — ${facts.join(' · ')}` : `• ${heading}`;
  });
  return items.join('\n');
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {{ html: string, next: number }}
 */
function readTable(lines, start) {
  const header = splitRow(lines[start]);
  const rows = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || !line.includes('|')) break;
    if (isSeparatorRow(line)) {
      index += 1;
      continue;
    }
    const cells = splitRow(line);
    while (cells.length < header.length) cells.push('');
    rows.push(cells);
    index += 1;
  }
  return { html: renderTable(header, rows), next: index };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function markdownToTelegramHtml(value) {
  const source = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ');

  if (!source.trim()) return '';

  const lines = source.split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);

    if (fence) {
      const marker = fence[1];
      const code = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      blocks.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }

    if (looksLikeTableStart(lines, index)) {
      const { html, next } = readTable(lines, index);
      blocks.push(html);
      index = next;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const title = inlineMarkdown(escapeHtml(heading[2].trim()));
      const level = heading[1].length;
      // The session shows `#`/`##` above the body; Telegram has no font sizes, so the
      // top two levels are underlined as well as bold and deeper ones stay bold.
      blocks.push(level <= 2 ? `<b><u>${title}</u></b>` : `<b>${title}</b>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push('─────');
      index += 1;
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      // Telegram collapses leading spaces, so nesting is shown by the marker.
      const depth = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2);
      const marker = depth === 0 ? '•' : depth === 1 ? '◦' : '▪';
      blocks.push(`${marker} ${inlineMarkdown(escapeHtml(taskStateOf(bullet[2])))}`);
      index += 1;
      continue;
    }

    const ordered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      // The number the agent wrote is kept: it is what a cross-reference in the
      // answer points at ("see step 2").
      const depth = Math.floor(ordered[1].replace(/\t/g, '  ').length / 2);
      const indent = depth > 0 ? `${'  '.repeat(Math.min(depth, 3))}` : '';
      blocks.push(`${indent}${ordered[2]}. ${inlineMarkdown(escapeHtml(taskStateOf(ordered[3])))}`);
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(`▎ ${inlineMarkdown(escapeHtml(quote[1]))}`);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      // Collapse runs of blank lines; Telegram already spaces paragraphs.
      if (blocks.length && blocks[blocks.length - 1] !== '') blocks.push('');
      index += 1;
      continue;
    }

    blocks.push(inlineMarkdown(escapeHtml(line)));
    index += 1;
  }

  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TAG_TOKEN = /<\/?[a-zA-Z][^>]*>/g;

/**
 * @param {string} html
 */
function tokenize(html) {
  const tokens = [];
  let index = 0;
  TAG_TOKEN.lastIndex = 0;
  let match = TAG_TOKEN.exec(html);
  while (match) {
    if (match.index > index) tokens.push({ text: html.slice(index, match.index) });
    tokens.push({ tag: match[0] });
    index = match.index + match[0].length;
    match = TAG_TOKEN.exec(html);
  }
  if (index < html.length) tokens.push({ text: html.slice(index) });
  return tokens;
}

/**
 * Last newline or space where a chunk may end, at or before `room`.
 *
 * @param {string} text
 * @param {number} room
 */
function lastBreak(text, room) {
  const window = text.slice(0, room);
  const newline = window.lastIndexOf('\n');
  if (newline > room * 0.4) return newline + 1;
  const space = window.lastIndexOf(' ');
  if (space > 0) return space + 1;
  return newline > 0 ? newline + 1 : 0;
}

/**
 * A single unbroken run (a long path or hash) has to be cut somewhere; avoid
 * splitting an entity such as `&amp;` by stepping back to its `&`.
 *
 * @param {string} text
 * @param {number} room
 */
function safeHardCut(text, room) {
  let cut = Math.max(1, room);
  const entityStart = text.lastIndexOf('&', cut);
  if (entityStart >= 0 && cut - entityStart < 8 && text.slice(entityStart, cut).includes(';') === false) {
    cut = entityStart > 0 ? entityStart : cut;
  }
  return cut;
}

/**
 * Splits Telegram HTML into messages that each stay under `limit`, keeping tags
 * balanced by closing them at the end of a chunk and reopening them in the next.
 *
 * @param {string} html
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitHtml(html, limit = 3800) {
  const max = Math.max(256, Math.min(limit, TELEGRAM_MESSAGE_LIMIT - 64));
  const chunks = [];
  const open = [];
  let current = '';

  const reserve = () => open.reduce((sum, entry) => sum + entry.closeTag.length + 1, 0);

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(`${current}${[...open].reverse().map((entry) => entry.closeTag).join('')}`);
    current = open.map((entry) => entry.openTag).join('');
  };

  for (const token of tokenize(String(html ?? ''))) {
    if (token.tag) {
      const name = (/\s*<\/?([a-zA-Z][\w-]*)/.exec(token.tag) || [])[1] || '';
      if (token.tag.startsWith('</')) {
        const position = open.map((entry) => entry.name).lastIndexOf(name);
        if (position >= 0) open.splice(position, 1);
        current += token.tag;
      } else if (token.tag.endsWith('/>')) {
        current += token.tag;
      } else {
        open.push({ name, openTag: token.tag, closeTag: `</${name}>` });
        current += token.tag;
      }
      continue;
    }

    let text = token.text;
    while (text.length) {
      const room = max - current.length - reserve();
      if (room <= 0) {
        flush();
        continue;
      }
      if (text.length <= room) {
        current += text;
        break;
      }
      let cut = lastBreak(text, room);
      if (cut <= 0) cut = safeHardCut(text, room);
      current += text.slice(0, cut);
      text = text.slice(cut).replace(/^[ \t]+/, '');
      flush();
    }
  }

  if (current.trim()) chunks.push(current);

  if (chunks.length <= MAX_CHUNKS) return chunks;
  const kept = chunks.slice(0, MAX_CHUNKS);
  const marker = `\n\n<i>… output truncated after ${MAX_CHUNKS} messages</i>`;
  const last = kept[MAX_CHUNKS - 1];
  const contentLimit = max - marker.length;
  if (contentLimit < 256) {
    // splitHtml's minimum chunk size leaves no room for content at this limit;
    // the tenth message is still available for a balanced, visible notice.
    kept[MAX_CHUNKS - 1] = marker.trim();
    return kept;
  }

  // Never slice HTML directly: that can cut an entity or a closing tag. Splitting
  // the already-balanced last chunk at a smaller limit gives us a safe prefix.
  const [prefix] = splitHtml(last, contentLimit);
  kept[MAX_CHUNKS - 1] = `${prefix}${marker}`;
  return kept;
}

/**
 * Whether `text` plus `extra` fits in one message, respecting both the caller's
 * chunk size and Telegram's hard limit.
 *
 * @param {string} text
 * @param {string} extra
 * @param {number} [limit]
 */
export function fitsOneMessage(text, extra = '', limit = TELEGRAM_MESSAGE_LIMIT) {
  const max = Math.min(limit, TELEGRAM_MESSAGE_LIMIT);
  return text.length + extra.length + 2 <= max - 16;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/**
 * Strips the tags and unescapes entities, used when Telegram refuses HTML.
 *
 * A refused message must still be readable, so the parts that were carrying meaning
 * keep a plain-text form: a code span is wrapped in backticks, a bold heading is
 * marked with a leading `›`, and a quote keeps its bar.
 *
 * @param {string} html
 * @returns {string}
 */
export function plainTextFromHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|pre|blockquote)>/gi, '\n')
    .replace(/<code>([^<]*)<\/code>/gi, '`$1`')
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
    .replace(/<b>([^<]*)<\/b>/gi, '**$1**')
    .replace(/<i>([^<]*)<\/i>/gi, '_$1_')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}
