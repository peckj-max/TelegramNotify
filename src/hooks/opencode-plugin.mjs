/**
 * OpenCode plugin adapter.
 *
 * Register in the project's opencode.json (or ~/.config/opencode/opencode.json):
 *
 *   { "plugin": ["file:///D:/Working/Apps/Extensions/TelegramNotify/src/hooks/opencode-plugin.mjs"] }
 *   { "plugin": ["./.opencode/telegram-notify.mjs"] }   // installed copy
 *
 * The plugin forwards permission prompts and turn endings to the TelegramNotify
 * bridge and answers the permission with whatever the Telegram user chose.
 */
import { loadConfigForHooks, localApiUrl } from '../config.mjs';
import { log } from '../logger.mjs';

const PERMISSION_OPTIONS = ['Allow once', 'Always allow', 'Deny'];
const COMPLETION_DEDUPE_MS = 15000;

export const TelegramNotify = async (ctx = {}) => {
  const config = loadConfigForHooks();
  const base = localApiUrl(config);
  const directory = ctx.directory || ctx.worktree || process.cwd();
  const timeouts = new Map();
  const answered = new Map();

  function noteCompletion(sessionID) {
    const now = Date.now();
    const previous = timeouts.get(sessionID) || 0;
    if (now - previous < COMPLETION_DEDUPE_MS) return false;
    timeouts.set(sessionID, now);
    return true;
  }

  async function callBridge(payload) {
    try {
      const response = await fetch(`${base}/event/opencode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout((config.replyTimeoutSeconds + 30) * 1000),
      });
      if (!response.ok) {
        log.warn(`bridge rejected opencode event (${response.status})`);
        return null;
      }
      return await response.json();
    } catch (err) {
      log.warn(`telegram-notify bridge unreachable at ${base}: ${err.message}`);
      return null;
    }
  }

  async function cancelBridgeRequest(requestId) {
    try {
      await fetch(`${base}/pending/${requestId}/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* the request may have expired already */
    }
  }

  async function replyPermission(properties, choice) {
    const sessionID = properties.sessionID || properties.sessionId;
    const permissionID = properties.id || properties.requestID || properties.permissionID;
    const client = ctx.client;
    if (!sessionID || !permissionID) return false;

    const reply = choice === 'always' ? 'always' : choice === 'allow' ? 'once' : 'reject';

    try {
      const viaClient =
        client?.postSessionIdPermissionsPermissionId ??
        client?.permission?.reply ??
        client?.postSessionPermissionsPermissionId;
      if (typeof viaClient === 'function') {
        await viaClient({
          path: { id: sessionID, permissionID },
          body: { reply },
        });
        return true;
      }
    } catch (err) {
      log.warn(`permission reply via client failed: ${err.message}`);
    }

    const serverUrl = ctx.serverUrl || ctx.server?.url;
    if (serverUrl) {
      try {
        const url = new URL(`/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permissionID)}/reply`, serverUrl);
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reply }),
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) return true;
        log.warn(`permission reply via HTTP failed (${response.status})`);
      } catch (err) {
        log.warn(`permission reply via HTTP failed: ${err.message}`);
      }
    }
    return false;
  }

  async function onPermissionAsked(properties) {
    const requestId = properties.id || properties.requestID || properties.permissionID;
    if (requestId && answered.has(requestId)) return;

    const result = await callBridge({
      type: 'permission',
      title: `OpenCode needs permission: ${properties.action || properties.title || 'action'}`,
      message: properties.action || properties.title || 'OpenCode is waiting for permission.',
      detail: Array.isArray(properties.resources)
        ? properties.resources.join('\n')
        : typeof properties.resources === 'string'
          ? properties.resources
          : '',
      cwd: directory,
      options: PERMISSION_OPTIONS,
      waitForReply: true,
    });

    if (!result || result.ok === false || !result.text) return;

    const choice =
      result.optionIndex === 0
        ? 'allow'
        : result.optionIndex === 2
          ? 'deny'
          : result.optionIndex === 1
            ? 'always'
            : /^(y|yes|ok|allow|approve|1)$/i.test(result.text)
              ? 'allow'
              : /^(n|no|deny|reject|cancel|0)$/i.test(result.text)
                ? 'deny'
                : 'deny';

    if (requestId) answered.set(requestId, Date.now());
    const sent = await replyPermission(properties, choice);
    if (!sent) log.warn('could not send the Telegram answer back to OpenCode; answer in the UI instead');
  }

  return {
    event: async ({ event } = {}) => {
      const type = event?.type;
      const properties = event?.properties || {};
      try {
        switch (type) {
          case 'permission.asked':
            await onPermissionAsked(properties);
            break;
          case 'permission.replied':
            break;
          case 'session.idle':
          case 'session.execution.succeeded': {
            const sessionID = properties.sessionID || properties.sessionId || 'unknown';
            if (!noteCompletion(sessionID)) break;
            await callBridge({
              type: 'completed',
              title: 'OpenCode finished',
              message: `Session ${sessionID} is idle.`,
              cwd: directory,
            });
            break;
          }
          case 'session.execution.failed':
            await callBridge({
              type: 'error',
              title: 'OpenCode error',
              message: String(properties.error?.message || properties.error || 'The session failed.'),
              cwd: directory,
            });
            break;
          case 'session.execution.interrupted':
            await callBridge({
              type: 'info',
              title: 'OpenCode interrupted',
              cwd: directory,
            });
            break;
          default:
            break;
        }
      } catch (err) {
        log.error(`opencode plugin event ${type} failed: ${err.message}`);
      }
    },
  };
};

export default TelegramNotify;
