#!/usr/bin/env node
/**
 * Copilot (GitHub Copilot CLI / agent hooks) adapter.
 *
 * Hook payload field names differ between Copilot releases, so every field is
 * read through a few aliases. This adapter only reports turns and failures:
 * permission requests and questions are read from the agent host's own event log
 * (see src/copilot-events.mjs), because a `permissionRequest` hook runs before
 * Copilot decides whether the user is asked at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfigForHooks } from '../config.mjs';
import { log } from '../logger.mjs';
import { withoutLeadIn } from '../answer.mjs';
import { agentOf as detectAgent, errorTextOf, finish, postEvent, readHookInput, shorten } from './adapter-utils.mjs';
import { findTranscript, isSystemPromptOf, readLastAssistantMessage } from './transcript.mjs';

const COMPLETED_EVENTS = new Set(['sessionend', 'agentstop', 'taskcomplete', 'stop', 'complete', 'finished']);

/** The installer passes the event name, because not every host sends it on stdin. */
const EVENT_ARGUMENT = process.argv.slice(2).find((value) => !value.startsWith('-'));

/**
 * Which agent is reporting, decided from the payload when it says so.
 *
 * Two harnesses send these hooks with the same command line, so the argument cannot
 * tell them apart and neither can the transcript's contents:
 *
 * - **Copilot** (the agent host) sends camelCase fields — `sessionId`,
 *   `transcriptPath`, `stopReason` — and keeps its session under
 *   `~/.copilot/session-state/<id>/events.jsonl`.
 * - **Local harness** (VS Code's in-process Copilot Chat agent) sends the Claude-style
 *   snake_case fields — `hook_event_name`, `session_id`, `transcript_path` — and keeps
 *   its transcript under `…/workspaceStorage/<ws>/GitHub.copilot-chat/transcripts/`.
 *
 * `--agent local` and `TELEGRAM_NOTIFY_HOOK_AGENT=local` still force the local name, for
 * a harness of your own that reuses this adapter.
 *
 * @param {any} input the hook payload
 * @returns {'local'|'copilot'}
 */
export function agentOf(input) {
  const forced = agentArgument();
  return detectAgent(input, { forced });
}

/**
 * An explicit `--agent` / env override, when one was given.
 *
 * @returns {'local'|''}
 */
function agentArgument() {
  const inline = process.argv.slice(2).find((value) => value.startsWith('--agent='));
  const index = process.argv.indexOf('--agent');
  const named =
    (inline ? inline.slice('--agent='.length) : '') ||
    (index > 0 ? process.argv[index + 1] ?? '' : '') ||
    process.env.TELEGRAM_NOTIFY_HOOK_AGENT ||
    '';
  return String(named).trim().toLowerCase() === 'local' ? 'local' : '';
}

/** The agent that will report this payload. */
let AGENT = 'copilot';

/** How the agent is named in a fallback message. */
function label() {
  return AGENT === 'local' ? 'Local agent' : 'Copilot';
}

async function main() {
  const input = await readHookInput();
  // The payload says which harness sent it; everything below reports under that name.
  AGENT = agentOf(input);
  const eventName = normalizeEvent(
    EVENT_ARGUMENT ||
      input.hookEventName ||
      input.hook_event_name ||
      input.eventName ||
      input.event ||
      input.type ||
      inferredEvent(input),
  );
  const config = loadConfigForHooks();

  switch (eventName) {
    case 'erroroccurred':
      return await handleError(input);
    case 'userpromptsubmitted': {
      const prompt = promptOf(input);
      // The agent host writes its own "keep going" prompt when a turn stopped early.
      // It is not the user asking anything, so it is not listed as a task; the bridge
      // uses it to drop the completion it was holding for the interrupted turn.
      const synthetic = isSystemPromptOf(prompt);
      // Always report it: the bridge records which agent is in use, so the next
      // Telegram prompt goes there. Only `notifyOnStart` makes it a message.
      await postEvent(AGENT, {
        agent: AGENT,
        type: 'info',
        // The bridge names the agent; this stays neutral so the local harness can reuse it.
        title: synthetic ? 'continued the task on its own' : 'received a prompt',
        message: shorten(prompt, 600),
        cwd: cwdOf(input),
        // A prompt started in the Chat panel is work in progress: the bridge lists
        // it with the prompts it runs itself, and clears it when the turn ends.
        promptStart: true,
        ...(synthetic ? { synthetic: true } : {}),
        sessionId: sessionIdOf(input),
        ...(config.notifyOnStart && !synthetic ? {} : { silent: true }),
      });
      return finish(null);
    }
    default:
      if (COMPLETED_EVENTS.has(eventName) || eventName === 'notification') {
        return await handleCompleted(eventName, input);
      }
      log.debug(`copilot hook ${eventName || '(unknown)'} ignored`);
      return finish(null);
  }
}

function normalizeEvent(value) {
  return String(value).toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * The VS Code agent host sends no event name: a Stop payload carries the stop
 * reason, and a session end carries a reason plus the closed session.
 */
function inferredEvent(input) {
  if (input.stopReason !== undefined || input.stop_hook_active !== undefined) return 'agentStop';
  if (typeof input.reason === 'string' && input.sessionId) return 'sessionEnd';
  return '';
}

function cwdOf(input) {
  return input.cwd || input.workingDirectory || input.working_directory || '';
}

function sessionIdOf(input) {
  return input.sessionId || input.session_id || input.sessionID || '';
}

function promptOf(input) {
  return input.prompt || input.message || input.userMessage || input.user_message || '';
}

/**
 * The failure an `ErrorOccurred` (Copilot) or `StopFailure` (local harness) reports.
 *
 * @param {any} input
 * @returns {string}
 */
function errorOf(input) {
  return errorTextOf(input.error ?? input.errorMessage ?? input.message, `${label()} reported an error.`);
}

async function handleError(input) {
  await postEvent(AGENT, {
    type: 'error',
    title: 'error',
    // The host sends an object (`{ name, message, stack }`), and its message may itself
    // be JSON; passing either straight through reaches the chat as "[object Object]".
    message: errorOf(input),
    // The context says which step failed, which the message alone usually does not.
    detail: shorten(input.errorContext ?? input.error_context ?? '', 1500),
    cwd: cwdOf(input),
  });
  return finish(null);
}

async function handleCompleted(eventName, input) {
  const sessionId = input.sessionId || input.session_id || '';
  const transcript = findTranscript({
    // The local harness names its transcript in `transcript_path`; the Copilot host uses
    // `transcriptPath`. Either way the hint is where the turn's answer is.
    hint: input.transcriptPath || input.transcript_path || input.transcriptFile || '',
    sessionId,
  });
  const found = await readLastAssistantMessage(transcript);
  // What a hook payload carries itself beats the transcript: a host that sends the
  // answer in the payload does not need it read from a file.
  const payloadText = String(input.message || input.result || '').trim();

  // Copilot fires agentStop and then sessionEnd for the same finish, and may
  // repeat either. Copilot's own event names are the distinction: only agentStop
  // means "the turn ended", so sessionEnd never notifies on its own and the
  // duplicate cannot be produced in the first place.
  if (eventName === 'sessionend') {
    log.debug(`session ${sessionId} ended; the turn was already reported by agentStop`);
    return finish(null);
  }

  // One message per turn: the answer is sent as soon as the turn ends, and the
  // `task_complete` summary follows as its own message if the host reports it later.
  // What was already sent for this session decides that, because the host repeats
  // `agentStop` (and Copilot's own nudged continuation re-stops the same answer).
  const full = String(payloadText || found.text || '').trim();
  const answer = String(payloadText || found.answer || '').trim();
  const reported = String(found.summary ?? '').trim();
  const answerHash = answer ? hash(answer) : '';
  const summaryHash = reported ? hash(reported) : '';
  const sent = readSent(sessionId);
  const fresh = !sent || Date.now() - (Number(sent.at) || 0) > STOP_DEDUPE_MS;
  const known = fresh ? {} : sent;

  // What is actually new for this session. The answer is what the reader has seen; the
  // summary is what the host reported afterwards.
  const answerIsNew = Boolean(answerHash) && known.answer !== answerHash;
  const summaryIsNew = Boolean(summaryHash) && known.summary !== summaryHash;

  if (!answerIsNew && !summaryIsNew && (answerHash || summaryHash)) {
    log.debug(`duplicate completion for session ${sessionId} ignored`);
    return finish(null);
  }

  // The answer was already sent, so only the summary is new: it goes out on its own.
  const summaryOnly = summaryIsNew && !answerIsNew && Boolean(answerHash);

  await postEvent(AGENT, {
    type: 'completed',
    // The bridge names the agent in the heading (`titleForAgent`), so the hook sends
    // the event, not a product name — the local harness reuses this adapter.
    title: eventName === 'notification' ? 'needs attention' : summaryOnly ? 'task completed' : 'finished',
    // The summary stands alone in this message, so its meta lead-in ("Answered the
    // factual question:") would only be noise: the heading already says what it is.
    message: summaryOnly ? withoutLeadIn(reported) : full || reported || undefined,
    // Say why it stopped when there is nothing else to show, instead of leaving
    // the reader with a bare "task finished".
    detail:
      full || reported || !(input.stopReason || input.stop_reason)
        ? ''
        : `stop reason: ${input.stopReason || input.stop_reason}\nsession: ${sessionId || 'unknown'}`,
    cwd: cwdOf(input),
    // Ends the running prompt this turn belonged to.
    sessionId,
  });

  // Keep the summary already reported: a later repeat must not look unreported.
  writeSent(sessionId, {
    answer: answerHash || sent?.answer || '',
    summary: summaryHash || sent?.summary || '',
    at: Date.now(),
  });
  return finish(null);
}

/** A repeat of the same turn inside this window is a duplicate. */
const STOP_DEDUPE_MS = 2 * 60 * 1000;

/**
 * @param {string} sessionId
 */
function markerDir() {
  return path.join(os.tmpdir(), 'telegram-notify');
}

/**
 * @param {string} value
 * @returns {string}
 */
function hash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * What was already sent for a session: the answer it was notified with, and the
 * `task_complete` summary if one arrived later.
 *
 * @param {string} sessionId
 * @returns {{ answer?: string, summary?: string, at?: number }|null}
 */
function readSent(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sentFile(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionId
 * @param {{ answer: string, summary: string, at: number }} state
 */
function writeSent(sessionId, state) {
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(sentFile(sessionId), JSON.stringify(state));
    pruneMarkers();
  } catch (err) {
    // A read-only temp dir must not stop the notification.
    log.debug(`could not record the completion of ${sessionId}: ${err.message}`);
  }
}

/** @param {string} sessionId */
function sentFile(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '') || 'unknown-session';
  return path.join(markerDir(), `${safe}.sent.json`);
}

/** Keeps the marker directory from growing forever. */
function pruneMarkers() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(markerDir())) {
      const file = path.join(markerDir(), name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        /* another process removed it */
      }
    }
  } catch {
    /* nothing to prune */
  }
}

function answerOf(result) {
  if (!result || result.ok === false) return null;
  const value = result.text ?? result.answer ?? result.reply;
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
}

main().catch((err) => {
  log.error(`copilot hook failed: ${err.stack || err.message}`);
  finish(null);
});
