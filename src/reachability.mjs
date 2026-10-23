import { webhookUrl } from './config.mjs';

/**
 * Calls the public webhook with a harmless GET. The bridge answers 405 for it,
 * so 405 means "nginx and the bridge are wired". Registering a URL proves
 * nothing on its own: if the site is missing, Telegram only reports the 404
 * after the first real message.
 *
 * @param {import('./config.mjs').RuntimeConfig} config
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ url: string, status?: number, problem: string }>}
 */
export async function probeWebhook(config, options = {}) {
  const url = webhookUrl(config);
  if (!url) return { url: '', problem: '' };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const status = response.status;
    return { url, status, problem: describeProblem(status) };
  } catch (err) {
    return { url, problem: `unreachable: ${err.message}` };
  }
}

/**
 * @param {number} status
 */
export function describeProblem(status) {
  if (status === 405 || status === 401) return '';
  if (status === 404) return 'the nginx site is not deployed for this host: deploy deploy/nginx/*.conf and reload nginx';
  if (status === 426) return 'only HTTP answered: set the webhook URL to https://';
  if (status === 502 || status === 504) {
    return 'nginx cannot reach the bridge: check webhookHost, the firewall and the upstream address';
  }
  return `unexpected status ${status}`;
}

/**
 * @param {{ url: string, status?: number, problem: string }} result
 */
export function describeReachability(result) {
  if (!result.url) return 'not set (no publicUrl)';
  if (result.status === undefined) return `no response from ${result.url}`;
  return `${result.status} from ${result.url}`;
}
