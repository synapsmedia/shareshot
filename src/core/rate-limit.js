const UNITS = { second: 1000, minute: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 };

/**
 * At most `limit` requests per client address in each window, counted in
 * this process's memory: with several replicas, each counts its own.
 */
function createRateLimit({ limit, windowMs }) {
  /** address → { count, resetAt } */
  const clients = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [address, client] of clients) {
      if (client.resetAt <= now) clients.delete(address);
    }
  }, windowMs);
  sweep.unref();

  function current(address) {
    const client = clients.get(address);
    return client && client.resetAt > Date.now() ? client : { count: 0, resetAt: Date.now() + windowMs };
  }

  return {
    limit,
    windowMs,

    /** Counts one request; `allowed` is false once the address has used up the window. */
    take(address) {
      const client = current(address);
      if (client.count >= limit) return { allowed: false, remaining: 0, resetAt: client.resetAt };
      client.count++;
      clients.set(address, client);
      return { allowed: true, remaining: limit - client.count, resetAt: client.resetAt };
    },

    /** What the address has left, without counting. */
    peek(address) {
      const client = current(address);
      return { remaining: Math.max(0, limit - client.count), resetAt: client.resetAt };
    },
  };
}

/** "10/minute,60/hour" as [{ limit: 10, per: 'minute', windowMs }, …]; empty for "". */
function parseRateLimits(value = '') {
  return value.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const match = entry.match(/^(\d+)\s*\/\s*(second|minute|hour|day)$/);
    if (!match || Number(match[1]) < 1) throw new Error(`Rate limits look like 10/minute,60/hour; got "${entry}"`);
    return { limit: Number(match[1]), per: match[2], windowMs: UNITS[match[2]] };
  });
}

/**
 * Several windows at once, e.g. 10 a minute and 60 an hour: a request is let
 * through only if every window has room, and then counts in all of them.
 * Null when there are no windows.
 */
function createRateLimits(rules) {
  if (!rules.length) return null;
  const windows = rules.map(rule => ({ per: rule.per, ...createRateLimit(rule) }));

  return {
    windows,

    /** Counts one request, or names the window that is used up: { allowed, limit, per, resetAt }. */
    take(address) {
      const full = windows
        .map(window => ({ window, ...window.peek(address) }))
        .filter(({ remaining }) => remaining === 0)
        .sort((a, b) => b.resetAt - a.resetAt)[0];
      if (full) return { allowed: false, limit: full.window.limit, per: full.window.per, resetAt: full.resetAt };
      for (const window of windows) window.take(address);
      return { allowed: true };
    },

    /** Each window's limit and what the address has left of it. */
    peek(address) {
      return windows.map(window => ({ limit: window.limit, per: window.per, ...window.peek(address) }));
    },
  };
}

module.exports = { createRateLimit, createRateLimits, parseRateLimits };
