import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_OPENCODE_MODEL,
  canonicalDirectory,
  continuationSessionId,
  createSession,
  discoverEndpoint,
  fetchSession,
  interruptSession,
  isServerReachable,
  parseRunOutput,
  replyToForm,
  replyToPermission,
  resolveOpenCodeBinary,
  runArguments,
  sendPrompt,
  sessionMessages,
  setSessionModel,
  turnOfPrompt,
  waitingOn,
} from './opencode-log.mjs';
import { log } from './logger.mjs';

/**
 * Runs a Telegram prompt through Claude Code headlessly and returns the answer.
 *
 * This is the fallback for a Claude prompt: VS Code Chat is where the session on
 * screen lives, so a prompt goes there first (see editor-prompt.mjs). When Chat
 * cannot take it — a bridge started from a terminal, or a window with no chat
 * session open — the Claude Agent SDK runtime the Claude Code extension itself
 * ships answers instead. It accepts a prompt, fires the same hooks and writes the
 * same `~/.claude/projects/<project>/<session>.jsonl` transcript the VS Code agent
 * produces, so the run is equivalent and can be resumed from Claude Code
 * afterwards.
 *
 * The answer is returned once, when the turn ends: nothing is streamed into
 * Telegram.
 */

/** A prompt may take a long time; the caller cancels it, not a clock. */
const DEFAULT_TIMEOUT_MS = 0;

/**
 * Set on the `claude` process a Telegram prompt spawns. The installed hooks read
 * it to tell a headless run — where nobody is looking at an editor — from a turn
 * the user started in the Chat panel or the terminal, where the agent's own UI
 * asks for permission. Exported so the hook and the run cannot drift apart.
 */
export const CLAUDE_HEADLESS_RUN_ENV = 'TELEGRAM_NOTIFY_CLAUDE_RUN';

/** Windows tidies the console output differently; strip the ANSI codes. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * Finds the Claude Code executable. Order: explicit setting, `TELEGRAM_NOTIFY_CLAUDE_BIN`,
 * PATH, then the binary the Claude Code extension ships.
 *
 * @param {string} [configured]
 * @returns {string|null}
 */
export function resolveClaudeBinary(configured) {
  if (configured) {
    const candidate = path.resolve(configured);
    return fs.existsSync(candidate) ? candidate : null;
  }

  const fromEnv = process.env.TELEGRAM_NOTIFY_CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return newestClaudeExtensionBinary();
}

/**
 * @returns {string|null}
 */
function newestClaudeExtensionBinary() {
  const roots = [
    path.join(process.env.USERPROFILE || os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';

  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('anthropic.claude-code-')) continue;
      const binary = path.join(root, entry, 'resources', 'native-binary', binaryName);
      try {
        if (fs.statSync(binary).isFile()) found.push({ binary, version: entry });
      } catch {
        /* not this build */
      }
    }
  }
  if (!found.length) return null;
  // Highest version suffix wins, so an updated extension is picked over an old one.
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0].binary;
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareVersions(left, right) {
  const numbers = (value) => (value.match(/\d+/g) || []).map(Number);
  const a = numbers(left);
  const b = numbers(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Where Claude Code keeps its sessions: `~/.claude/sessions/<pid>.json` records
 * the session each running process owns.
 */
export function claudeSessionsDir(home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  return path.join(home, 'sessions');
}

/** Whether a process with this id is running. */
function isProcessAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user; either way it is alive.
    return err?.code === 'EPERM';
  }
}

/**
 * The Claude Code session the editor is showing for this folder.
 *
 * This is what makes a Telegram prompt part of the conversation the user can see:
 * the run resumes that session id, so its turn is appended to the same transcript
 * instead of starting a session of its own — which is what left Telegram prompts
 * nowhere to be found in Claude Code.
 *
 * A record is the session of a *running* process, so a stale file is skipped, and
 * only the editor's own sessions count: a `claude -p` run (this bridge included)
 * also registers itself, with `entrypoint: "sdk-cli"`, and resuming one of those
 * would keep the conversation invisible. The most recently used one wins, because
 * that is the tab the panel shows.
 *
 * @param {{ cwd?: string, home?: string, isAlive?: (pid: number) => boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string} a session id, or '' when the editor has no session here
 */
export function activeClaudeSession(options = {}) {
  const configured = String((options.env ?? process.env).TELEGRAM_NOTIFY_CLAUDE_SESSION || '').trim();
  if (configured) return /^(new|off|none|0)$/i.test(configured) ? '' : configured;

  const directory = canonicalDirectory(options.cwd || process.cwd());
  const dir = claudeSessionsDir(options.home);
  const isAlive = options.isAlive ?? isProcessAlive;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return '';
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    const sessionId = String(record?.sessionId || '');
    if (!sessionId) continue;
    if (record.cwd && canonicalDirectory(record.cwd) !== directory) continue;
    if (String(record.entrypoint || '') === 'sdk-cli') continue;
    if (!isAlive(record.pid)) continue;
    found.push({ sessionId, at: Number(record.updatedAt || record.startedAt || 0), name: String(record.name || '') });
  }

  found.sort((a, b) => b.at - a.at);
  return found[0]?.sessionId ?? '';
}

/**
 * Arguments for the run.
 *
 * `--output-format stream-json` prints one JSON object per line and ends with the
 * usual `result` object, so the final answer and the session id are read from the
 * last line. `--include-partial-messages` keeps the stream useful to a caller that
 * wants to follow the turn; Telegram no longer does, and the bridge only reads the
 * final result.
 *
 * `--resume` continues an existing conversation: the turn is appended to that
 * session's transcript, so it is part of the session the Claude Code panel shows
 * rather than a session of its own.
 *
 * `--permission-mode` copies the mode the Claude Code session itself runs under.
 * Without it a resumed turn starts in `default`, where every Edit or Bash asks for
 * an approval — which is what put permission requests in the chat even though the
 * panel would never have asked.
 *
 * @param {string} prompt
 * @param {{ resume?: string, permissionMode?: string }} [options]
 * @returns {string[]}
 */
export function claudeStreamArguments(prompt, options = {}) {
  const resume = String(options.resume || '').trim();
  const mode = String(options.permissionMode || '').trim();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (resume) args.push('--resume', resume);
  if (mode) args.push('--permission-mode', mode);
  return args;
}

/** Permission modes the CLI accepts. Anything else is not passed on. */
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);

/**
 * Modes a transcript can record. `default` is what a session starts in; it is not a
 * CLI flag — not passing one is the same thing — so it reads as "unknown" here.
 */
const RECORDED_MODES = new Set([...PERMISSION_MODES, 'default']);

/**
 * The folder Claude Code keeps this project's transcripts in: every character
 * that is not a letter or a digit becomes `-`, so `C:\Projects\app` is
 * `C--Projects-app`.
 *
 * @param {string} directory
 * @returns {string}
 */
export function claudeProjectSlug(directory) {
  return canonicalDirectory(directory).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The transcript file of one session, or null when it is not on disk.
 *
 * @param {{ sessionId?: string, cwd?: string, home?: string }} [options]
 * @returns {string|null}
 */
export function claudeTranscriptPath(options = {}) {
  const sessionId = String(options.sessionId || '').trim().replace(/[^A-Za-z0-9-]/g, '');
  if (!sessionId) return null;

  const root = path.join(options.home || claudeConfigDir(), 'projects');
  if (options.cwd) {
    const candidate = path.join(root, claudeProjectSlug(options.cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  // A session opened from another folder (a worktree, or a different tab) is still
  // found by its id alone.
  try {
    for (const project of fs.readdirSync(root)) {
      const candidate = path.join(root, project, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* no projects folder */
  }
  return null;
}

/**
 * @returns {string} the Claude Code config folder
 */
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The permission mode a session's latest turn ran under, read from its transcript.
 *
 * Claude Code records it on every user entry, so the last one is the mode the panel
 * is in right now — `bypassPermissions` when the user turned approvals off,
 * `acceptEdits` after `/permissions`, `plan` while planning.
 *
 * @param {string|null} transcriptPath
 * @param {{ maxBytes?: number }} [options]
 * @returns {string} '' when unknown
 */
export function readPermissionMode(transcriptPath, options = {}) {
  if (!transcriptPath) return '';
  const maxBytes = Number(options.maxBytes) || 1024 * 1024;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    // The window may start mid-line; the pattern still matches a whole field.
    const found = [...buffer.toString('utf8').matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
    const mode = found.length ? found[found.length - 1][1] : '';
    if (!RECORDED_MODES.has(mode)) return '';
    return PERMISSION_MODES.has(mode) ? mode : '';
  } catch {
    return '';
  }
}

/**
 * The permission mode the editor's session is in, so a Telegram turn behaves like
 * a turn typed in the panel.
 *
 * @param {{ sessionId?: string, cwd?: string, home?: string }} [options]
 * @returns {string}
 */
export function sessionPermissionMode(options = {}) {
  return readPermissionMode(claudeTranscriptPath(options));
}

/**
 * Reads one stream-json line into text.
 *
 * @param {any} entry
 * @returns {string}
 */
function streamedTextOf(entry) {
  const content = entry?.message?.content ?? entry?.content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return typeof content === 'string' ? content : '';
}

/**
 * Turns the CLI's stream-json output into text as it arrives.
 *
 * `push()` is fed raw stdout chunks and never throws: a line that is not JSON (a
 * warning, a log line) is skipped, because a progress callback must not end a turn.
 * `end()` settles on the `result` object when the CLI printed one — that text is
 * the answer, the streamed text is what the reader saw while it was written.
 *
 * @param {{ onDelta?: (text: string) => void, onTool?: (name: string) => void, onSession?: (id: string) => void }} [handlers]
 */
export function createClaudeStreamReader(handlers = {}) {
  let buffer = '';
  let text = '';
  let sessionId = '';
  let sawDelta = false;
  let lastAssistantId = '';
  let result = null;

  const notify = (name, value) => {
    try {
      handlers[name]?.(value);
    } catch {
      /* a callback must not break the run */
    }
  };

  const append = (piece) => {
    if (!piece) return;
    text += piece;
    notify('onDelta', piece);
  };

  const handle = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (!sessionId && typeof entry.session_id === 'string' && entry.session_id) {
      sessionId = entry.session_id;
      notify('onSession', sessionId);
    }

    if (entry.type === 'result') {
      result = {
        text: typeof entry.result === 'string' ? entry.result : '',
        isError: entry.is_error === true || entry.subtype === 'error',
      };
      return;
    }

    if (entry.type === 'stream_event') {
      const event = entry.event;
      if (!event || typeof event !== 'object') return;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        sawDelta = true;
        append(event.delta.text);
        return;
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        notify('onTool', String(event.content_block.name || 'a tool'));
      }
      return;
    }

    if (entry.type === 'assistant' && !sawDelta) {
      // A CLI without partial events only reports the finished message; the text
      // is still followed, just in bigger steps.
      const id = String(entry.message?.id || entry.uuid || '');
      if (id && id === lastAssistantId) return;
      lastAssistantId = id;
      append(streamedTextOf(entry));
    }
  };

  const drain = (flush) => {
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('{')) {
        try {
          handle(JSON.parse(line));
        } catch {
          /* not a JSON line */
        }
      }
      index = buffer.indexOf('\n');
    }
    if (flush) {
      const tail = buffer.trim();
      buffer = '';
      if (tail.startsWith('{')) {
        try {
          handle(JSON.parse(tail));
        } catch {
          /* not a JSON line */
        }
      }
    }
  };

  return {
    /** @param {string|Buffer} chunk */
    push(chunk) {
      buffer += String(chunk);
      drain(false);
    },
    /** Processes the last line and settles the result. */
    end() {
      drain(true);
      return {
        text: String(result?.text || text).trim(),
        streamed: text.trim(),
        sessionId,
        sawResult: result !== null,
        isError: result?.isError === true,
      };
    },
  };
}

/**
 * Reads the answer out of the CLI output. The result object is the last JSON
 * line; earlier lines are warnings.
 *
 * @param {string} stdout
 * @returns {{ text: string, sessionId: string, isError: boolean }}
 */
export function parseClaudeOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (typeof parsed?.result === 'string') {
        return {
          text: parsed.result,
          sessionId: String(parsed.session_id || ''),
          isError: parsed.is_error === true || parsed.subtype === 'error',
        };
      }
    } catch {
      /* try an earlier line */
    }
  }
  return { text: trimmed.replace(ANSI, ''), sessionId: '', isError: false };
}

/**
 * Runs an agent CLI, collecting its output, and resolves with whatever the
 * caller's parser makes of it. Shared by the Claude and OpenCode runners so both
 * behave the same on cancel, timeout and failure.
 *
 * @param {object} options
 * @param {string} options.executable
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {string} [options.label] used in the failure message
 * @param {string} [options.stdinText] written to the child's stdin and then closed
 * @param {number} [options.timeoutMs] 0 (the default) waits until the run ends
 * @param {AbortSignal} [options.signal]
 * @param {(cmd: string, args: string[], options: any) => any} options.spawnImpl
 * @param {(stdout: string) => { text: string, sessionId: string, isError?: boolean, error?: string }} options.parse
 * @param {(chunk: string) => void} [options.onStdout] sees the output while it is written
 * @param {NodeJS.ProcessEnv} [options.env] extra variables for the child
 * @returns {Promise<{ ok: boolean, text: string, sessionId: string, error?: string, silent?: boolean, timedOut?: boolean, cancelled?: boolean }>}
 */
async function runAgentCli({
  executable,
  args,
  cwd,
  label,
  stdinText,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  spawnImpl,
  parse,
  onStdout,
  env,
}) {
  const workingDirectory = cwd && fs.existsSync(cwd) ? cwd : process.cwd();

  return await new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, text: '', sessionId: '', cancelled: true, error: 'cancelled' });
      return;
    }

    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd: workingDirectory,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, text: '', sessionId: '', error: err.message });
      return;
    }

    if (stdinText !== undefined) {
      // A closed stdin is the child deciding not to read the prompt; its output,
      // not an EPIPE, is what the caller reports.
      child.stdin?.on?.('error', () => {});
      child.stdin?.end?.(stdinText);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => {
      cancelled = true;
      child.kill();
    };

    const limit = Number(timeoutMs) > 0 ? Math.max(1000, Number(timeoutMs)) : 0;
    const timer = limit
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, limit)
      : null;
    timer?.unref?.();

    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (!onStdout) return;
      try {
        onStdout(String(chunk));
      } catch (err) {
        // Following the output is a courtesy: a progress consumer that throws must
        // not cost the caller its answer.
        log.debug(`streamed output was dropped: ${err.message}`);
      }
    });
    child.stderr?.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => done({ ok: false, text: '', sessionId: '', error: err.message }));

    child.on('close', (code) => {
      const parsed = parse(stdout);
      if (cancelled) {
        done({ ok: false, text: parsed.text, sessionId: parsed.sessionId, cancelled: true, error: 'cancelled' });
        return;
      }
      if (timedOut) {
        done({ ok: false, text: parsed.text, sessionId: parsed.sessionId, timedOut: true, error: 'the run timed out' });
        return;
      }
      if (parsed.isError === true || (code !== 0 && !parsed.text)) {
        // The parser explains the failure when the CLI did (`opencode run` sends
        // an error event); otherwise the CLI said nothing and stderr is next.
        const reported = typeof parsed.error === 'string' ? parsed.error.trim() : '';
        const reason =
          reported || parsed.text || stderr.replace(ANSI, '').trim() || `${label} exited with code ${code}`;
        log.warn(`${label} failed: ${reason.slice(0, 400)}`);
        done({
          ok: false,
          text: parsed.text,
          sessionId: parsed.sessionId,
          error: reason,
          // Nothing at all was printed: a start-up crash rather than a refusal.
          silent: !reported && !parsed.text && !stderr.replace(ANSI, '').trim(),
        });
        return;
      }
      if (!parsed.text) {
        done({ ok: false, text: '', sessionId: parsed.sessionId, error: `${label} returned no answer` });
        return;
      }
      done({ ok: true, text: parsed.text, sessionId: parsed.sessionId });
    });
  });
}

/**
 * Runs one prompt through Claude Code and resolves with its answer.
 *
 * The run resumes the session the editor has open in this folder, so the prompt and
 * its answer become part of that conversation — the one the Claude Code panel
 * shows — instead of a session of their own that is nowhere to be found. With no
 * editor session (Claude Code closed, or a folder it never opened) the run starts a
 * new one, exactly as before.
 *
 * The hooks stay enabled: a permission request still reaches Telegram, and the
 * completion the `Stop` hook posts is treated as the answer, so it is not posted
 * twice. When no hook is installed the stdout result is the answer instead.
 *
 * Nothing is streamed to the chat: the answer is returned once, when the turn
 * ends, and it runs in the permission mode the session itself is in, so it does
 * not stop to ask for things the panel would have allowed.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.cwd]
 * @param {string} [options.binary]
 * @param {string} [options.session] session to resume; the editor's is discovered when omitted
 * @param {string} [options.permissionMode] '' or a CLI mode; the session's own is used when omitted
 * @param {number} [options.timeoutMs] 0 (the default) waits until the run ends
 * @param {AbortSignal} [options.signal]
 * @param {(cmd: string, args: string[], options: any) => any} [options.spawnImpl] injectable for tests
 * @param {(options: { cwd?: string }) => string} [options.resolveSession] injectable for tests
 * @param {(sessionId: string) => void} [options.onSession] told which session the turn joins
 * @param {(sessionId: string) => void} [options.onJoined] told once, when the run resumes an existing session
 * @param {(text: string) => void} [options.onDelta] called with each piece of the answer as it arrives
 * @param {(tool: string) => void} [options.onTool] called when the turn starts using a tool
 * @param {string} [options.claudeHome] Claude Code's config folder, where the transcripts are read from
 * @returns {Promise<{ ok: boolean, text: string, sessionId: string, resumed?: string, permissionMode?: string, error?: string, timedOut?: boolean, cancelled?: boolean }>}
 */
export async function runClaudePrompt({
  prompt,
  cwd,
  binary,
  session,
  permissionMode,
  timeoutMs,
  signal,
  spawnImpl = spawn,
  resolveSession = activeClaudeSession,
  onSession,
  onJoined,
  onDelta,
  onTool,
  claudeHome,
}) {
  const text = String(prompt ?? '').trim();
  if (!text) return { ok: false, text: '', sessionId: '', error: 'the prompt is empty' };

  const executable = resolveClaudeBinary(binary);
  if (!executable) {
    return {
      ok: false,
      text: '',
      sessionId: '',
      error:
        'the Claude Code CLI was not found; install the Claude Code extension, or set TELEGRAM_NOTIFY_CLAUDE_BIN',
    };
  }

  const directory = String(cwd || '').trim() || undefined;
  let resume = String(session || '').trim();
  if (!resume && resolveSession) {
    try {
      resume = String(resolveSession({ cwd: directory }) || '').trim();
    } catch {
      // Unreadable session records: a new session still answers the prompt.
      resume = '';
    }
  }

  // The same session may be learned twice (from the records and from the CLI's
  // own report); announce it once so a caller can open it without flicker.
  const announced = new Set();
  const announce = (id) => {
    const value = String(id || '').trim();
    if (!value || announced.has(value)) return;
    announced.add(value);
    onSession?.(value);
  };

  if (resume) {
    log.info(`Claude Code prompt joins session ${resume}`);
    announce(resume);
    // The caller may want to show this conversation; a session the run creates has
    // nothing to show yet, so only a join is reported here.
    try {
      onJoined?.(resume);
    } catch {
      /* opening a panel must not fail the turn */
    }
  }

  // A turn that resumes a session keeps the mode that session is in: asking again
  // in Telegram for something the panel already allowed is noise, and the answer is
  // expected to be the same as a typed turn.
  let mode = permissionMode === undefined ? '' : String(permissionMode || '').trim();
  if (permissionMode === undefined && resume) {
    try {
      mode = sessionPermissionMode({ sessionId: resume, cwd: directory, home: claudeHome });
    } catch {
      mode = '';
    }
    if (mode) log.info(`Claude Code turn runs in permission mode ${mode}`);
  }

  const run = async (target) => {
    const reader = createClaudeStreamReader({ onDelta, onTool, onSession: announce });
    const result = await runAgentCli({
      executable,
      args: claudeStreamArguments(text, { resume: target.resume, permissionMode: target.permissionMode }),
      cwd: directory,
      label: 'Claude Code',
      timeoutMs,
      signal,
      spawnImpl,
      // Marks the turn as a headless run, so the installed hooks know there is no
      // editor in front of the user to answer a permission or a question: they
      // forward it to Telegram instead of letting Claude wait on a panel that is
      // not there.
      env: { [CLAUDE_HEADLESS_RUN_ENV]: '1' },
      onStdout: (chunk) => reader.push(chunk),
      parse: parseClaudeOutput,
    });
    const streamed = reader.end();
    if (streamed.sessionId) announce(streamed.sessionId);
    // The `result` line is the answer. Without one — a crash, or a CLI that does not
    // stream — what was followed is the answer instead of the raw output.
    const answer = streamed.sawResult ? result.text || streamed.text : streamed.text || result.text;
    return {
      ...result,
      text: answer,
      sessionId: String(result.sessionId || streamed.sessionId || ''),
    };
  };

  const result = await run({ resume, permissionMode: mode });

  // A session the CLI cannot resume — closed, or already taken by another process —
  // must not swallow the prompt: run it once without `--resume`, which always
  // answers (a new session, reported as such).
  if (!result.ok && resume && /resume|session|in use|not found|already/i.test(result.error || '')) {
    log.warn(`could not resume ${resume} (${result.error}); running the prompt in a new session`);
    const fresh = await run({ resume: '', permissionMode: '' });
    return { ...fresh, resumed: '', permissionMode: '' };
  }

  // The CLI reports the session it used: a resume keeps the id, a new run gets a
  // fresh one. Either way the caller can say where the turn went.
  const used = String(result.sessionId || resume || '');
  if (used && used !== resume) announce(used);
  return {
    ...result,
    sessionId: used || result.sessionId,
    resumed: resume && used === resume ? resume : '',
    permissionMode: mode,
  };
}

/**
 * The folder a run starts in, with its drive letter in canonical case.
 *
 * VS Code reports a lowercase drive letter (`d:\…`). OpenCode walks up from the
 * run's folder to collect the `AGENTS.md` files and compares every step against
 * the canonical path; with `d:` instead of `D:` that walk never reaches the root,
 * so it recurses until the stack is gone and the run dies before its first token
 * with "Instruction initialization blocked by unavailable sources".
 *
 * @param {string} [directory]
 * @returns {string} the run's folder, never empty
 */
function openCodeWorkingDirectory(directory) {
  return canonicalDirectory(String(directory || process.cwd() || ''));
}

/**
 * How often a server-side run asks whether its turn has finished. The answer is
 * read from the session rather than assembled from the event stream, so a missed
 * event cannot leave the run waiting or produce half an answer.
 */
const OPENCODE_POLL_MS = 600;
/** A request must still be pending this long after it is first seen to be asked. */
const ASK_CONFIRM_MS = 400;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one prompt on the OpenCode server and resolves with the answer its turn
 * produced.
 *
 * The prompt goes through `POST /api/session/<id>/prompt`, so the turn executes
 * inside the server the OpenCode sidebar and the desktop app are attached to.
 * Their event stream then carries it into their transcript while it is written —
 * the same as a prompt typed in the editor. `opencode run` cannot do that: a
 * `--standalone` run starts a private server, whose events nobody else sees, which
 * left the sidebar showing the turn only after a reload.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {import('./opencode-log.mjs').OpenCodeEndpoint} options.endpoint
 * @param {string} options.directory
 * @param {string} options.model
 * @param {string} [options.sessionId] session to continue; a new one is created when absent
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.pollMs]
 * @param {(sessionId: string) => void} [options.onSession]
 * @param {(ask: { id: string, kind: string, title: string, lines: string[], fields: { key: string, title: string, options: string[] }[] }) => void|Promise<void>} [options.onWaiting]
 *   called once per question or permission request the turn is blocked on; a
 *   returned promise is awaited, so the ask can be answered from the chat
 * @returns {Promise<{ ok: boolean, text: string, sessionId: string, error?: string, timedOut?: boolean, cancelled?: boolean, turnSeen?: boolean }>}
 */
async function runPromptOnServer({
  prompt,
  endpoint,
  directory,
  model,
  sessionId,
  timeoutMs,
  signal,
  pollMs = OPENCODE_POLL_MS,
  onSession,
  onWaiting,
}) {
  // Continue the session the editor shows; a folder with no session gets one, with
  // the model pinned so the turn cannot silently run on the server's default.
  let id = String(sessionId || '').trim();
  const existing = id ? await fetchSession(endpoint, id, { directory }) : null;
  if (existing) {
    id = String(existing.id);
    if (!existing.model?.id) await setSessionModel(endpoint, id, model, { directory });
  } else {
    id = await createSession(endpoint, { directory, model });
  }
  // Known before the turn starts, so the session watcher can be told that the
  // answer arrives here and not to post the same turn again.
  onSession?.(id);

  const admitted = await sendPrompt(endpoint, id, { text: prompt, directory });
  const admittedId = String(admitted?.id ?? '');

  let stopped = false;
  const onAbort = () => {
    stopped = true;
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  const deadline = Number(timeoutMs) > 0 ? Date.now() + Math.max(1000, Number(timeoutMs)) : 0;
  const waitFor = (result) => ({ ...result, sessionId: id, turnSeen: true });
  /** Questions and permission requests already reported, so each is mentioned once. */
  const announced = new Set();
  let checkedAt = 0;

  try {
    for (;;) {
      if (stopped || signal?.aborted) {
        // Stop the turn before answering: a cancelled prompt must not keep running
        // in the editor after Telegram says it was stopped.
        await interruptSession(endpoint, id, { directory });
        return { ok: false, text: '', sessionId: id, cancelled: true, error: 'cancelled', turnSeen: false };
      }
      await sleep(pollMs);
      if (stopped || signal?.aborted) continue;

      const messages = await sessionMessages(endpoint, id, { directory, limit: 40 });
      const turn = turnOfPrompt(messages, admittedId);
      if (turn) {
        if (turn.outcome === 'failed') {
          const reason = turn.error || 'the turn failed';
          log.warn(`OpenCode turn failed: ${reason.slice(0, 400)}`);
          return waitFor({ ok: false, text: turn.text, error: reason });
        }
        if (!turn.text && turn.error) {
          return waitFor({ ok: false, text: '', error: turn.error });
        }
        return waitFor({ ok: true, text: turn.text });
      }

      // A turn that stops to ask something waits for a click in the editor. With an
      // ask window the chat gets the same question first; whatever answers, the
      // other place withdraws — the message stops offering buttons when the window
      // closes, and OpenCode's own form keeps showing in the panel either way.
      if (onWaiting && Date.now() - checkedAt > 1500) {
        checkedAt = Date.now();
        const fresh = (await waitingOn(endpoint, id, { directory })).filter((ask) => !announced.has(ask.id));
        // A request that a mode like autopilot approves never really waits: it is
        // gone within a moment. Only a request that is still there after a beat is a
        // question for the user, so an auto-approved turn never reaches the chat.
        if (fresh.length) await sleep(ASK_CONFIRM_MS);
        const stillPending = fresh.length
          ? new Set((await waitingOn(endpoint, id, { directory })).map((ask) => ask.id))
          : new Set();
        for (const ask of fresh) {
          if (fresh.length && !stillPending.has(ask.id)) continue;
          announced.add(ask.id);
          // The ask carries the way to answer it, so the caller does not need to
          // know how OpenCode's API is shaped.
          const answerable = {
            ...ask,
            sessionId: id,
            reply: (answer, optionIndex) => answerAsk(endpoint, directory, id, ask, answer, optionIndex),
          };
          try {
            // A promise is honoured, so the caller can answer the ask instead of
            // only reporting it. Answering is best effort: the panel may have won.
            await onWaiting(answerable);
          } catch (err) {
            log.warn(`could not answer what the OpenCode turn is waiting on: ${err.message}`);
          }
        }
      }

      if (deadline && Date.now() > deadline) {
        await interruptSession(endpoint, id, { directory });
        return { ok: false, text: '', sessionId: id, timedOut: true, error: 'the run timed out', turnSeen: false };
      }
    }
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Answers one ask the OpenCode turn is blocked on.
 *
 * A permission maps to the three decisions the server accepts; a form fills one
 * value per field, in the order the form asks for them. A value that is not one of
 * the offered options is taken as it was typed, which is how a "custom" answer
 * works — and a rejection carries it as the reason.
 *
 * @param {any} endpoint
 * @param {string} directory
 * @param {string} sessionId
 * @param {{ id: string, kind: string, fields: { key: string, title: string, options: string[] }[] }} ask
 * @param {string} answer
 * @param {number|null} [optionIndex]
 * @returns {Promise<boolean>} whether the server took the answer
 */
async function answerAsk(endpoint, directory, sessionId, ask, answer, optionIndex) {
  const text = String(answer ?? '').trim();
  if (!text && optionIndex === null) return false;

  if (ask.kind === 'permission') {
    const choice = permissionChoice(text, optionIndex);
    return replyToPermission(endpoint, sessionId, ask.id, choice, {
      directory,
      message: choice === 'reject' && !isNegative(text) ? text : undefined,
    });
  }

  const fields = Array.isArray(ask.fields) ? ask.fields : [];
  if (!fields.length) return false;
  // One field takes the answer whole; several are answered as "a | b", the same
  // separator the Claude question hook uses.
  const parts = fields.length === 1 ? [text] : text.split('|').map((part) => part.trim());
  /** @type {Record<string, string|string[]>} */
  const filled = {};
  fields.forEach((field, index) => {
    const value = parts[index] ?? (parts.length === 1 ? text : '');
    if (!value) return;
    const multi = /multiselect/i.test(String(field.type || ''));
    filled[field.key] = multi ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
  });
  if (!Object.keys(filled).length) return false;
  return replyToForm(endpoint, sessionId, ask.id, filled, { directory });
}

/** @param {string} text @param {number|null|undefined} optionIndex */
function permissionChoice(text, optionIndex) {
  if (optionIndex === 0) return 'once';
  if (optionIndex === 1) return 'always';
  if (optionIndex === 2) return 'reject';
  if (isAffirmative(text)) return 'once';
  if (/^always$/i.test(text)) return 'always';
  return 'reject';
}

/** @param {string} text */
function isAffirmative(text) {
  return /^(y|yes|yeah|yep|ok|okay|allow|approve|approved|accept|1)$/i.test(String(text).trim());
}

/** @param {string} text */
function isNegative(text) {
  return /^(n|no|nope|deny|denied|reject|cancel|stop|0)$/i.test(String(text).trim());
}

/**
 * Runs one prompt through OpenCode and resolves with its answer.
 *
 * A running OpenCode server is preferred: the prompt is submitted to it, so the
 * turn shows up in the OpenCode sidebar and the desktop app as it happens. When no
 * server answers — OpenCode closed, or the bridge started alone — the prompt falls
 * back to `opencode run --standalone --format json`, which needs nothing else
 * running but whose events no editor sees.
 *
 * Either way the prompt continues the newest session in the folder (the one the
 * editor shows) instead of starting a fresh one per message, and is written to the
 * run's stdin rather than passed as an argument, which on Windows would keep the
 * quotes Node adds around a prompt with a space in it.
 *
 * `--standalone` gives every CLI run its own private server, and that boot can lose
 * a race — the managed service port is already taken, for example — after which the
 * CLI exits non-zero without printing a single line. The same run then succeeds, so
 * a silent failure is repeated once instead of being reported.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.cwd]
 * @param {string} [options.binary]
 * @param {string} [options.model]
 * @param {string} [options.session] session to continue; discovered when omitted
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {(cmd: string, args: string[], options: any) => any} [options.spawnImpl] injectable for tests
 * @param {(options: { directory?: string, endpoint?: any }) => Promise<string>} [options.resolveSession] injectable for tests
 * @param {(sessionId: string) => void} [options.onSession] called once the session is known, before it runs
 * @param {any} [options.endpoint] OpenCode server to use; discovered when omitted
 * @param {number} [options.pollMs] how often a server-side run checks for its turn
 * @param {(ask: { id: string, kind: string, title: string, lines: string[], fields: { key: string, title: string, options: string[] }[] }) => void|Promise<void>} [options.onWaiting]
 *   called once per question or permission request the turn is blocked on; a
 *   returned promise is awaited, so the ask can be answered from the chat
 * @returns {Promise<{ ok: boolean, text: string, sessionId: string, error?: string, timedOut?: boolean, cancelled?: boolean, turnSeen?: boolean }>}
 */
export async function runOpenCodePrompt({
  prompt,
  cwd,
  binary,
  model = DEFAULT_OPENCODE_MODEL,
  session,
  timeoutMs,
  signal,
  spawnImpl = spawn,
  resolveSession = continuationSessionId,
  onSession,
  endpoint,
  pollMs,
  onWaiting,
}) {
  const text = String(prompt ?? '').trim();
  if (!text) return { ok: false, text: '', sessionId: '', error: 'the prompt is empty' };

  const directory = openCodeWorkingDirectory(cwd);
  let continueId = String(session || '').trim();

  // Prefer the server every editor is attached to: only a turn it runs reaches
  // the OpenCode sidebar, so only then does the answer appear there live.
  const target = endpoint === undefined ? discoverEndpoint() : endpoint;
  const server = target && (await isServerReachable(target)) ? target : null;

  if (!continueId && resolveSession) {
    try {
      continueId = String((await resolveSession({ directory, endpoint: server })) || '').trim();
    } catch {
      // No server to ask: the run creates the session itself.
      continueId = '';
    }
  }

  if (server) {
    try {
      return await runPromptOnServer({
        prompt: text,
        endpoint: server,
        directory,
        model,
        sessionId: continueId,
        timeoutMs,
        signal,
        pollMs,
        onSession,
        onWaiting,
      });
    } catch (err) {
      // Nothing was admitted, so the prompt has not run: the CLI is still a way to
      // answer it. A failed turn is reported by the server path, not retried here.
      log.warn(`OpenCode server prompt failed: ${err.message}; falling back to the CLI`);
    }
  }

  const executable = resolveOpenCodeBinary(binary);
  if (!executable) {
    return {
      ok: false,
      text: '',
      sessionId: continueId,
      error: 'the OpenCode CLI was not found; install the desktop app, or set TELEGRAM_NOTIFY_OPENCODE_BIN',
    };
  }

  // Known before the turn starts, so the session watcher can be told that the
  // answer arrives here and not to post the same turn again.
  if (continueId) onSession?.(continueId);

  const attempt = () =>
    runAgentCli({
      executable,
      args: runArguments({ model, session: continueId }),
      cwd: directory,
      label: 'OpenCode',
      stdinText: text,
      timeoutMs,
      signal,
      spawnImpl,
      parse: parseRunOutput,
    });

  const result = await attempt();
  if (result.sessionId && result.sessionId !== continueId) onSession?.(result.sessionId);

  const retryable = !result.ok && result.silent && !result.cancelled && !result.timedOut && !signal?.aborted;
  if (!retryable) return result;

  log.info('OpenCode exited without output; retrying the prompt once');
  const retried = await attempt();
  if (retried.sessionId && retried.sessionId !== continueId) onSession?.(retried.sessionId);
  return retried;
}