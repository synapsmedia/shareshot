const test = require('node:test');
const assert = require('node:assert');
const { createRateLimit, createRateLimits, parseRateLimits } = require('../src/core/rate-limit');

test('each address gets its own allowance, and peek does not count', () => {
  const limit = createRateLimit({ limit: 2, windowMs: 60_000 });
  assert.strictEqual(limit.take('a').remaining, 1);
  assert.strictEqual(limit.peek('a').remaining, 1);
  assert.strictEqual(limit.take('a').remaining, 0);
  assert.strictEqual(limit.take('a').allowed, false);
  assert.strictEqual(limit.take('b').allowed, true);
});

test('the allowance comes back when the window ends', async () => {
  const limit = createRateLimit({ limit: 1, windowMs: 50 });
  assert.strictEqual(limit.take('a').allowed, true);
  assert.strictEqual(limit.take('a').allowed, false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.strictEqual(limit.take('a').allowed, true);
});

test('limits are written as count/unit, separated by commas', () => {
  assert.deepStrictEqual(parseRateLimits(' 10/minute, 60/hour '), [
    { limit: 10, per: 'minute', windowMs: 60_000 },
    { limit: 60, per: 'hour', windowMs: 3_600_000 },
  ]);
  assert.deepStrictEqual(parseRateLimits(''), []);
  assert.throws(() => parseRateLimits('10 per minute'));
  assert.throws(() => parseRateLimits('0/hour'));
});

test('several windows: a request needs room in each, and counts in all', () => {
  const limits = createRateLimits([{ limit: 2, per: 'minute', windowMs: 60_000 }, { limit: 3, per: 'hour', windowMs: 3_600_000 }]);
  assert.strictEqual(limits.take('a').allowed, true);
  assert.strictEqual(limits.take('a').allowed, true);
  const refused = limits.take('a');
  assert.strictEqual(refused.allowed, false);
  assert.strictEqual(refused.per, 'minute');
  assert.deepStrictEqual(limits.peek('a').map(({ per, remaining }) => [per, remaining]), [['minute', 0], ['hour', 1]]);
  assert.strictEqual(createRateLimits([]), null);
});
