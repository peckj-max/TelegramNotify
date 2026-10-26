/**
 * Picks the agent's answer out of the text a turn produced.
 *
 * A turn is a loop: a line of narration, a tool call, another line, another tool
 * call, and then the answer. Everything before the answer is progress reporting
 * ("let me look at the file"), which the recipient of a Telegram message does not
 * want. The answer is therefore the trailing block of messages that do not
 * accompany tool work — that block is complete, so a long answer is not cut down
 * to its closing line.
 */

/**
 * @typedef {object} AnswerItem
 * @property {string} [text] what the agent wrote in this message
 * @property {boolean} [toolWork] the message came with a tool call
 * @property {boolean} [step] the item is a model message, not a bare tool log
 */

/**
 * @param {AnswerItem[]} items messages of one turn, oldest first
 * @returns {string}
 */
export function answerOf(items) {
  const list = Array.isArray(items) ? items : [];
  const answer = [];

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index] ?? {};
    const text = String(item.text ?? '').trim();

    if (item.toolWork) {
      // The block that was collected so far is the answer; this is the step that
      // came before it.
      if (answer.length) break;
      // A model message that used a tool and left no answer after it means the
      // turn stopped mid-work: its text is a progress line, not the result.
      if (item.step) break;
      // A trailing tool log (`tool.execution_complete`) says nothing on its own.
      continue;
    }
    if (!text) continue;
    answer.unshift(text);
  }

  return mergeSnapshots(answer).join('\n\n');
}

/**
 * Collapses cumulative snapshots of one message (the Copilot agent host repeats a
 * message as it grows) so the same sentence is not posted twice.
 *
 * @param {string[]} parts
 * @returns {string[]}
 */
export function mergeSnapshots(parts) {
  const merged = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (previous === part) continue;
    if (previous && part.startsWith(previous)) merged[merged.length - 1] = part;
    else merged.push(part);
  }
  return merged;
}

/**
 * Whether a content part is the agent using a tool rather than writing to the
 * reader. Both schemas name the part `tool…` (`tool`, `tool_use`, `tool-call`).
 *
 * @param {any} part
 * @returns {boolean}
 */
export function isToolPart(part) {
  return String(part?.type ?? '').startsWith('tool');
}

/**
 * A host summary often opens with what the agent did rather than what it found
 * ("Answered the factual question: …", "Provided a concise factual answer: …").
 * The reader wants the finding, and the message already labels the summary, so that
 * short lead-in is dropped.
 *
 * @param {string} summary
 * @returns {string}
 */
export function withoutLeadIn(summary) {
  const text = String(summary ?? '').trim();
  const match = /^([A-Za-z][^:.\n]{0,80}):\s+([\s\S]+)$/.exec(text);
  if (!match) return text;
  const [, lead, rest] = match;
  if (!/^(answered|provided|implemented|completed|fixed|added|updated|reviewed|investigated|verified|explained|summarised|summarized)\b/i.test(lead)) {
    return text;
  }
  return rest.trim();
}

/**
 * Puts the summary the host reported after the answer, the way the panel renders it:
 * the answer, then `Task completed:`, then the summary.
 *
 * The answer is everything outside the collapsed rows, so it leads with its own
 * formatting; the summary follows as the host wrote it. Both are sent, because the
 * panel shows both — no comparison, and nothing is dropped.
 *
 * @param {string} answer
 * @param {string} summary
 * @returns {string}
 */
export function mergeAnswerAndSummary(answer, summary) {
  const body = String(answer ?? '').trim();
  const report = withoutLeadIn(summary).trim();
  const label = '**Task completed:**';
  if (!report) return body;
  if (!body) return `${label}\n\n${report}`;
  return `${body}\n\n${label}\n\n${report}`;
}
