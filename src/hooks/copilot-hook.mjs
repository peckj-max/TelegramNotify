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
import { finish, postEvent, readHookInput, shorten } from './adapter-utils.mjs';
import { findTranscript, isSystemPromptOf, readLastAssistantMessage } from './transcript.mjs';

const COMPLETED_EVENTS = new Set(['sessionend', 'agentstop', 'taskcomplete', 'stop', 'complete', 'finished']);

/** The installer passes the event name, because not every host sends it on stdin. */
const EVENT_ARGUMENT = process.argv.slice(2).find((value) => !value.startsWith('-'));

async function main() {
  const input = await readHookInput();
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
      await postEvent('copilot', {
        agent: 'copilot',
        type: 'info',
        title: synthetic ? 'Copilot continued the task on its own' : 'Copilot received a prompt',
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

async function handleError(input) {
  await postEvent('copilot', {
    type: 'error',
    title: 'Copilot error',
    message: input.error || input.errorMessage || input.message || 'Copilot reported an error.',
    cwd: cwdOf(input),
  });
  return finish(null);
}

async function handleCompleted(eventName, input) {
  const sessionId = input.sessionId || input.session_id || '';
  const transcript = findTranscript({
    hint: input.transcriptPath || input.transcript_path || input.transcriptFile,
    sessionId,
  });
  const found = await readLastAssistantMessage(transcript);
  const summary = input.message || input.result || found.text;

  // Copilot fires agentStop and then sessionEnd for the same finish, and may
  // repeat either. Copilot's own event names are the distinction: only agentStop
  // means "the turn ended", so sessionEnd never notifies on its own and the
  // duplicate cannot be produced in the first place.
  if (eventName === 'sessionend') {
    log.debug(`session ${sessionId} ended; the turn was already reported by agentStop`);
    return finish(null);
  }

  // A host that repeats agentStop must not notify twice for the same turn. The
  // transcript identifies the turn: its last message id, whether that turn reported
  // its result, and its text. The reported flag matters because the host stops a turn
  // that has not finished (no `task_complete`), nudges it, and then stops it again —
  // both stops share the answer's message id, so id alone would swallow the second,
  // finished one and the prompt would never reach the chat.
  //
  // With no text there is nothing to compare, and the turn must be reported rather
  // than dropped: claimCompletion allows an empty key.
  const content = found.text || summary || '';
  const turnKey = content ? `${found.id}|${found.reported}|${content}` : '';
  if (!claimCompletion(sessionId, turnKey)) {
    log.debug(`duplicate completion for session ${sessionId} ignored`);
    return finish(null);
  }

  await postEvent('copilot', {
    type: 'completed',
    title: eventName === 'notification' ? 'Copilot needs attention' : 'Copilot finished',
    message: summary || undefined,
    // Say why it stopped when there is nothing else to show, instead of leaving
    // the reader with a bare "task finished".
    detail:
      summary || !(input.stopReason || input.stop_reason)
        ? ''
        : `stop reason: ${input.stopReason || input.stop_reason}\nsession: ${sessionId || 'unknown'}`,
    cwd: cwdOf(input),
    // Ends the running prompt this turn belonged to.
    sessionId,
    // A turn that stopped without reporting its result may be continued by the host
    // on its own; the bridge holds it instead of sending an answer that will be
    // overtaken seconds later.
    ...(found.reported === false ? { interim: true } : {}),
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
 * Claims the completion for one turn and reports whether the caller may notify.
 * `wx` makes the claim atomic, so two hooks racing for the same turn cannot both
 * win.
 *
 * When the turn cannot be identified there is nothing to compare, so the
 * notification is allowed rather than silently suppressed.
 *
 * @param {string} sessionId
 * @param {string} turnKey what identifies the turn; the caller decides (message id,
 *   whether the turn reported its result, and its text)
 * @returns {boolean}
 */
function claimCompletion(sessionId, turnKey) {
  if (!String(turnKey || '').trim()) return true;

  const safe = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '') || 'unknown-session';
  const fingerprint = createHash('sha1').update(String(turnKey)).digest('hex').slice(0, 16);
  const file = path.join(markerDir(), `${safe}.${fingerprint}.done`);

  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(file, String(Date.now()), { flag: 'wx' });
    pruneMarkers();
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') {
      try {
        const stamp = Number(fs.readFileSync(file, 'utf8'));
        if (Date.now() - stamp > STOP_DEDUPE_MS) {
          fs.writeFileSync(file, String(Date.now()));
          return true;
        }
      } catch {
        /* unreadable marker: treat as a duplicate */
      }
      return false;
    }
    // A read-only temp dir must not stop the notification.
    log.debug(`could not record completion for ${sessionId}: ${err.message}`);
    return true;
  }
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
