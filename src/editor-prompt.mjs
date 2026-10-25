/**
 * Hands a prompt to the editor so the agent runs inside VS Code.
 *
 * Submitting through the editor beats spawning a CLI: the session shows up in the
 * Chat list, the user can watch it, approve things and continue it, and any hooks
 * the editor already runs still fire.
 *
 * Copilot's entry point is `workbench.action.chat.open` with
 * `isPartialQuery: false`, which submits rather than filling the box. Claude uses
 * the same command: its Chat agent is a native agent host with no agent-specific
 * prompt command, but Chat submits into the session in front of the user, which is
 * the Claude session while Claude is the agent in use. OpenCode opens its sidebar.
 *
 * `openAgentSession` is the other half: a Claude Code session cannot be given a
 * prompt from outside, but it can be opened, which is how a turn that joined that
 * session is brought in front of the user.
 *
 * Everything here is best effort: the caller always gets a result describing what
 * happened, because a prompt must never fail silently.
 */

/**
 * @typedef {object} EditorSubmitResult
 * @property {boolean} ok
 * @property {'submitted'|'opened'|'unsupported'} outcome
 * @property {'copilot'|'claude'|'opencode'} agent
 * @property {string} [detail]
 * @property {string} [error]
 * @property {boolean} [needsAnswerFromEditor] the answer appears in the editor, not in Telegram
 */

/**
 * @param {object} options
 * @param {(command: string, ...args: any[]) => Thenable<any>} options.executeCommand
 * @param {'copilot'|'claude'|'opencode'} options.agent
 * @param {string} options.prompt
 * @returns {Promise<EditorSubmitResult>}
 */
export async function submitToEditor({ executeCommand, agent, prompt }) {
  const text = String(prompt ?? '').trim();
  if (!text) return { ok: false, outcome: 'unsupported', agent, error: 'the prompt is empty' };

  if (agent === 'copilot') {
    // Open the Chat view with the prompt already submitted. This is the same call
    // VS Code's own "Generate Agent Instructions" makes, so it creates a real
    // agent session that is listed and manageable like any other.
    const options = { mode: 'agent', query: text, isPartialQuery: false };
    try {
      await executeCommand('workbench.action.chat.open', options);
      return { ok: true, outcome: 'submitted', agent, needsAnswerFromEditor: true };
    } catch (err) {
      // Older builds may not accept `mode`; the query alone still submits.
      try {
        await executeCommand('workbench.action.chat.open', { query: text, isPartialQuery: false });
        return { ok: true, outcome: 'submitted', agent, needsAnswerFromEditor: true };
      } catch {
        return {
          ok: false,
          outcome: 'unsupported',
          agent,
          error: `VS Code could not submit to Chat: ${err?.message || err}`,
        };
      }
    }
  }

  if (agent === 'claude') {
    // The "Claude" entry in the agent picker is a native agent host, and VS Code
    // exposes no command that names it. Chat's own open is enough: with
    // `isPartialQuery: false` it sets the text in the session in front of the
    // user and submits it, so a prompt sent while the Claude session is the one
    // on screen continues that conversation — the same way a Copilot prompt does.
    // No `mode` is passed: switching the widget to "agent" would move the prompt
    // into Copilot and out of the Claude session.
    try {
      await executeCommand('workbench.action.chat.open', { query: text, isPartialQuery: false });
      return { ok: true, outcome: 'submitted', agent, needsAnswerFromEditor: true };
    } catch (err) {
      return {
        ok: false,
        outcome: 'unsupported',
        agent,
        error: `VS Code could not submit to the Claude chat: ${err?.message || err}`,
      };
    }
  }

  if (agent === 'opencode') {
    // The sidebar owns the session; there is no public prompt command yet.
    try {
      await executeCommand('opencode.addToChat');
      return {
        ok: true,
        outcome: 'opened',
        agent,
        needsAnswerFromEditor: true,
        detail: 'the OpenCode sidebar was opened; the prompt is in Telegram for you to paste',
      };
    } catch (err) {
      return { ok: false, outcome: 'unsupported', agent, error: `OpenCode does not accept prompts from the editor yet` };
    }
  }

  return { ok: false, outcome: 'unsupported', agent, error: `unknown agent "${agent}"` };
}

/**
 * Brings an agent's own session to the front, so a turn started elsewhere is
 * visibly part of the conversation the user has open.
 *
 * Claude Code has no command that submits a prompt, but it does open a session:
 * `claude-vscode.editor.open <sessionId>` reveals the existing tab (or the sidebar
 * chat, when that is where Claude Code lives) and loads it from its transcript,
 * which is where a Telegram turn is written.
 *
 * Everything is best effort — the caller must never fail a prompt because a panel
 * could not be shown.
 *
 * @param {object} options
 * @param {(command: string, ...args: any[]) => Thenable<any>} options.executeCommand
 * @param {(url: string) => Thenable<any>} [options.openExternal]
 * @param {'copilot'|'claude'|'opencode'} options.agent
 * @param {string} options.sessionId
 * @returns {Promise<{ ok: boolean, outcome: 'opened'|'unsupported', agent: string, via?: string, error?: string }>}
 */
export async function openAgentSession({ executeCommand, agent, sessionId, openExternal }) {
  const id = String(sessionId || '').trim();
  if (agent !== 'claude' || !id) {
    return { ok: false, outcome: 'unsupported', agent, error: 'only a Claude Code session can be opened' };
  }

  // The command exists from 2.0 onwards; `primaryEditor.open` is the older spelling
  // and takes the same pair of arguments.
  for (const command of ['claude-vscode.editor.open', 'claude-vscode.primaryEditor.open']) {
    try {
      await executeCommand(command, id);
      return { ok: true, outcome: 'opened', agent, via: command };
    } catch {
      /* the next spelling, or the URI handler */
    }
  }

  if (openExternal) {
    try {
      await openExternal(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}`);
      return { ok: true, outcome: 'opened', agent, via: 'uri' };
    } catch (err) {
      return { ok: false, outcome: 'unsupported', agent, error: err?.message || String(err) };
    }
  }

  return { ok: false, outcome: 'unsupported', agent, error: 'Claude Code did not accept the session' };
}
