#!/usr/bin/env node
/**
 * Local agent adapter.
 *
 * A local harness runs on this machine and reports the same events Copilot does —
 * `userPromptSubmitted`, `agentStop`, `sessionEnd`, `errorOccurred` — so it reuses the
 * Copilot adapter with the agent name `local`. Its turns then reach Telegram as
 * `local` instead of appearing to be Copilot's.
 *
 * Point the harness's hook config at this file, passing the event name as the first
 * argument:
 *
 *   node src/hooks/local-hook.mjs userPromptSubmitted
 *   node src/hooks/local-hook.mjs agentStop
 *
 * A harness that posts to the bridge itself can use `POST /event/local` with the same
 * payload the Copilot hook sends; nothing else is needed.
 */
process.env.TELEGRAM_NOTIFY_HOOK_AGENT = 'local';

await import('./copilot-hook.mjs');
