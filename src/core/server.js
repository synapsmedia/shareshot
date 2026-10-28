const PORT = Number(process.env.PORT) || 3000;

/** Where the browser reaches this server, to render a template as a page of its own origin. */
const selfOrigin = `http://127.0.0.1:${PORT}`;

module.exports = { PORT, selfOrigin };
