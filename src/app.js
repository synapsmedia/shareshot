const express = require('express');
const path = require('path');
const { registerHelpers } = require('./core/handlebars');
const { renderTemplate, listTemplates, templateDirs, addSourceTemplateDir } = require('./core/templates');
const { renderImage, parseRenderOptions, getPage } = require('./core/render');
const { fetchPublic } = require('./core/network');
const { selfOrigin } = require('./core/server');
const { HttpError } = require('./core/errors');
const { initBrowser, closeBrowser } = require('./core/browser');
const builtInSources = require('./sources');
const { version } = require('../package.json');

const REPOSITORY_URL = 'https://github.com/synapsmedia/shareshot';

/** Who runs this instance, credited in the playground's footer. */
const { OPERATOR_NAME, OPERATOR_URL } = process.env;

/** Query parameters for the renderer itself, never passed to templates. */
const RENDER_PARAMS = ['width', 'height', 'dpr', 'format', 'source'];

/**
 * Rendered pages may run only the scripts a template ships in its assets/.
 * Variables are HTML-escaped, so they can't add markup; this also stops a
 * script in case a template puts a variable somewhere escaping doesn't cover.
 */
const PAGE_POLICY = "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

function sendPage(res, html) {
  res.set('Content-Security-Policy', PAGE_POLICY).type('html').send(html);
}

/**
 * The HTTP app. `sources` replaces the built-in ones, so a deployment can add
 * its own (`{ ...sources, mine }`) or leave some out.
 */
function createApp({ sources = builtInSources } = {}) {
  const app = express();

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

  app.get('/image/:template', async (req, res) => {
    const options = parseRenderOptions(req.query);
    const html = await renderTemplate(req.params.template, await templateContext(req.query), selfOrigin);
    res.type(options.format).send(await renderImage(html, options));
  });

  app.get('/template/:template', async (req, res) => {
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

  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error(`${req.method} ${req.path}:`, error);
    res.status(500).json({ error: 'Rendering failed' });
  });

  return app;
}

module.exports = { createApp, initBrowser, closeBrowser, sources: builtInSources, HttpError };
