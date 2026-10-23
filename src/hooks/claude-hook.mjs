#!/usr/bin/env node
/**
 * Claude Code hook adapter.
 *
 * Blocking hooks (PermissionRequest, PreToolUse) send the prompt to Telegram and
 * print the native decision JSON that Claude Code reads from stdout. Everything
 * else is a fire-and-forget notification.
 */
import fs from 'node:fs';
import { loadConfigForHooks } from '../config.mjs';
import { log } from '../logger.mjs';
import { finish, postEvent, readHookInput, shorten } from './adapter-utils.mjs';

const AFFIRMATIVE = /^(y|yes|yeah|yep|ok|okay|allow|approve|approved|accept|1)$/i;
const NEGATIVE = /^(n|no|nope|deny|denied|reject|cancel|stop|0)$/i;

const PERMISSION_OPTIONS = ['Allow once', 'Deny'];

async function main() {
  const input = await readHookInput();
  const eventName = String(input.hook_event_name || input.hookEventName || input.event || '').trim();
  const config = loadConfigForHooks();
  const timeoutSeconds = hookTimeoutSeconds(config);

  switch (eventName) {
    case 'PermissionRequest':
      return await handlePermissionRequest(input, timeoutSeconds);
    case 'PreToolUse':
      return await handlePreToolUse(input, timeoutSeconds);
    case 'Notification':
      return await handleNotification(input);
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

async function handlePermissionRequest(input, timeoutSeconds) {
  const tool = input.tool_name || 'a tool';
  const result = await postEvent(
    'claude',
    {
      type: 'permission',
      title: `Claude Code needs permission: ${tool}`,
      message: input.message || `Claude Code wants to use ${tool}.`,
      detail: input.tool_input ? shorten(input.tool_input, 1200) : '',
      cwd: input.cwd || '',
      options: PERMISSION_OPTIONS,
      waitForReply: true,
      timeoutSeconds,
    },
    { timeoutMs: (timeoutSeconds + 20) * 1000 },
  );

  const answer = answerOf(result);
  if (!answer) return finish(null);

  const choice = interpretPermissionAnswer(answer, result?.optionIndex);
  if (choice === 'allow') {
    return finish({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
  }
  if (choice === 'deny') {
    return finish({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: 'Denied from Telegram.',
        },
      },
    });
  }
  return finish({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: `User replied from Telegram: ${answer}` },
    },
  });
}

/**
 * @returns {'allow'|'deny'|'text'}
 */
function interpretPermissionAnswer(answer, optionIndex) {
  if (optionIndex === 0) return 'allow';
  if (optionIndex === 1) return 'deny';
  const text = String(answer).trim();
  if (AFFIRMATIVE.test(text)) return 'allow';
  if (NEGATIVE.test(text)) return 'deny';
  return 'text';
}

async function handlePreToolUse(input, timeoutSeconds) {
  const tool = input.tool_name;
  if (tool !== 'AskUserQuestion') return finish(null);

  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  if (!questions.length) return finish(null);

  const options = questions.length === 1 ? optionLabels(questions[0]) : [];
  const prompt =
    questions.length === 1
      ? String(questions[0].question || 'Claude Code has a question.')
      : questions.map((question, index) => `Q${index + 1}: ${question.question}`).join('\n');

  const result = await postEvent(
    'claude',
    {
      type: 'question',
      title: questions.length === 1 ? questions[0].header || 'Claude Code question' : 'Claude Code questions',
      message: prompt,
      cwd: input.cwd || '',
      options,
      waitForReply: true,
      timeoutSeconds,
      replyPrompt:
        questions.length > 1
          ? 'Answer with one value per question, separated by " | ".'
          : 'Tap an option or reply with your own answer.',
    },
    { timeoutMs: (timeoutSeconds + 20) * 1000 },
  );

  const answer = answerOf(result);
  if (!answer) return finish(null);

  return finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildQuestionReason(questions, answer),
    },
  });
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

async function handleNotification(input) {
  const message = String(input.message || '').trim();
  if (!message) return finish(null);

  const looksLikePrompt = /permission|waiting for your input|needs your|approval/i.test(message);
  await postEvent('claude', {
    type: looksLikePrompt ? 'question' : 'info',
    title: 'Claude Code needs attention',
    message,
    cwd: input.cwd || '',
    replyPrompt: 'Answer in the Claude Code terminal to continue.',
    waitForReply: false,
  });
  return finish(null);
}

async function handleCompleted(eventName, input) {
  const summary = await lastAssistantText(input.transcript_path);
  await postEvent('claude', {
    type: 'completed',
    title: eventName === 'TaskCompleted' ? 'Claude Code task completed' : 'Claude Code finished',
    message: summary || undefined,
    detail: eventName === 'StopFailure' ? shorten(input.error || input.reason || '', 800) : '',
    cwd: input.cwd || '',
  });
  return finish(null);
}

function answerOf(result) {
  if (!result || result.ok === false) return null;
  const value = result.text ?? result.answer ?? result.reply;
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
}

/**
 * Reads only the tail of the transcript: enough for the closing assistant text.
 *
 * @param {string|undefined} transcriptPath
 */
async function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const stat = await fs.promises.stat(transcriptPath);
    const start = Math.max(0, stat.size - 64 * 1024);
    const handle = await fs.promises.open(transcriptPath, 'r');
    try {
      const length = Math.min(stat.size - start, 64 * 1024);
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
        if (entry?.type !== 'assistant') continue;
        const content = entry.message?.content;
        const text = Array.isArray(content)
          ? content
              .filter((part) => part?.type === 'text' && part.text)
              .map((part) => part.text)
              .join('\n')
              .trim()
          : '';
        if (text) return shorten(text, 1200);
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
  log.error(`claude hook failed: ${err.stack || err.message}`);
  finish(null);
});
