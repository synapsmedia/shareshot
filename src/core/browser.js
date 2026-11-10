const puppeteer = require('puppeteer');

let browser;

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    // A browser call that gets no answer fails after this, instead of the default 3 minutes
    protocolTimeout: 15000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Renders run side by side (see render.js); keep every one painting
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Clamped text (.clamp in the templates) stops painting after its last line.
      // Without this Chromium still paints the hidden lines, and the clip that lets
      // the last line's descenders show would let their accents show too.
      '--enable-blink-features=CSSLineClamp',
    ]
  });
  console.log('Browser initialized');
  return browser;
}

function getBrowser() {
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
  }
}

module.exports = { initBrowser, getBrowser, closeBrowser };
