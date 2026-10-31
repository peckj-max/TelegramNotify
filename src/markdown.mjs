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

/** The inverse of escapeHtml, for TeX that was escaped before conversion. */
function unescapeHtml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Letters with their own symbols. */
const LETTER_COMMANDS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  ne: '≠', neq: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥', ll: '≪', gg: '≫',
  approx: '≈', simeq: '≃', equiv: '≡', sim: '∼', propto: '∝', cong: '≅',
  infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫',
  iint: '∬', oint: '∮', to: '→', rightarrow: '→', leftarrow: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  rightleftharpoons: '⇌', uparrow: '↑', downarrow: '↓', mapsto: '↦',
  degree: '°', circ: '∘', angle: '∠', perp: '⊥', parallel: '∥',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  therefore: '∴', because: '∵', ldots: '…', cdots: '⋯', dots: '…',
  prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  triangle: '△', square: '□', surd: '√', checkmark: '✓', bigcirc: '○',
  vert: '|', lvert: '|', rvert: '|', mid: '|',
};

/** Commands whose name is the text to show (`\sin x` reads "sin x"). */
const FUNCTION_COMMANDS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min',
  'sup', 'inf', 'det', 'gcd', 'mod', 'bmod', 'deg', 'dim', 'ker', 'Pr',
]);

const SUPERSCRIPT = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', j: 'ʲ', k: 'ᵏ',
  l: 'ˡ', m: 'ᵐ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ',
  y: 'ʸ', z: 'ᶻ',
};

const SUBSCRIPT = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ',
  x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ',
  i: 'ᵢ', j: 'ⱼ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ',
};

/** A script run, or null when a character has no Unicode form. */
function toScript(body, map) {
  let out = '';
  for (const char of String(body ?? '')) {
    if (!Object.prototype.hasOwnProperty.call(map, char)) return null;
    out += map[char];
  }
  return out || null;
}

/**
 * Every known command name, longest first.
 *
 * The order matters twice: `\varepsilon` must win over `\varepsilon`'s prefix
 * `\varepsilon`… and, as a prefix match, `\cdot` must still be found in
 * `\cdotm` — which is what `\cdot\text{m}` becomes once the wrapper is unwrapped.
 * TeX would call `\cdotm` an unknown command; the intent here is plain.
 */
const SYMBOL_COMMANDS = new RegExp(
  `\\\\(?:${Object.keys(LETTER_COMMANDS)
    .sort((a, b) => b.length - a.length)
    .join('|')})`,
  'g',
);

/** One side of a fraction: bracketed only when it is compound. */
function fractionPart(value) {
  const body = String(value ?? '').trim();
  if (!body) return '';
  // Brackets are needed to keep the meaning (`mg-T` over `m`), not for their own
  // sake: a solidus between two atoms already reads unambiguously.
  return /[+\-=,;\s]/.test(body) ? `(${body})` : body;
}

/**
 * Inline math in a plain-text cell, where there is no HTML to hold a marker.
 *
 * @param {string} text
 * @returns {string}
 */
function mathToText(text) {
  return String(text ?? '')
    .replace(/\\\(([\s\S]+?)\\\)/g, (whole, tex) => latexToText(tex))
    .replace(/\\\[([\s\S]+?)\\\]/g, (whole, tex) => latexToText(tex))
    .replace(/\$\$([\s\S]+?)\$\$/g, (whole, tex) => latexToText(tex))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?![\d])/g, (whole, pre, tex) => pre + latexToText(tex));
}

/**
 * LaTeX as readable plain text.
 *
 * Telegram has no math renderer and no table element, so a formula has to become
 * characters: Greek letters and operators get their Unicode forms, a fraction
 * keeps its solidus, and a tag becomes a bracketed number. Anything unknown loses
 * only its backslash, so nothing of the formula disappears.
 *
 * @param {string} value
 * @returns {string}
 */
export function latexToText(value) {
  let text = String(value ?? '');
  if (!text.trim()) return '';

  // A line break inside a formula, and the rows of an environment.
  text = text.replace(/\\\\/g, '\n').replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, '\n');

  // Commands taking braced arguments, innermost first: the loop is what lets
  // `\frac{\sqrt{2}}{2}` collapse, one nesting level per pass.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = text;
    text = text
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (whole, a, b) => `${fractionPart(a)}/${fractionPart(b)}`)
      .replace(/\\sqrt\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g, (whole, index, body) =>
        (index === '3' ? '∛' : '√') + `(${body.trim()})`,
      )
      .replace(/\\tag\s*\*?\s*\{([^{}]*)\}/g, (whole, body) => `(${body.trim()})`)
      .replace(/\\(?:colorbox|textcolor)\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, (whole, body) => body)
      .replace(/\\(?:color|highlight)\s*\{[^{}]*\}/g, '')
      .replace(/\\(?:stackrel|overset|underset)\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, (whole, body) => body)
      .replace(/\\(?:text|textrm|textbf|textit|mbox|operatorname)\s*\{([^{}]*)\}/g, (whole, body) => body)
      .replace(
        /\\(?:mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|mathfrak|boldsymbol|bm|vec|bar|hat|tilde|dot|ddot|overline|underline|widehat|widetilde|boxed|fbox|mathop|mathbin|mathrel|mathord|mathopen|mathclose|mathpunct|cancel|bcancel|xcancel|substack|phantom|smash)\s*\{([^{}]*)\}/g,
        (whole, body) => body,
      );
    if (text === before) break;
  }

  // Superscripts and subscripts become real characters where Unicode has them.
  text = text.replace(/\^\{([^{}]*)\}|\^([A-Za-z0-9+-])/g, (whole, braced, single) => {
    const body = braced !== undefined ? braced : single;
    return toScript(body, SUPERSCRIPT) ?? (body.length > 1 ? `^(${body})` : `^${body}`);
  });
  text = text.replace(/_\{([^{}]*)\}|_([A-Za-z0-9+-])/g, (whole, braced, single) => {
    const body = braced !== undefined ? braced : single;
    return toScript(body, SUBSCRIPT) ?? (body.length > 1 ? `_(${body})` : `_${body}`);
  });

  text = text
    // Spacing and sizing commands carry no meaning in plain text. Only a
    // backslash followed by one of these characters is a command; a bare word is
    // left alone.
    .replace(/\\[,;:!>]/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/\\(?:quad|qquad)\b/g, '  ')
    .replace(/\\(?:left|right|big|Big|bigg|Bigg|bigl|bigr|Bigl|Bigr|middle)\b\s?/g, '')
    .replace(/\\(?:displaystyle|textstyle|scriptstyle|limits|nolimits)\b\s?/g, '');

  // Named symbols first, matched as a prefix so unwrapped groups cannot hide
  // one; then function names; then anything left keeps its name without the
  // backslash rather than disappearing.
  text = text
    .replace(SYMBOL_COMMANDS, (whole) => LETTER_COMMANDS[whole.slice(1)])
    .replace(/\\([A-Za-z]+)/g, (whole, name) => (FUNCTION_COMMANDS.has(name) ? name : name));

  // An escaped character is that character.
  text = text.replace(/\\([{}$%&#_|])/g, '$1');
  text = text.replace(/[{}]/g, '');
  // An alignment tab separates parts of one row.
  text = text.replace(/&/g, ' ');
  // A binary operator reads better spaced on both sides than on one: `5.0\times
  // 9.8` otherwise reaches the chat as `5.0× 9.8`.
  text = text.replace(/\s*([×÷±∓∗≈≤≥≠≡])\s*/g, ' $1 ');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
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
  const mathSpans = [];
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

  // Math is taken next, while code spans and links are already set aside: the
  // TeX must never meet the emphasis rules below, where `a*b*c` and `x_1` mean
  // something else. Telegram cannot typeset it, so it becomes readable text.
  const holdMath = (tex) => {
    mathSpans.push(escapeHtml(latexToText(unescapeHtml(tex))));
    return `\u0001${mathSpans.length - 1}\u0001`;
  };
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (whole, tex) => holdMath(tex));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (whole, tex) => holdMath(tex));
  text = text.replace(/\$\$/g, '\u0003');
  text = text.replace(/\u0003([\s\S]+?)\u0003/g, (whole, tex) => holdMath(tex));
  // A `$…$` pair, guarded so a price is not treated as a formula: the content may
  // not start or end with a space, and a closing `$` followed by a digit is money.
  text = text.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?![\d])/g, (whole, pre, tex) => pre + holdMath(tex));

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');

  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codeSpans[Number(index)]}</code>`);

  // An unpaired `$$` marker left over: it was a dollar sign, not a formula.
  text = text.replace(/\u0003/g, '$');

  // Formulas are expanded last: they are literal text, so a fraction's solidus is
  // never read as a path and a stray `*` is never read as emphasis.
  return highlightPaths(text).replace(/\u0001(\d+)\u0001/g, (_, index) => mathSpans[Number(index)]);
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
  // A model often leaves a blank line under the header, so the separator row is
  // looked for past any run of blank lines rather than only on the next line.
  let next = index + 1;
  while (next < lines.length && !String(lines[next]).trim()) next += 1;
  const divider = lines[next];
  return Boolean(divider && isSeparatorRow(divider) && divider.includes('|'));
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    // A cell that holds a formula is converted here: the narrow layout prints
    // cells as plain monospace text, with no further markup pass.
    .map((cell) => mathToText(cell.trim()));
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
  // Past the (possibly blank-separated) separator row.
  let index = start + 1;
  while (index < lines.length && !String(lines[index]).trim()) index += 1;
  index += 1;
  while (index < lines.length) {
    const line = String(lines[index]);
    if (!line.trim()) {
      // Blank lines inside a table are tolerated — models separate rows that way,
      // and reading them as the end leaves the pipes showing as text. A blank line
      // only ends the table when no row follows it.
      let peek = index + 1;
      while (peek < lines.length && !String(lines[peek]).trim()) peek += 1;
      if (peek < lines.length && String(lines[peek]).includes('|')) {
        index = peek;
        continue;
      }
      break;
    }
    if (!line.includes('|')) break;
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
 * A display formula starting at `start`, or null when one does not.
 *
 * `$$…$$` and `\[…\]` may span lines, and their contents can hold `|`, `*` or
 * `_`, which the table and emphasis rules would otherwise claim. A formula that is
 * never closed — a truncated answer — is not read at all, so nothing is lost.
 *
 * @param {string[]} lines
 * @param {number} start
 * @returns {{tex: string, next: number}|null}
 */
function readDisplayMath(lines, start) {
  const opened = /^\s*(\\\[|\$\$)/.exec(String(lines[start] ?? ''));
  if (!opened) return null;
  const closer = opened[1] === '\\[' ? '\\]' : '$$';
  const body = String(lines[start]).replace(/^\s*/, '').slice(opened[1].length);
  const sameLine = body.indexOf(closer);
  if (sameLine >= 0) return { tex: body.slice(0, sameLine), next: start + 1 };

  const parts = [body];
  for (let index = start + 1; index < lines.length; index += 1) {
    const at = String(lines[index]).indexOf(closer);
    if (at >= 0) {
      parts.push(String(lines[index]).slice(0, at));
      return { tex: parts.join('\n'), next: index + 1 };
    }
    parts.push(String(lines[index]));
  }
  return null;
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

    // A formula on its own lines is one block. Telegram would show the raw TeX,
    // so it is converted to text and kept on its own line, as the session draws it.
    const display = readDisplayMath(lines, index);
    if (display) {
      const formula = escapeHtml(latexToText(display.tex));
      if (formula) blocks.push(formula);
      index = display.next;
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
