import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerOf, isToolPart } from '../answer.mjs';
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
 * Whether an entry is something the user typed, which starts a new turn.
 * Both schemas report it, and a tool result also arrives as a `user` entry in
 * Claude's format, so only real prompt text counts.
 *
 * @param {any} entry
 * @returns {boolean}
 */
export function isUserEntry(entry) {
  const type = String(entry?.type ?? '');
  if (type === 'user.message') return true;
  if (type !== 'user') return false;

  const content = entry?.message?.content ?? entry?.data?.content;
  if (typeof content === 'string') return content.trim().length > 0;
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
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<{ text: string, id: string }>}
 */
export async function readLastAssistantMessage(transcriptPath, options = {}) {
  if (!transcriptPath) return { text: '', id: '' };
  const cap = options.maxBytes ?? MAX_READ_BYTES;

  let stat;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch (err) {
    log.debug(`could not stat transcript: ${err.message}`);
    return { text: '', id: '' };
  }
  if (!stat.isFile() || stat.size === 0) return { text: '', id: '' };

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

      const turn = turnOf(entries);
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
  return { text: '', id: '' };
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
    if (String(entry?.type ?? '') === 'session.task_complete') {
      const value = String(entry?.data?.summary ?? entry?.summary ?? '').trim();
      if (value) summary = value;
      continue;
    }
    if (!isAssistantEntry(entry)) continue;
    const requests = [entry?.data?.toolRequests, entry?.toolRequests].filter(Array.isArray).flat();
    for (const request of requests) {
      if (!/task[_-]?complete/i.test(String(request?.name ?? ''))) continue;
      const args = request?.arguments ?? request?.args ?? {};
      const value = String(args.summary ?? args.message ?? '').trim();
      if (value) summary = value;
    }
  }
  return summary;
}

/**
 * The assistant text of the turn that ends at `entries`.
 *
 * Only the answer is returned: what the agent host reported as the task result, or
 * else the trailing block of agent messages that do not come with a tool call.
 * Everything before it narrates the work ("let me look at the file"), and a
 * cumulative snapshot of one message is collapsed so the same sentence is not
 * posted twice.
 *
 * @param {any[]} entries
 * @returns {{ text: string, id: string }}
 */
export function turnOf(entries) {
  if (!Array.isArray(entries) || !entries.length) return { text: '', id: '' };

  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isUserEntry(entries[index])) {
      start = index + 1;
      break;
    }
  }

  const turn = entries.slice(start);
  const items = [];
  for (const entry of turn) {
    if (isAssistantEntry(entry)) {
      items.push({ text: assistantTextOf(entry), toolWork: hasToolWorkOf(entry), step: true });
    } else if (hasToolWorkOf(entry)) {
      // A tool result or execution log still marks where the last step ended.
      items.push({ text: '', toolWork: true });
    }
  }

  let id = '';
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const entry = turn[index];
    if (!isAssistantEntry(entry) || !assistantTextOf(entry)) continue;
    id = assistantIdOf(entry);
    break;
  }

  const text = taskSummaryOf(turn) || answerOf(items);

  // A pathological answer is not worth more than the cap; keep its end, where the
  // conclusion is.
  const capped = text.length > MAX_TEXT ? `…\n\n${text.slice(text.length - MAX_TEXT)}` : text;

  return { text: capped.trim(), id };
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
