#!/usr/bin/env node
/**
 * Claude Code hook adapter.
 *
 * `PreToolUse` (AskUserQuestion) follows the shared ask rule in ask.mjs: Telegram
 * asks first for a few seconds, and when nobody answers the hook prints nothing so
 * Claude Code raises its own question. Permissions are not intercepted: the
 * `PermissionRequest` hook is no longer installed, and `Notification` reports the
 * prompt Claude Code already shows, so the panel or terminal owns the decision.
 * Everything else is a fire-and-forget notification.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfigForHooks } from '../config.mjs';
import { log } from '../logger.mjs';
import { finish, postEvent, readHookInput, shorten } from './adapter-utils.mjs';
import { AUTOMATED_MODES, askPlan, askReplyPrompt, claudePermissionMode } from './ask.mjs';
import { findTranscript, readLastAssistantMessage } from './transcript.mjs';

/**
 * Set by `runClaudePrompt` on the `claude` process a Telegram prompt spawns.
 *
 * A headless run has no panel and no terminal, so a request it cannot ask in
 * Telegram would never be answered: it waits for the full reply timeout instead of
 * handing the prompt back.
 *
 * The name matches `CLAUDE_HEADLESS_RUN_ENV` in remote-prompt.mjs.
 */
const HEADLESS_RUN = process.env.TELEGRAM_NOTIFY_CLAUDE_RUN === '1';

async function main() {
  const input = await readHookInput();
  const eventName = String(input.hook_event_name || input.hookEventName || input.event || '').trim();
  const config = loadConfigForHooks();
  const timeoutSeconds = hookTimeoutSeconds(config);

  switch (eventName) {
    case 'PreToolUse':
      return await handlePreToolUse(input, timeoutSeconds, config);
    case 'Notification':
      return await handleNotification(input);
    case 'UserPromptSubmit':
      return await handlePromptSubmitted(input, config);
    case 'Stop':
    case 'StopFailure':
    case 'SubagentStop':
    case 'TaskCompleted':
    case 'SessionEnd':
      return await handleCompleted(eventName, input);
    default:
      log.debug(`claude hook ${eventName || '(unknown)'} ignored`);
      return finish(null);
  }
}

function hookTimeoutSeconds(config) {
  const fromEnv = Number(process.env.TELEGRAM_NOTIFY_HOOK_TIMEOUT);
  if (Number.isFinite(fromEnv) && fromEnv > 5) return Math.max(5, Math.floor(fromEnv) - 5);
  return config.replyTimeoutSeconds;
}

/**
 * Telegram first, Claude Code's own question when the window closes.
 *
 * @param {any} input
 * @param {number} timeoutSeconds
 * @param {import('../config.mjs').RuntimeConfig} config
 */
async function handlePreToolUse(input, timeoutSeconds, config) {
  const tool = input.tool_name;
  if (tool !== 'AskUserQuestion') return finish(null);

  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  if (!questions.length) return finish(null);

  const plan = askPlan(config, {
    headless: HEADLESS_RUN,
    automated: AUTOMATED_MODES.claude.includes(claudePermissionMode(input)),
  });
  // `handoff`: the Chat panel or the terminal asks, so the hook says nothing.
  if (plan.mode === 'handoff') return finish(null);
  const waitSeconds = plan.seconds || timeoutSeconds;
  const text =
    questions.length === 1
      ? String(questions[0].question || 'Claude Code has a question.')
      : questions.map((question, index) => `Q${index + 1}: ${question.question}`).join('\n');

  const result = await postEvent(
    'claude',
    {
      type: 'question',
      title: questions.length === 1 ? questions[0].header || 'Claude Code question' : 'Claude Code questions',
      message: text,
      cwd: input.cwd || '',
      options: questions.length === 1 ? optionLabels(questions[0]) : [],
      waitForReply: true,
      timeoutSeconds: waitSeconds,
      replyPrompt:
        questions.length > 1
          ? 'Answer with one value per question, separated by " | ", or answer them where the turn runs.'
          : plan.mode === 'ask'
            ? askReplyPrompt(waitSeconds, 'Claude Code asks in its own window')
            : '',
    },
    { timeoutMs: (waitSeconds + 20) * 1000 },
  );

  const answer = answerOf(result);
  if (!answer) {
    // Printing no decision leaves the question to Claude Code, which shows it in
    // the Chat panel or the terminal.
    return finish(null);
  }
  return finish(questionDecision(questions, answer));
}

/**
 * The tool cannot ask interactively once the chat answered, so the answer travels
 * back as the reason Claude reads next.
 *
 * @param {any[]} questions
 * @param {string} answer
 */
function questionDecision(questions, answer) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildQuestionReason(questions, answer),
    },
  };
}

function optionLabels(question) {
  if (!Array.isArray(question?.options)) return [];
  const labels = question.options.map((option) => (typeof option === 'string' ? option : option?.label)).filter(Boolean);
  return labels.slice(0, 8);
}

/**
 * The user answered somewhere other than the terminal, so the tool cannot run
 * interactively. The answer travels back as the reason Claude reads next.
 */
function buildQuestionReason(questions, answer) {
  const parts = String(answer)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (questions.length <= 1) {
    return `The user answered from Telegram: "${answer}". Continue with that answer; do not ask the same question again.`;
  }

  const lines = questions.map((question, index) => {
    const value = parts[index] ?? (parts.length === 1 ? answer : '(no answer)');
    return `${index + 1}. ${question.question} -> ${value}`;
  });
  return `The user answered from Telegram:\n${lines.join('\n')}\nContinue with these answers; do not ask the same questions again.`;
}

/**
 * Records that Claude is the agent in use, so the next Telegram prompt goes to
 * it, and announces the turn when `notifyOnStart` is on.
 */
async function handlePromptSubmitted(input, config) {
  const prompt = String(input.prompt || '').trim();
  await postEvent('claude', {
    agent: 'claude',
    type: 'info',
    title: 'Claude Code received a prompt',
    message: shorten(prompt, 600),
    cwd: input.cwd || '',
    ...(config.notifyOnStart ? {} : { silent: true }),
  });
  return finish(null);
}

async function handleNotification(input) {
  const message = String(input.message || '').trim();
  if (!message) return finish(null);

  const kind = String(input.notification_type || input.notificationType || '').toLowerCase();
  const permission =
    kind === 'permission_request' ||
    /needs your permission|permission to use|needs your approval|waiting for approval/i.test(message);

  await postEvent('claude', {
    type: permission ? 'permission' : 'info',
    title: permission ? 'Claude Code needs permission' : 'Claude Code needs attention',
    message,
    cwd: input.cwd || '',
    replyPrompt: permission
      ? 'Answer in the Claude Code panel or the terminal.'
      : 'Answer in the Claude Code terminal to continue.',
    waitForReply: false,
  });
  return finish(null);
}

async function handleCompleted(eventName, input) {
  const transcript = findTranscript({
    hint: input.transcript_path || input.transcriptPath,
    sessionId: input.session_id || input.sessionId,
  });
  const found = await readLastAssistantMessage(transcript);

  // Claude Code can report the same ending twice (Stop and SessionEnd, or a
  // subagent finishing alongside its parent). Claim the turn before posting: the
  // transcript's message id identifies it, the text is the fallback.
  const sessionId = input.session_id || input.sessionId || '';
  if (!claimCompletion(sessionId, found.id || found.text)) {
    log.debug(`duplicate ${eventName} for session ${sessionId} ignored`);
    return finish(null);
  }

  await postEvent('claude', {
    type: 'completed',
    title: eventName === 'TaskCompleted' ? 'Claude Code task completed' : 'Claude Code finished',
    message: found.text || undefined,
    detail: eventName === 'StopFailure' ? shorten(input.error || input.reason || '', 4000) : '',
    cwd: input.cwd || '',
  });
  return finish(null);
}

/** A repeat of the same turn inside this window is a duplicate. */
const STOP_DEDUPE_MS = 2 * 60 * 1000;

/**
 * Claims the completion for one turn and reports whether the caller may notify.
 * The `wx` flag makes the claim atomic, so two hooks racing for the same turn
 * cannot both win.
 *
 * When the turn cannot be identified there is nothing to compare, so the
 * notification is allowed rather than silently suppressed.
 *
 * @param {string} sessionId
 * @param {string} turnKey transcript message id, or the text as a fallback
 * @returns {boolean}
 */
function claimCompletion(sessionId, turnKey) {
  if (!String(turnKey || '').trim()) return true;

  const safe = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '') || 'unknown-session';
  const fingerprint = createHash('sha1').update(String(turnKey)).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'telegram-notify');
  const file = path.join(dir, `${safe}.${fingerprint}.done`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(Date.now()), { flag: 'wx' });
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

function answerOf(result) {
  if (!result || result.ok === false) return null;
  const value = result.text ?? result.answer ?? result.reply;
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
}

main().catch((err) => {
  log.error(`claude hook failed: ${err.stack || err.message}`);
  finish(null);
});
