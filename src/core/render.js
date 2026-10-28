const crypto = require('crypto');
const { getBrowser } = require('./browser');
const { isAllowedRequest } = require('./network');
const { selfOrigin } = require('./server');
const { HttpError } = require('./errors');

const FORMATS = ['webp', 'png', 'jpeg'];
const MAX_DIMENSION = 4096;
const MAX_DPR = 3;

const maxConcurrentRenders = Number(process.env.MAX_CONCURRENT_RENDERS) || 4;
let activeRenders = 0;
const waiting = [];

/**
 * Rendered HTML waiting for the browser, by a random token. The browser loads
 * it from this server, so a template's relative URLs (/template-assets/...)
 * resolve, and it is gone once the screenshot is taken.
 */
const pages = new Map();

function getPage(token) {
  return pages.get(token);
}

/** Runs `render` once fewer than MAX_CONCURRENT_RENDERS pages are open. */
async function withRenderSlot(render) {
  if (activeRenders >= maxConcurrentRenders) {
    await new Promise(resolve => waiting.push(resolve));
  }
  activeRenders++;
  try {
    return await render();
  } finally {
    activeRenders--;
    waiting.shift()?.();
  }
}

function parseNumber(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  }
  return number;
}

/** Size and format from the query: `width`, `height`, `dpr` and `format` (`webp` when missing). */
function parseRenderOptions(query) {
  const format = query.format || 'webp';
  if (!FORMATS.includes(format)) throw new HttpError(400, `format must be one of ${FORMATS.join(', ')}`);

  return {
    width: Math.round(parseNumber(query.width, 1200, 1, MAX_DIMENSION, 'width')),
    height: Math.round(parseNumber(query.height, 630, 1, MAX_DIMENSION, 'height')),
    dpr: parseNumber(query.dpr, 2, 0.5, MAX_DPR, 'dpr'),
    format,
  };
}

/** No render may hold a slot longer than this, whatever part of it hangs. */
const RENDER_TIMEOUT_MS = 20000;

async function screenshotPage(page, token, { width, height, dpr, format }) {
  // Every render is fresh: a cached page would answer 304.
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    try {
      if (await isAllowedRequest(request.url())) {
        await request.continue();
      } else {
        await request.abort('blockedbyclient');
      }
    } catch {
      // The page was closed while the request waited
    }
  });

  await page.setViewport({ width, height, deviceScaleFactor: dpr });

  const response = await page.goto(`${selfOrigin}/render/${token}`, {
    waitUntil: ['networkidle0', 'domcontentloaded'],
    timeout: 10000,
  });
  if (!response || response.status() >= 400) throw new Error(`Rendered page answered ${response?.status()}`);

  await page.evaluateHandle('document.fonts.ready');

  return page.screenshot({ type: format, fullPage: false });
}

/** Screenshots `html`, rendered as a page of this server. */
async function renderImage(html, options) {
  return withRenderSlot(async () => {
    const token = crypto.randomBytes(16).toString('hex');
    pages.set(token, html);
    // Each render in its own context, which is its own window: a page behind
    // another one in the same window may stop painting and never give a
    // screenshot. It also keeps renders from sharing cookies and storage.
    const context = await getBrowser().createBrowserContext();
    const page = await context.newPage();

    const screenshot = screenshotPage(page, token, options);
    screenshot.catch(() => {}); // it may fail after the deadline, with no one waiting
    let timer;
    try {
      return await Promise.race([
        screenshot,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new HttpError(504, 'Rendering took too long')), RENDER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      pages.delete(token);
      // A page that hung may not close quickly either; the slot doesn't wait for it
      context.close().catch(() => {});
    }
  });
}

module.exports = { renderImage, parseRenderOptions, getPage };
