const { createApp, initBrowser, closeBrowser } = require('./app');
const { PORT } = require('./core/server');

async function start() {
  await initBrowser();

  createApp().listen(PORT, () => {
    console.log(`Shareshot running on port ${PORT}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  await closeBrowser();
  process.exit(0);
});

start().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
