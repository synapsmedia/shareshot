const test = require('node:test');
const assert = require('node:assert');
const { createRateLimit } = require('../src/core/rate-limit');

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
