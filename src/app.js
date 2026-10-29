const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { registerHelpers } = require('./core/handlebars');
const { renderTemplate, listTemplates, templateDirs, addSourceTemplateDir } = require('./core/templates');
const { renderImage, parseRenderOptions, getPage } = require('./core/render');
const { fetchPublic } = require('./core/network');
const { selfOrigin } = require('./core/server');
const { HttpError } = require('./core/errors');
const { checkSignature, keysFromEnv, signUrl } = require('./core/signing');
const { createRateLimits, parseRateLimits } = require('./core/rate-limit');
const { initBrowser, closeBrowser } = require('./core/browser');
const builtInSources = require('./sources');
const { version } = require('../package.json');

const REPOSITORY_URL = 'https://github.com/synapsmedia/shareshot';

/** Who runs this instance, credited in the playground's footer. */
const { OPERATOR_NAME, OPERATOR_URL } = process.env;

const {
  RATE_LIMITS,
  RATE_LIMIT_PER_HOUR,
  PAGE_RATE_LIMITS = '',
  MAX_RENDERS_PER_ADDRESS = '0',
  REQUIRE_SIGNATURE,
  SIGNING_KEYS,
  TRUST_PROXY = '',
  CACHE_MAX_AGE = '86400',
} = process.env;

/** Query parameters for the renderer itself, never passed to templates. */
const RENDER_PARAMS = ['width', 'height', 'dpr', 'format', 'source', 'kid', 'sig'];

/**
 * Rendered pages may run only the scripts a template ships in its assets/.
 * Variables are HTML-escaped, so they can't add markup; this also stops a
 * script in case a template puts a variable somewhere escaping doesn't cover.
 */
const PAGE_POLICY = "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

function sendPage(res, html) {
  res.set('Content-Security-Policy', PAGE_POLICY).type('html').send(html);
}

/** TRUST_PROXY as Express's `trust proxy`: a hop count, `true`, or addresses and subnets. */
function trustProxySetting(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map(entry => entry.trim());
}

/** "40 seconds", "12 minutes" or "3 hours" until `time`. */
function timeUntil(time) {
  const seconds = Math.max(1, Math.ceil((time - Date.now()) / 1000));
  const [amount, unit] = seconds < 60 ? [seconds, 'second']
    : seconds < 2 * 60 * 60 ? [Math.ceil(seconds / 60), 'minute']
    : [Math.ceil(seconds / 3600), 'hour'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

const PUBLIC_DIR = path.join(__dirname, '../public');

/** The playground's own files that index.html links to, like style.css. */
const PUBLIC_FILE = /((?:href|src)=")([\w.-]+\.(?:css|js|svg|png|ico|webmanifest))"/g;

/** file → { mtimeMs, hash }, so a file is hashed again only once it changes */
const fileHashes = new Map();

async function fileHash(file) {
  const { mtimeMs } = await fs.stat(file);
  const known = fileHashes.get(file);
  if (known?.mtimeMs === mtimeMs) return known.hash;
  const hash = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex').slice(0, 12);
  fileHashes.set(file, { mtimeMs, hash });
  return hash;
}

/**
 * index.html with `?v=` and a hash of each file it links to, so a CDN can keep
 * those for good and a new release is fetched under a new URL.
 */
async function playgroundPage() {
  const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  const files = [...new Set([...html.matchAll(PUBLIC_FILE)].map(([, , file]) => file))];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, await fileHash(path.join(PUBLIC_DIR, file)).catch(() => null)])));
  return html.replace(PUBLIC_FILE, (link, start, file) => (hashes[file] ? `${start}${file}?v=${hashes[file]}"` : link));
}

/** How long a source's answer is reused, so a live preview doesn't fetch the site on every change. */
const SOURCE_CACHE_MS = 60 * 1000;
const SOURCE_CACHE_ENTRIES = 500;

/**
 * The HTTP app. `sources` replaces the built-in ones, so a deployment can add
 * its own (`{ ...sources, mine }`) or leave some out. `signingKey(kid)`
 * resolves to the secret for a signed URL's `kid`, or null; it defaults to
 * the keys in SIGNING_KEYS, and a deployment can pass its own, e.g. to look
 * keys up per customer.
 */
function createApp({ sources = builtInSources, signingKey } = {}) {
  const app = express();
  app.set('trust proxy', trustProxySetting(TRUST_PROXY));

  // Nothing is cached unless a route says so: pages and API answers change
  // with each release, and a CDN would keep serving the old ones
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const envKeys = keysFromEnv(SIGNING_KEYS);
  const lookUpKey = signingKey ?? (async kid => envKeys.get(kid) ?? null);
  const requireSignature = REQUIRE_SIGNATURE === '1';
  // RATE_LIMIT_PER_HOUR is how 1.1 said it
  const imageLimits = createRateLimits(parseRateLimits(RATE_LIMITS
    ?? (Number(RATE_LIMIT_PER_HOUR) > 0 ? `${Number(RATE_LIMIT_PER_HOUR)}/hour` : '')));
  const pageLimits = createRateLimits(parseRateLimits(PAGE_RATE_LIMITS));
  const maxRendersPerAddress = Number(MAX_RENDERS_PER_ADDRESS) || 0;
  const cacheMaxAge = Number(CACHE_MAX_AGE) || 0;

  /** address → images it has in progress */
  const rendering = new Map();

  /** Counts an image in progress for the address until its response closes. */
  function holdRender(req, res) {
    const count = rendering.get(req.ip) ?? 0;
    if (count >= maxRendersPerAddress) {
      throw new HttpError(429, `Wait for your ${count === 1 ? 'image' : `${count} images`} in progress before asking for another`, { 'Retry-After': '5' });
    }
    rendering.set(req.ip, count + 1);
    res.on('close', () => {
      const left = rendering.get(req.ip) - 1;
      if (left > 0) rendering.set(req.ip, left);
      else rendering.delete(req.ip);
    });
  }

  /**
   * In front of every render: a signed URL is let through, a badly signed one
   * refused; an unsigned one is refused under REQUIRE_SIGNATURE=1, and
   * otherwise counts towards the address's `limits`, as a `noun`. Unsigned
   * images may also be in progress only MAX_RENDERS_PER_ADDRESS at a time.
   */
  function guard(limits, noun, { image = false } = {}) {
    return async (req, res, next) => {
      const signature = await checkSignature(req.originalUrl, lookUpKey);
      if (signature === 'valid') return next();
      if (signature === 'invalid') throw new HttpError(403, 'The signature (sig and kid) is not valid');
      if (requireSignature) throw new HttpError(401, 'This server only renders signed URLs');

      // Before counting, so a request turned away here doesn't use up the limit
      if (image && maxRendersPerAddress) holdRender(req, res);
      const taken = limits?.take(req.ip);
      if (taken && !taken.allowed) {
        const when = taken.per === 'day' ? 'today' : `this ${taken.per}`;
        throw new HttpError(429, `That's ${taken.limit} ${noun} ${when}, the most this server makes for one address. Try again in ${timeUntil(taken.resetAt)}.`,
          { 'Retry-After': String(Math.ceil((taken.resetAt - Date.now()) / 1000)) });
      }
      next();
    };
  }

  const guardImage = guard(imageLimits, 'images', { image: true });
  const guardPage = guard(pageLimits, 'previews');

  /** "source params" → its answer, as a promise, until it expires; oldest first. */
  const sourceAnswers = new Map();

  function cachedContext(source, sourceName, params) {
    const key = `${sourceName} ${JSON.stringify(params)}`;
    const cached = sourceAnswers.get(key);
    if (cached && cached.expires > Date.now()) return cached.answer;

    sourceAnswers.delete(key);
    const answer = Promise.resolve().then(() => source.context(params, { fetch: fetchPublic }));
    sourceAnswers.set(key, { expires: Date.now() + SOURCE_CACHE_MS, answer });
    answer.catch(() => sourceAnswers.delete(key));
    for (const [oldest] of sourceAnswers) {
      if (sourceAnswers.size <= SOURCE_CACHE_ENTRIES) break;
      sourceAnswers.delete(oldest);
    }
    return answer;
  }

  registerHelpers();
  for (const source of Object.values(sources)) {
    if (source.templatesDir) addSourceTemplateDir(source.templatesDir);
  }

  /** The template's variables: what the requested source fills in, overridden by the query string. */
  async function templateContext(query) {
    const sourceName = query.source;
    const source = sourceName ? sources[sourceName] : null;
    if (sourceName && !source) {
      throw new HttpError(400, `Unknown source "${sourceName}"; available: ${Object.keys(sources).join(', ') || 'none'}`);
    }

    const sourceParams = Object.keys(source?.params ?? {});
    const variables = Object.fromEntries(Object.entries(query).filter(([name]) => !RENDER_PARAMS.includes(name) && !sourceParams.includes(name)));
    if (!source) return variables;

    const params = {};
    for (const [name, { required }] of Object.entries(source.params)) {
      const value = query[name];
      if (value !== undefined && typeof value !== 'string') throw new HttpError(400, `${name} must be given once`);
      if (required && !value) throw new HttpError(400, `${name} is required for source "${sourceName}"`);
      if (value) params[name] = value;
    }

    const filled = await cachedContext(source, sourceName, params);
    // A source leaves out what it doesn't have, rather than blanking a query variable
    const known = Object.fromEntries(Object.entries(filled).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return { ...known, ...variables };
  }

  app.get(['/', '/index.html'], async (req, res) => {
    res.type('html').send(await playgroundPage());
  });
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    cacheControl: false,
    // Linked with a hash of their contents, so they never change under that URL
    setHeaders: res => {
      if (res.req.query.v) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  for (const dir of templateDirs()) {
    app.use('/template-assets', express.static(path.join(dir, 'assets'), {
      cacheControl: false,
      setHeaders: res => {
        // The playground's live preview is a sandboxed frame, a different origin, so fonts need CORS
        res.set('Access-Control-Allow-Origin', '*');
        // Templates link these without a version, so not for long
        res.set('Cache-Control', 'public, max-age=3600');
      },
    }));
  }

  app.get('/image/:template', guardImage, async (req, res) => {
    const options = parseRenderOptions(req.query);
    const html = await renderTemplate(req.params.template, await templateContext(req.query), selfOrigin);
    const image = await renderImage(html, options);
    // The same URL gives the same image, so CDNs and browsers may keep it
    res.set('Cache-Control', cacheMaxAge > 0 ? `public, max-age=${cacheMaxAge}` : 'no-store');
    res.type(options.format).send(image);
  });

  app.get('/template/:template', guardPage, async (req, res) => {
    const html = await renderTemplate(req.params.template, await templateContext(req.query), `${req.protocol}://${req.get('host')}`);
    sendPage(res, html);
  });

  // The page the browser screenshots; only exists while that render runs.
  app.get('/render/:token', (req, res) => {
    const html = getPage(req.params.token);
    if (html === undefined) return res.sendStatus(404);
    sendPage(res, html);
  });

  // Thumbnails for the playground, rendered once from each template's example
  // fields, so they take no input.
  const previews = new Map();

  app.get('/preview/:template', async (req, res) => {
    const name = req.params.template;
    let preview = previews.get(name);
    if (!preview) {
      const template = (await listTemplates()).find(t => t.name === name);
      if (!template) throw new HttpError(404, `No template named "${name}"`);

      const { width = 1200, height = 630 } = template;
      preview = renderTemplate(name, template.fields ?? {}, selfOrigin)
        .then(html => renderImage(html, { width, height, dpr: 960 / width, format: 'webp' }, { alwaysWait: true }));
      previews.set(name, preview);
      preview.catch(() => previews.delete(name));
    }
    res.set('Cache-Control', 'public, max-age=3600').type('webp').send(await preview);
  });

  app.get('/templates', async (req, res) => {
    res.json(await listTemplates());
  });

  app.get('/info', (req, res) => {
    res.json({
      version,
      repository: REPOSITORY_URL,
      operator: OPERATOR_NAME ? { name: OPERATOR_NAME, url: OPERATOR_URL || null } : null,
    });
  });

  app.get('/sources', (req, res) => {
    res.json(Object.fromEntries(Object.entries(sources).map(([name, { description, params, variables = [] }]) => [name, { description, params, variables }])));
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // What the caller's address has left of each limit
  app.get('/limits', (req, res) => {
    res.json({
      signatureRequired: requireSignature,
      rateLimits: { images: imageLimits?.peek(req.ip) ?? [], previews: pageLimits?.peek(req.ip) ?? [] },
      rendersPerAddress: maxRendersPerAddress || null,
    });
  });

  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    res.set('Cache-Control', 'no-store');
    if (error instanceof HttpError) return res.status(error.status).set(error.headers).json({ error: error.message });
    console.error(`${req.method} ${req.path}:`, error);
    res.status(500).json({ error: 'Rendering failed' });
  });

  return app;
}

module.exports = { createApp, initBrowser, closeBrowser, sources: builtInSources, HttpError, signUrl };
