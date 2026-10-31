import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerOf, doneLabelOf, isToolPart, mergeAnswerAndSummary } from '../answer.mjs';
import { log } from '../logger.mjs';

/** Windows to try, smallest first: most turns finish inside the first one. */
const WINDOWS = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

/** A transcript bigger than this is read from the tail only. */
const MAX_READ_BYTES = 32 * 1024 * 1024;

/** A pathological reply is not worth more than this. */
const MAX_TEXT = 20000;

/**
 * Pulls assistant text out of one transcript entry, in either schema:
 *   Claude Code  { type: 'assistant', message: { content: [{ type: 'text', text }] } }
 *   Copilot CLI  { type: 'assistant.message', data: { content: '…' } }
 *
 * @param {any} entry
 * @returns {string}
 */
export function assistantTextOf(entry) {
  const content = entry?.data?.content ?? entry?.message?.content ?? entry?.content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * A stable identity for the turn that produced the text. Used to tell "the same
 * finish reported twice" from "a new finish that happens to say the same thing".
 *
 * @param {any} entry
 * @returns {string}
 */
export function assistantIdOf(entry) {
  const id =
    entry?.data?.messageId ??
    entry?.data?.turnId ??
    entry?.message?.id ??
    entry?.id ??
    entry?.uuid ??
    entry?.messageId;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * Whether an entry is the agent using a tool rather than writing to the reader.
 *
 * Copilot reports the calls on the message (`toolRequests`) and logs the run as
 * `tool.execution_*` entries; Claude Code adds `tool_use` parts to the message.
 *
 * @param {any} entry
 * @returns {boolean}
 */
export function hasToolWorkOf(entry) {
  const type = String(entry?.type ?? '');
  if (type.startsWith('tool.')) return true;

  const requests = entry?.data?.toolRequests ?? entry?.toolRequests;
  if (Array.isArray(requests) && requests.length) return true;

  const content = entry?.data?.content ?? entry?.message?.content ?? entry?.content;
  return Array.isArray(content) && content.some(isToolPart);
}

/**
 * The tool calls a message asked for, in either schema.
 *
 * @param {any} entry
 * @returns {any[]}
 */
function toolRequestsOf(entry) {
  return [entry?.data?.toolRequests, entry?.toolRequests].filter(Array.isArray).flat();
}

/**
 * Whether a tool name is the agent reporting its result rather than working. Both
 * harnesses spell it with either separator.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isTaskCompleteName(name) {
  return /task[_-]?complete/i.test(String(name ?? ''));
}

/**
 * Whether an entry is the session-level mirror of a `task_complete` call. The Copilot
 * agent host writes it, and the local harness writes the same event for its own turns.
 *
 * @param {any} entry
 * @returns {boolean}
 */
function isTaskCompleteEvent(entry) {
  return /^session\.task[_-]?complete/i.test(String(entry?.type ?? ''));
}

/**
 * The arguments of a tool call.
 *
 * The Copilot agent host writes them as an object, while the local harness asks for
 * the same call with a JSON *string* (the wire format of a tool call). Reading only
 * the object form made the local harness look like a turn that never reported a
 * summary.
 *
 * @param {any} request
 * @returns {any}
 */
function toolArgumentsOf(request) {
  const args = request?.arguments ?? request?.args ?? {};
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether an entry is something the user typed, which starts a new turn.
 * Both schemas report it, and a tool result also arrives as a `user` entry in
 * Claude's format, so only real prompt text counts. A prompt the agent host writes
 * for itself ("you have not yet marked the task as complete") is not the user
 * either: the task is still the one running.
 *
 * @param {any} entry
 * @returns {boolean}
 */
export function isUserEntry(entry) {
  const type = String(entry?.type ?? '');
  if (type === 'user.message') {
    // The host's own prompt is marked as an autopilot continuation and keeps the
    // nudge in `transformedContent`; either sign means the task, not a new question.
    if (entry?.data?.isAutopilotContinuation === true) return false;
    const text = [entry?.data?.content, entry?.data?.transformedContent].filter(
      (value) => typeof value === 'string',
    );
    if (text.length) return !text.some(isSystemPromptOf);
    return true;
  }
  if (type !== 'user') return false;

  const content = entry?.message?.content ?? entry?.data?.content;
  if (typeof content === 'string') return !isSystemPromptOf(content) && content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  // A tool result has no text part, only `tool_result` blocks.
  return content.some((part) => part?.type === 'text' && String(part.text ?? '').trim());
}

/**
 * Reads the last assistant turn from a transcript, walking further back until
 * the turn's first message is inside the window. A turn's final tools can push
 * the text hundreds of KB from the end, which a fixed 64 KB tail silently
 * misses.
 *
 * The whole answer is returned, not only the turn's last message: an agent often
 * ends a long answer with a one-line remark, and posting just that loses the
 * answer, while the narration before the tool calls is left out entirely.
 *
 * @param {string|undefined|null} transcriptPath
 * @param {{ maxBytes?: number, agent?: string }} [options] `agent` names the
 *   harness in the closing `done` note (`Copilot`, `Local agent`, …)
 * @returns {Promise<{ text: string, answer: string, summary: string, id: string, reported: boolean }>}
 */
export async function readLastAssistantMessage(transcriptPath, options = {}) {
  if (!transcriptPath) return { text: '', answer: '', summary: '', id: '', reported: false };
  const cap = options.maxBytes ?? MAX_READ_BYTES;

  let stat;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch (err) {
    log.debug(`could not stat transcript: ${err.message}`);
    return { text: '', answer: '', summary: '', id: '', reported: false };
  }
  if (!stat.isFile() || stat.size === 0) return { text: '', answer: '', summary: '', id: '', reported: false };

  let handle;
  try {
    handle = await fs.promises.open(transcriptPath, 'r');
    for (const window of [...WINDOWS, cap]) {
      const size = Math.min(stat.size, window);
      const start = stat.size - size;
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, start);

      const lines = buffer.toString('utf8').split(/\r?\n/);
      // A window starting mid-file begins in the middle of a line.
      if (start > 0) lines.shift();

      const entries = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch {
          /* partially written line */
        }
      }

      const turn = turnOf(entries, { agent: options.agent });
      // A turn that started before the window would be reported with only part of
      // its text, which is the "answer is a small portion" bug: widen the window
      // until the prompt that opens the turn is inside it.
      const opensTurn = entries.some((entry) => isUserEntry(entry));
      if (turn.text && (opensTurn || start === 0)) return turn;

      if (start === 0) break; // whole file read
    }
  } catch (err) {
    log.debug(`could not read transcript: ${err.message}`);
  } finally {
    await handle?.close();
  }
  return { text: '', answer: '', summary: '', id: '', reported: false };
}

/**
 * Whether an entry is something the agent wrote. Copilot logs the system prompt,
 * hook payloads and session bookkeeping in the same file, so the type has to be
 * checked before any `content` is read.
 *
 * @param {any} entry
 * @returns {boolean}
 */
export function isAssistantEntry(entry) {
  const type = String(entry?.type ?? '');
  if (type === 'assistant' || type === 'assistant.message') return true;
  return entry?.message?.role === 'assistant' || entry?.data?.role === 'assistant';
}

/**
 * Prompts an agent host injects by itself: the "keep going" nudge it sends when a
 * turn stopped before calling `task_complete`. They arrive as user messages and as
 * `UserPromptSubmit` hooks, so without this they look like the user asking again.
 */
const SYSTEM_PROMPT_PATTERNS = [
  /you have not yet marked the task as complete/i,
  /stop planning and start implementing/i,
  /you aren't done until you have fully completed the task/i,
  /keep working autonomously until the task is truly finished/i,
];

/**
 * Whether a prompt was written by the agent host rather than by the user.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
export function isSystemPromptOf(prompt) {
  const text = String(prompt ?? '');
  if (!text.trim()) return false;
  return SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether the turn ended by reporting its result through `task_complete`.
 *
 * The report is optional: a turn that never makes the call is finished all the same,
 * and its answer is sent at once. The report only decides whether a `done` note is
 * added, and whether a later stop has a summary to send on its own.
 *
 * @param {any[]} entries
 * @returns {boolean}
 */
export function reportedTaskComplete(entries) {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (isTaskCompleteEvent(entry)) return true;
    if (!isAssistantEntry(entry)) continue;
    if (toolRequestsOf(entry).some((request) => isTaskCompleteName(request?.name))) return true;
  }
  return false;
}

/**
 * The result an agent host reports through its `task_complete` tool.
 *
 * The Copilot agent host does not always put the closing answer in a message: the
 * turn ends with the `task_complete` tool and the answer is its `summary`. Without
 * reading it, the notification would be the last narration the agent wrote.
 *
 * @param {any[]} entries
 * @returns {string}
 */
export function taskSummaryOf(entries) {
  if (!Array.isArray(entries)) return '';

  let summary = '';
  for (const entry of entries) {
    if (isTaskCompleteEvent(entry)) {
      const value = String(entry?.data?.summary ?? entry?.summary ?? '').trim();
      if (value) summary = value;
      continue;
    }
    if (!isAssistantEntry(entry)) continue;
    for (const request of toolRequestsOf(entry)) {
      if (!isTaskCompleteName(request?.name)) continue;
      // The local harness sends the arguments as a JSON string.
      const args = toolArgumentsOf(request);
      const value = String(args.summary ?? args.message ?? '').trim();
      if (value) summary = value;
    }
  }
  return summary;
}

/**
 * The items of one turn in transcript order, and where the turn reported its result.
 *
 * A message whose only tool call is `task_complete` is the report, and so is the tool
 * log that runs it and the session event that mirrors it: they are collapsed rows in
 * the panel, not steps of the work. The local harness writes the answer *in* the
 * message that carries the call, and then one more short closing note, so ending the
 * answer block at the report left only that note — the reason the two harnesses posted
 * different messages.
 *
 * @param {any[]} turn
 * @returns {{ items: import('../answer.mjs').AnswerItem[], reportIndex: number }}
 */
function turnItems(turn) {
  const items = [];
  /** @type {Map<string, string>} names of the calls, so a log knows what it ran */
  const toolNames = new Map();
  let reportIndex = -1;

  for (const entry of turn) {
    for (const request of toolRequestsOf(entry)) {
      if (request?.toolCallId) toolNames.set(String(request.toolCallId), String(request.name ?? ''));
    }
    const callId = String(entry?.data?.toolCallId ?? entry?.toolCallId ?? '');
    const loggedName = String(entry?.data?.toolName ?? '');
    if (loggedName && callId) toolNames.set(callId, loggedName);

    if (isTaskCompleteEvent(entry)) {
      reportIndex = items.length;
      items.push({ text: '', toolWork: false, report: true });
      continue;
    }
    if (isAssistantEntry(entry)) {
      const requests = toolRequestsOf(entry);
      const report = requests.length > 0 && requests.every((request) => isTaskCompleteName(request?.name));
      if (report) reportIndex = items.length;
      items.push({
        text: assistantTextOf(entry),
        toolWork: hasToolWorkOf(entry),
        step: !report,
        report,
      });
      continue;
    }
    if (hasToolWorkOf(entry)) {
      // A tool result or execution log still marks where the last step ended, unless
      // the call it ran was the report itself.
      const report = isTaskCompleteName(loggedName || toolNames.get(callId));
      if (report) reportIndex = items.length;
      items.push({ text: '', toolWork: true, report });
    }
  }

  return { items, reportIndex };
}

/**
 * The text the reader can see outside the collapsed rows.
 *
 * @param {any[]} turn entries of one turn
 * @param {number} [start] index in `turn` where the answer may begin
 * @returns {string}
 */
function answerTextOf(turn, start = 0) {
  return answerOf(turnItems(turn.slice(start)).items);
}

/**
 * The short note the local harness writes after the `task_complete` row. It reads as
 * the harness's own summary of the answer ("Answered above — …"), so when the agent
 * reported no summary of its own this one is used *instead of* counting the note as
 * more answer text — which would otherwise post the same thing twice.
 *
 * @param {import('../answer.mjs').AnswerItem[]} items
 * @param {number} reportIndex
 * @returns {string}
 */
function closingTextOf(items, reportIndex) {
  if (reportIndex < 0) return '';
  for (let index = items.length - 1; index > reportIndex; index -= 1) {
    const item = items[index] ?? {};
    if (item.report || item.toolWork) continue;
    const text = String(item.text ?? '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * The assistant text of the turn that ends at `entries`.
 *
 * `text` is what a reader should see for the whole turn: the answer, then the
 * `task_complete` summary under its `done` label. `answer` and `summary` are the two
 * parts on their own, so a caller can tell what is new when a turn is reported more
 * than once — the answer is sent as soon as it exists, and the summary follows on its
 * own if the agent reports it later.
 *
 * `reported` says whether the turn ended by reporting its result through
 * `task_complete`; a turn that never reports one is complete all the same, so its
 * answer is not held back waiting for it.
 *
 * @param {any[]} entries
 * @param {{ agent?: string }} [options] the harness, named in the `done` label
 * @returns {{ text: string, answer: string, summary: string, id: string, reported: boolean }}
 */
export function turnOf(entries, options = {}) {
  if (!Array.isArray(entries) || !entries.length) {
    return { text: '', answer: '', summary: '', id: '', reported: false };
  }

  const start = turnStart(entries);
  const turn = entries.slice(start);
  const { items, reportIndex } = turnItems(turn);
  const reported = reportedTaskComplete(turn);

  // The whole last section up to the report: every visible message, with the
  // collapsed tool and `task_complete` rows passed over.
  let answer = answerOf(reportIndex >= 0 ? items.slice(0, reportIndex + 1) : items);

  // A turn that only reported its result has no answer of its own: the text the
  // reader saw is the previous turn's. That is the turn the host nudged to finish.
  if (!answer && reported) {
    const previous = turnStart(entries, start - 1);
    answer = answerTextOf(entries.slice(previous, start));
  }

  let id = '';
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const entry = turn[index];
    if (!isAssistantEntry(entry) || !assistantTextOf(entry)) continue;
    id = assistantIdOf(entry);
    break;
  }

  // The reported result, else the harness's own closing note: either way it is the
  // `done` note, never a replacement for the answer.
  const summary = reported ? taskSummaryOf(turn) || closingTextOf(items, reportIndex) : '';
  // The answer leads; the summary follows under the label, as the panel shows them.
  const text = mergeAnswerAndSummary(answer, summary, doneLabelOf(options.agent)).trim();

  // A pathological answer is not worth more than the cap; keep its end, where the
  // conclusion is.
  const capped = text.length > MAX_TEXT ? `…\n\n${text.slice(text.length - MAX_TEXT)}` : text;

  return {
    text: capped.trim(),
    answer: answer.trim(),
    summary: summary.trim(),
    id,
    reported,
  };
}

/**
 * Where the turn that ends at `from` begins: the entry after its user message.
 *
 * @param {any[]} entries
 * @param {number} [from] index to search backwards from, inclusive
 * @returns {number}
 */
function turnStart(entries, from = entries.length - 1) {
  for (let index = Math.min(from, entries.length - 1); index >= 0; index -= 1) {
    if (isUserEntry(entries[index])) return index + 1;
  }
  return 0;
}

/**
 * Convenience wrapper when only the text matters.
 *
 * @param {string|undefined|null} transcriptPath
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string>}
 */
export async function readLastAssistantText(transcriptPath, options = {}) {
  return (await readLastAssistantMessage(transcriptPath, options)).text;
}

/**
 * Finds a transcript when the hook payload does not name one. Copilot keeps
 * `~/.copilot/session-state/<id>/events.jsonl`; Claude Code keeps
 * `~/.claude/projects/<project>/<id>.jsonl`.
 *
 * @param {{ hint?: string|null, sessionId?: string|null }} input
 * @returns {string|null}
 */
export function findTranscript({ hint, sessionId } = {}) {
  if (hint && fs.existsSync(hint)) return hint;

  const id = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!id) return null;

  const candidates = [
    path.join(os.homedir(), '.copilot', 'session-state', id, 'events.jsonl'),
    path.join(os.homedir(), '.copilot', 'session-state', id, 'transcript.jsonl'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Claude Code names the file after the session inside a per-project folder.
  const projects = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const project of fs.readdirSync(projects)) {
      const candidate = path.join(projects, project, `${id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* no Claude projects folder */
  }
  return null;
}
