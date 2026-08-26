'use strict';

// Isolated test for sheets.withRetry. This file deliberately does NOT stub
// sheets.js in require.cache, so it can import the real module and exercise
// the retry helper directly. Kept in its own file to avoid contaminating the
// productionReadiness suite's fake adapter.

const test   = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../sheets');

test('sheets.withRetry retries on 429 then succeeds', async () => {
  assert.equal(typeof sheets.withRetry, 'function', 'withRetry must be exported');
  let calls = 0;
  const started = Date.now();
  const result = await sheets.withRetry(async () => {
    calls++;
    if (calls < 3) {
      const err = new Error('rateLimitExceeded');
      err.code = 429;
      throw err;
    }
    return 'ok';
  }, 'test-429');
  assert.equal(result, 'ok');
  assert.equal(calls, 3, 'should have retried twice then succeeded');
  // First two backoffs are 500ms + 1000ms base (+ up to 250ms jitter each).
  assert.ok(Date.now() - started >= 1400, 'must actually sleep between retries');
});

test('sheets.withRetry gives up quickly on non-retryable errors', async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(async () => {
    await sheets.withRetry(async () => {
      calls++;
      const err = new Error('not found');
      err.code = 404;
      throw err;
    }, 'test-404');
  }, /not found/);
  assert.equal(calls, 1, 'non-retryable errors must not retry');
  assert.ok(Date.now() - started < 100, 'must fail fast on non-retryable errors');
});

test('sheets.withRetry recognises text-based rate-limit reasons', () => {
  assert.equal(sheets._isRetryable({ code: 429 }), true);
  assert.equal(sheets._isRetryable({ code: 503 }), true);
  assert.equal(sheets._isRetryable({ code: 500 }), true);
  assert.equal(sheets._isRetryable({ message: 'userRateLimitExceeded' }), true);
  assert.equal(sheets._isRetryable({ message: 'quotaExceeded' }), true);
  assert.equal(sheets._isRetryable({ code: 404 }), false);
  assert.equal(sheets._isRetryable({ code: 400, message: 'bad request' }), false);
});

test('sheets.withRetry surrenders after max attempts and throws last error', async () => {
  let calls = 0;
  await assert.rejects(async () => {
    await sheets.withRetry(async () => {
      calls++;
      const err = new Error('rateLimitExceeded');
      err.code = 429;
      throw err;
    }, 'test-exhaust');
  }, /rateLimitExceeded/);
  // 4 backoffs configured → 5 total attempts (initial + 4 retries).
  assert.equal(calls, 5, 'must attempt the initial call plus 4 retries');
});
