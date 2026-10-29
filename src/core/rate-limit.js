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

module.exports = { createRateLimit };
