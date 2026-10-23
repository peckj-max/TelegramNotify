#!/usr/bin/env node
/**
 * Copilot (GitHub Copilot CLI / agent hooks) adapter.
 *
 * Hook payload field names differ between Copilot releases, so every field is
 * read through a few aliases. Permission decisions are only requested when the
 * hook was installed with approvals enabled, because a blocking preToolUse hook
 * turns every tool call into a Telegram round trip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigForHooks } from '../config.mjs';
import { log } from '../logger.mjs';
import { finish, postEvent, readHookInput, shorten } from './adapter-utils.mjs';

const PERMISSION_OPTIONS = ['Allow once', 'Deny'];
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
  const timeoutSeconds = hookTimeoutSeconds(config);

  switch (eventName) {
    case 'pretooluse':
    case 'permissionrequest':
      return await handlePermission(eventName, input, timeoutSeconds);
    case 'erroroccurred':
      return await handleError(input);
    case 'userpromptsubmitted':
      if (config.notifyOnStart) {
        await postEvent('copilot', {
          type: 'info',
          title: 'Copilot received a prompt',
          message: shorten(promptOf(input), 600),
          cwd: cwdOf(input),
        });
      }
      return finish(null);
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

function promptOf(input) {
  return input.prompt || input.message || input.userMessage || input.user_message || '';
}

function toolOf(input) {
  return input.toolName || input.tool_name || input.tool || '';
}

function toolArgsOf(input) {
  return input.toolArgs ?? input.tool_args ?? input.toolInput ?? input.tool_input ?? null;
}

function hookTimeoutSeconds(config) {
  const fromEnv = Number(process.env.TELEGRAM_NOTIFY_HOOK_TIMEOUT);
  if (Number.isFinite(fromEnv) && fromEnv > 5) return Math.max(5, Math.floor(fromEnv) - 5);
  return config.replyTimeoutSeconds;
}

async function handlePermission(eventName, input, timeoutSeconds) {
  const tool = toolOf(input) || 'a tool';
  const result = await postEvent(
    'copilot',
    {
      type: 'permission',
      title: `Copilot needs permission: ${tool}`,
      message: input.message || input.permissionDescription || `Copilot wants to use ${tool}.`,
      detail: toolArgsOf(input) ? shorten(toolArgsOf(input), 1200) : '',
      cwd: cwdOf(input),
      options: PERMISSION_OPTIONS,
      waitForReply: true,
      timeoutSeconds,
    },
    { timeoutMs: (timeoutSeconds + 20) * 1000 },
  );

  const answer = answerOf(result);
  if (!answer) return finish(null);

  const allow = result?.optionIndex === 0 || /^(y|yes|ok|allow|approve|1)$/i.test(answer);
  const deny = result?.optionIndex === 1 || /^(n|no|deny|reject|cancel|0)$/i.test(answer);
  const decision = allow ? 'allow' : 'deny';

  return finish({
    permissionDecision: decision,
    permissionDecisionReason: allow
      ? 'Approved from Telegram.'
      : deny
        ? 'Denied from Telegram.'
        : `User replied from Telegram: ${answer}`,
    hookSpecificOutput: {
      hookEventName: eventName === 'permissionrequest' ? 'permissionRequest' : 'preToolUse',
      permissionDecision: decision,
      permissionDecisionReason: allow ? 'Approved from Telegram.' : 'Denied from Telegram.',
    },
  });
}

async function handleError(input) {
  await postEvent('copilot', {
    type: 'error',
    title: 'Copilot error',
    message: shorten(input.error || input.errorMessage || input.message || 'Copilot reported an error.', 800),
    cwd: cwdOf(input),
  });
  return finish(null);
}

async function handleCompleted(eventName, input) {
  const sessionId = input.sessionId || input.session_id || '';
  // VS Code emits agentStop and then sessionEnd for the same finish; the second
  // one would duplicate the notification.
  if (eventName === 'sessionend' && stoppedRecently(sessionId)) {
    log.debug(`session ${sessionId} already reported by agentStop`);
    return finish(null);
  }
  if (eventName === 'agentstop') markStopped(sessionId);

  const summary = input.message || input.result || (await lastAssistantText(input.transcriptPath || input.transcript_path));
  await postEvent('copilot', {
    type: 'completed',
    title: eventName === 'notification' ? 'Copilot needs attention' : 'Copilot finished',
    message: summary ? shorten(summary, 1200) : undefined,
    cwd: cwdOf(input),
  });
  return finish(null);
}

const STOP_DEDUPE_MS = 2 * 60 * 1000;

function stoppedMarker(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
  return safe ? path.join(os.tmpdir(), 'telegram-notify', `${safe}.stopped`) : null;
}

function markStopped(sessionId) {
  const file = stoppedMarker(sessionId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
  } catch (err) {
    log.debug(`could not record stop for ${sessionId}: ${err.message}`);
  }
}

function stoppedRecently(sessionId) {
  const file = stoppedMarker(sessionId);
  if (!file) return false;
  try {
    const stamp = Number(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(stamp) && Date.now() - stamp < STOP_DEDUPE_MS;
  } catch {
    return false;
  }
}

function answerOf(result) {
  if (!result || result.ok === false) return null;
  const value = result.text ?? result.answer ?? result.reply;
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
}

async function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const stat = await fs.promises.stat(transcriptPath);
    const start = Math.max(0, stat.size - 64 * 1024);
    const length = Math.min(stat.size - start, 64 * 1024);
    const handle = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const content = entry?.data?.content ?? entry?.message?.content ?? entry?.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((part) => part?.type === 'text' && part.text)
            .map((part) => part.text)
            .join('\n')
            .trim();
          if (text) return text;
        } else if (typeof content === 'string' && content.trim()) {
          return content;
        }
      }
    } finally {
      await handle.close();
    }
  } catch (err) {
    log.debug(`could not read transcript: ${err.message}`);
  }
  return '';
}

main().catch((err) => {
  log.error(`copilot hook failed: ${err.stack || err.message}`);
  finish(null);
});
