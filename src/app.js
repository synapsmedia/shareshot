const express = require('express');
const path = require('path');
const { registerHelpers } = require('./core/handlebars');
const { renderTemplate, listTemplates, templateDirs, addSourceTemplateDir } = require('./core/templates');
const { renderImage, parseRenderOptions, getPage } = require('./core/render');
const { fetchPublic } = require('./core/network');
const { selfOrigin } = require('./core/server');
const { HttpError } = require('./core/errors');
const { checkSignature, keysFromEnv, signUrl } = require('./core/signing');
const { createRateLimit } = require('./core/rate-limit');
const { initBrowser, closeBrowser } = require('./core/browser');
const builtInSources = require('./sources');
const { version } = require('../package.json');

const REPOSITORY_URL = 'https://github.com/synapsmedia/shareshot';

/** Who runs this instance, credited in the playground's footer. */
const { OPERATOR_NAME, OPERATOR_URL } = process.env;

const {
  RATE_LIMIT_PER_HOUR = '0',
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

function minutesUntil(time) {
  return Math.max(1, Math.ceil((time - Date.now()) / 60000));
}

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

  const envKeys = keysFromEnv(SIGNING_KEYS);
  const lookUpKey = signingKey ?? (async kid => envKeys.get(kid) ?? null);
  const requireSignature = REQUIRE_SIGNATURE === '1';
  const rateLimit = Number(RATE_LIMIT_PER_HOUR) > 0
    ? createRateLimit({ limit: Number(RATE_LIMIT_PER_HOUR), windowMs: 60 * 60 * 1000 })
    : null;
  const cacheMaxAge = Number(CACHE_MAX_AGE) || 0;

  /**
   * In front of every render: a signed URL is let through, a badly signed one
   * refused; an unsigned one is refused under REQUIRE_SIGNATURE=1, and
   * otherwise counts towards the address's RATE_LIMIT_PER_HOUR.
   */
  async function guardRender(req, res, next) {
    const signature = await checkSignature(req.originalUrl, lookUpKey);
    if (signature === 'valid') return next();
    if (signature === 'invalid') throw new HttpError(403, 'The signature (sig and kid) is not valid');
    if (requireSignature) throw new HttpError(401, 'This server only renders signed URLs');

    if (rateLimit) {
      const { allowed, resetAt } = rateLimit.take(req.ip);
      if (!allowed) {
        res.set('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
        const minutes = minutesUntil(resetAt);
        throw new HttpError(429, `That's ${rateLimit.limit} images this hour, the most this server makes for one address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
    }
    next();
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

    const filled = await source.context(params, { fetch: fetchPublic });
    // A source leaves out what it doesn't have, rather than blanking a query variable
    const known = Object.fromEntries(Object.entries(filled).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return { ...known, ...variables };
  }

  app.use(express.static(path.join(__dirname, '../public')));
  for (const dir of templateDirs()) {
    app.use('/template-assets', express.static(path.join(dir, 'assets')));
  }

  app.get('/image/:template', guardRender, async (req, res) => {
    const options = parseRenderOptions(req.query);
    const html = await renderTemplate(req.params.template, await templateContext(req.query), selfOrigin);
    const image = await renderImage(html, options);
    // The same URL gives the same image, so CDNs and browsers may keep it
    res.set('Cache-Control', cacheMaxAge > 0 ? `public, max-age=${cacheMaxAge}` : 'no-store');
    res.type(options.format).send(image);
  });

  app.get('/template/:template', guardRender, async (req, res) => {
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
        .then(html => renderImage(html, { width, height, dpr: 960 / width, format: 'webp' }));
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

  // What the caller's address has left of RATE_LIMIT_PER_HOUR. Never cached:
  // a CDN would otherwise answer one visitor with another's numbers.
  app.get('/limits', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const limit = rateLimit && { perHour: rateLimit.limit, ...rateLimit.peek(req.ip) };
    res.json({ signatureRequired: requireSignature, rateLimit: limit || null });
  });

  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    res.set('Cache-Control', 'no-store');
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error(`${req.method} ${req.path}:`, error);
    res.status(500).json({ error: 'Rendering failed' });
  });

  return app;
}

module.exports = { createApp, initBrowser, closeBrowser, sources: builtInSources, HttpError, signUrl };
