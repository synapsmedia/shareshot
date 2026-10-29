const { requestPublic } = require('./network');

/**
 * What a rendered page loads from elsewhere (images, fonts, stylesheets) is
 * fetched by this server, not the browser: through requestPublic, so from
 * public addresses only, and within these limits. Successful answers are
 * kept for an hour, so a logo or a web font isn't fetched for every image.
 */
const RESOURCE_TYPES = ['image', 'font', 'stylesheet'];
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_RESOURCES_PER_RENDER = 40;
const RESOURCE_TIMEOUT_MS = 8000;

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_BYTES = 100 * 1024 * 1024;

/** url → { expires, resource }, oldest first, so eviction drops from the front. */
const cache = new Map();
let cachedBytes = 0;
/** url → the fetch in progress, shared by renders that need the same file at once. */
const inFlight = new Map();

function remember(url, resource) {
  if (resource.body.length > CACHE_MAX_BYTES / 10) return;
  forget(url);
  cache.set(url, { expires: Date.now() + CACHE_TTL_MS, resource });
  cachedBytes += resource.body.length;
  for (const [oldest] of cache) {
    if (cachedBytes <= CACHE_MAX_BYTES) break;
    forget(oldest);
  }
}

function forget(url) {
  const entry = cache.get(url);
  if (!entry) return;
  cache.delete(url);
  cachedBytes -= entry.resource.body.length;
}

/** The file at `url`, as { status, contentType, body }. */
async function fetchResource(url) {
  const entry = cache.get(url);
  if (entry && entry.expires > Date.now()) return entry.resource;
  forget(url);

  let pending = inFlight.get(url);
  if (!pending) {
    pending = requestPublic(url, { maxBytes: MAX_RESOURCE_BYTES, timeoutMs: RESOURCE_TIMEOUT_MS })
      .then(({ status, headers, body }) => {
        const resource = { status, contentType: headers['content-type'] || 'application/octet-stream', body };
        if (status === 200) remember(url, resource);
        return resource;
      })
      .finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
  }
  return pending;
}

/**
 * Answers a page's request for an outside file (a Puppeteer HTTPRequest)
 * with what fetchResource got, or aborts it. `count` is the render's
 * { outside } counter, for MAX_RESOURCES_PER_RENDER.
 */
async function respondWithResource(request, count) {
  if (request.method() !== 'GET' || !RESOURCE_TYPES.includes(request.resourceType())
      || ++count.outside > MAX_RESOURCES_PER_RENDER) {
    return request.abort('blockedbyclient');
  }

  try {
    const { status, contentType, body } = await fetchResource(request.url());
    // The page is this server's, so fonts from elsewhere need CORS to load
    await request.respond({ status, contentType, headers: { 'access-control-allow-origin': '*' }, body });
  } catch {
    await request.abort('failed');
  }
}

module.exports = { fetchResource, respondWithResource };
