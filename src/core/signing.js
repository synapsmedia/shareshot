const crypto = require('crypto');

/**
 * Signed URLs: `sig` is the HMAC-SHA256, in hex, of the URL's path, `?`, and
 * its query parameters except `sig`, sorted by name and then value, each
 * name and value percent-encoded as JavaScript's encodeURIComponent does,
 * joined with `&`. `kid` names the key, so keys can be rotated and several
 * signers can have their own:
 *
 *   /image/article?kid=main&title=Hello&sig=4f1c…
 *
 * signs "/image/article?kid=main&title=Hello".
 */
function canonicalString(path, searchParams) {
  const pairs = [...searchParams].filter(([name]) => name !== 'sig');
  pairs.sort(([nameA, valueA], [nameB, valueB]) => (nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0));
  return `${path}?${pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`;
}

function hmac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

/** Adds `kid` and `sig` to a URL (absolute, or a path with its query). */
function signUrl(input, { kid, secret }) {
  const url = new URL(input, 'http://localhost');
  url.searchParams.delete('sig');
  url.searchParams.set('kid', kid);
  url.searchParams.set('sig', hmac(secret, canonicalString(url.pathname, url.searchParams)));
  return /^https?:\/\//i.test(input) ? url.toString() : `${url.pathname}${url.search}`;
}

/** Keys from SIGNING_KEYS, `kid:secret` pairs separated by commas. */
function keysFromEnv(value = '') {
  const keys = new Map();
  for (const pair of value.split(',').map(entry => entry.trim()).filter(Boolean)) {
    const separator = pair.indexOf(':');
    if (separator < 1 || separator === pair.length - 1) throw new Error('SIGNING_KEYS must be kid:secret pairs, separated by commas');
    keys.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return keys;
}

/**
 * Whether a request's URL (`originalUrl`, e.g. "/image/article?…") carries a
 * signature: 'unsigned', 'valid' or 'invalid'. `signingKey(kid)` resolves to
 * the key's secret, or null for an unknown kid.
 */
async function checkSignature(originalUrl, signingKey) {
  const url = new URL(originalUrl, 'http://localhost');
  const sig = url.searchParams.get('sig');
  if (sig === null) return 'unsigned';

  const kid = url.searchParams.get('kid');
  const secret = kid ? await signingKey(kid) : null;
  if (!secret) return 'invalid';

  const expected = Buffer.from(hmac(secret, canonicalString(url.pathname, url.searchParams)));
  const given = Buffer.from(sig.toLowerCase());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? 'valid' : 'invalid';
}

module.exports = { signUrl, checkSignature, keysFromEnv, canonicalString };
