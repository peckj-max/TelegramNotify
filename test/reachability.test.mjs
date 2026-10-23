import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProblem, describeReachability, probeWebhook } from '../src/reachability.mjs';
import { normalizeConfig } from '../src/config.mjs';

const config = (publicUrl) =>
  normalizeConfig({ publicUrl, webhookPath: '/telegram/webhook', botToken: '1:a', chatId: '2', webhookSecretToken: 's' }, { env: {} });

const respond = (status) => async () => ({ status });

test('no publicUrl means nothing to probe', async () => {
  const result = await probeWebhook(config(''), { fetchImpl: respond(500) });
  assert.deepEqual(result, { url: '', problem: '' });
  assert.equal(describeReachability(result), 'not set (no publicUrl)');
});

test('405 from the bridge counts as reachable', async () => {
  const result = await probeWebhook(config('https://x.example.com'), { fetchImpl: respond(405) });
  assert.equal(result.status, 405);
  assert.equal(result.problem, '');
  assert.equal(describeReachability(result), '405 from https://x.example.com/telegram/webhook');
});

test('a deployed site that rejects the secret (401) is also reachable', async () => {
  const result = await probeWebhook(config('https://x.example.com'), { fetchImpl: respond(401) });
  assert.equal(result.problem, '');
});

test('404 names the nginx deployment step', async () => {
  const problem = describeProblem(404);
  assert.match(problem, /nginx site is not deployed/);
  assert.match(problem, /deploy\/nginx/);
});

test('502 and 504 point at the upstream', () => {
  for (const status of [502, 504]) {
    assert.match(describeProblem(status), /cannot reach the bridge/);
  }
});

test('426 says the URL must be https', () => {
  assert.match(describeProblem(426), /https/);
});

test('other statuses are reported verbatim', () => {
  assert.equal(describeProblem(418), 'unexpected status 418');
});

test('a network failure is reported, not thrown', async () => {
  const failing = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const result = await probeWebhook(config('https://missing.example.com'), { fetchImpl: failing });
  assert.match(result.problem, /unreachable: getaddrinfo/);
  assert.equal(result.status, undefined);
  assert.match(describeReachability(result), /^no response from/);
});
