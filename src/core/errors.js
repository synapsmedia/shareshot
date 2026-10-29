/**
 * An error the caller caused or should see, answered with `status` and its
 * message, and `headers` such as Retry-After.
 */
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

module.exports = { HttpError };
