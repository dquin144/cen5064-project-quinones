// Folio's settings, read from the environment in one place.
// Singleton: getConfig() always returns the same frozen object, loaded once.
// Only server.js calls it; it passes the config down through service.configure(),
// so no other file reads process.env. Tests build their own with loadConfig().

const path = require('node:path');

// Builds a config from an env-like object. Missing keys become null.
function loadConfig(env = {}) {
  const port = Number(env.PORT) || 3000;
  return Object.freeze({
    port,
    appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'folio.db'),
    finnhubApiKey: env.FINNHUB_API_KEY || null,
    snaptrade: Object.freeze({
      clientId: env.SNAPTRADE_CLIENT_ID || null,
      consumerKey: env.SNAPTRADE_CONSUMER_KEY || null,
    }),
  });
}

let instance = null;

function getConfig() {
  if (!instance) instance = loadConfig(process.env);
  return instance;
}

module.exports = { getConfig, loadConfig };
