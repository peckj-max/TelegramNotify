/**
 * Maps VS Code settings (the `telegramNotify` section) onto the bridge config.
 *
 * The extension host reads the section through `workspace.getConfiguration`;
 * hooks and the CLI read the same values from `settings.json`. Both go through
 * `configFromSettings`, so the editor and the bridge cannot drift apart.
 */

/**
 * Every setting the section contributes, in the order the Settings UI shows it.
 * Single source of truth: the extension reads the section through this list, and
 * the hooks read `settings.json` through it too.
 */
export const ALL_SETTINGS = [
  'notificationsEnabled',
  'botToken',
  'chatId',
  'agents.local',
  'agents.copilot',
  'agents.opencode',
  'agents.claude',
  'notifyOnCompleted',
  'notifyOnStart',
  'replyTimeoutSeconds',
  'maxMessageLength',
  'webhookEnabled',
  'webhookPort',
  'webhookHost',
  'webhookPath',
  'webhookSecretToken',
  'publicUrl',
  'pollingTimeoutSeconds',
  'remotePromptEnabled',
  'claudeOpenSession',
  'claudeAskWindowSeconds',
  'panelWaitSeconds',
];

/**
 * @param {Record<string, unknown>} settings flat section values, e.g. `{ botToken: '…' }`
 * @returns {Record<string, any>} a config object ready for `normalizeConfig`
 */
export function configFromSettings(settings = {}) {
  const raw = {
    notificationsEnabled: settings.notificationsEnabled,
    botToken: settings.botToken,
    chatId: settings.chatId,
    agents: {
      local: settings['agents.local'],
      copilot: settings['agents.copilot'],
      opencode: settings['agents.opencode'],
      claude: settings['agents.claude'],
    },
    notifyOnCompleted: settings.notifyOnCompleted,
    notifyOnStart: settings.notifyOnStart,
    replyTimeoutSeconds: settings.replyTimeoutSeconds,
    maxMessageLength: settings.maxMessageLength,
    webhookEnabled: settings.webhookEnabled,
    webhookPort: settings.webhookPort,
    webhookHost: settings.webhookHost,
    webhookPath: settings.webhookPath,
    webhookSecretToken: settings.webhookSecretToken,
    publicUrl: settings.publicUrl,
    pollingTimeoutSeconds: settings.pollingTimeoutSeconds,
    remotePromptEnabled: settings.remotePromptEnabled,
    claudeOpenSession: settings.claudeOpenSession,
    claudeAskWindowSeconds: settings.claudeAskWindowSeconds,
    panelWaitSeconds: settings.panelWaitSeconds,
  };
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined || raw[key] === null) delete raw[key];
  }
  return raw;
}

/**
 * Reads the section the way `configFromSettings` expects it.
 *
 * @param {(key: string) => any} get a `getConfiguration(...).get`
 */
export function readSettingsSection(get) {
  const flat = {};
  for (const key of ALL_SETTINGS) flat[key] = get(key);
  return flat;
}
