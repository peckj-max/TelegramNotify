/**
 * Errors that the HTTP layer can translate into a specific status code.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [code]
   */
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? 'error';
  }
}

export class TelegramError extends Error {
  /**
   * @param {string} method
   * @param {number} status
   * @param {string} description
   */
  constructor(method, status, description) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

export class ConfigError extends Error {
  /**
   * @param {string[]} problems
   */
  constructor(problems) {
    super(`Invalid TelegramNotify configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}
