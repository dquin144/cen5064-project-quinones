// HTTP entry point: serves the pages in public/ and the JSON API.
// Kept thin — parses requests, calls the Service tier, sends responses.
//
// Login: the portfolio page and every /api/ route except /api/auth/* need a
// session. The session token lives in an HttpOnly cookie (SameSite=Lax, so other
// sites can't send requests with it); auth.js checks it and says whose portfolio
// the request is for.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('./src/config');
const service = require('./src/service');
const auth = require('./src/auth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 10 * 1024;
const SESSION_COOKIE = 'folio_session';
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// Pages that need a login; a logged-out visit is sent to the login page.
const PRIVATE_PAGES = new Set(['/portfolio.html']);

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the client still gets our reply
      body += chunk;
      if (body.length > MAX_BODY_BYTES) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new BadRequest('Request body too large.', 413));
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new BadRequest('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname);
  const file = path.resolve(PUBLIC_DIR, '.' + path.sep + relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });

  fs.readFile(file, (err, contents) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      // Pages differ by who's logged in, so the browser shouldn't reuse them.
      'Cache-Control': 'no-store',
    });
    res.end(contents);
  });
}

// "/api/holdings/12" with prefix "/api/holdings/" -> 12; anything else -> null.
function matchId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return /^[1-9]\d{0,15}$/.test(rest) ? Number(rest) : null;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function createServer(config = getConfig()) {
  // The one config object, read once and handed down.
  service.configure(config);
  const secure = config.appUrl.startsWith('https://') ? '; Secure' : '';
  const sessionCookie = ({ token }) =>
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.SESSION_DAYS * 24 * 60 * 60}${secure}`;
  const clearedCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;

  // The portfolio with live prices (cached briefly, so this is cheap to call often).
  async function pricedPortfolio(userId, fresh = false) {
    await service.refreshPrices({ fresh, userId });
    return service.getPortfolio(userId);
  }

  async function handle(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${pathname}`;
    const token = readCookie(req, SESSION_COOKIE);
    const user = auth.userForSession(token);
    req.userId = user ? String(user.id) : null;

    // ---- Accounts (no login needed) ----
    if (route === 'POST /api/auth/register') {
      const { user: created, session } = await auth.register(await readJson(req));
      return sendJson(res, 201, { user: { username: created.username } }, { 'Set-Cookie': sessionCookie(session) });
    }
    if (route === 'POST /api/auth/login') {
      const { user: found, session } = await auth.login(await readJson(req));
      return sendJson(res, 200, { user: { username: found.username } }, { 'Set-Cookie': sessionCookie(session) });
    }
    if (route === 'POST /api/auth/logout') {
      auth.logout(token);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie });
    }
    if (route === 'GET /api/auth/me') {
      return sendJson(res, 200, { user: user ? { username: user.username } : null });
    }

    // ---- Pages ----
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      if (PRIVATE_PAGES.has(pathname) && !user) {
        const next = pathname + (searchParams.size ? `?${searchParams}` : '');
        return redirect(res, `/login.html?next=${encodeURIComponent(next)}`);
      }
      return serveStatic(pathname, res);
    }

    // ---- Everything else needs a login ----
    if (!user) return sendJson(res, 401, { error: 'Please log in.' });
    const userId = req.userId;

    if (route === 'GET /api/portfolio') {
      return sendJson(res, 200, await pricedPortfolio(userId, searchParams.get('refresh') === '1'));
    }
    if (route === 'GET /api/recommendations') {
      await service.refreshPrices({ userId }); // cached briefly, so this is cheap
      return sendJson(res, 200, await service.getRecommendations({ fresh: searchParams.get('refresh') === '1', userId }));
    }
    if (route === 'GET /api/advice') {
      await service.refreshPrices({ userId });
      return sendJson(res, 200, await service.getAdvice({ fresh: searchParams.get('refresh') === '1', userId }));
    }
    if (route === 'POST /api/holdings') {
      const { errors } = service.addHolding(await readJson(req), userId);
      if (Object.keys(errors).length > 0) return sendJson(res, 400, { errors });
      return sendJson(res, 201, await pricedPortfolio(userId));
    }
    const holdingId = matchId(pathname, '/api/holdings/');
    if (holdingId && req.method === 'PUT') {
      const { errors } = service.updateHolding(holdingId, await readJson(req), userId);
      if (Object.keys(errors).length > 0) return sendJson(res, 400, { errors });
      return sendJson(res, 200, await pricedPortfolio(userId));
    }
    if (holdingId && req.method === 'DELETE') {
      service.removeHolding(holdingId, userId);
      return sendJson(res, 200, service.getPortfolio(userId));
    }
    const positionId = matchId(pathname, '/api/brokerage/positions/');
    if (positionId && req.method === 'PUT') {
      const { errors } = service.editBrokeragePosition(positionId, await readJson(req), userId);
      if (Object.keys(errors).length > 0) return sendJson(res, 400, { errors });
      return sendJson(res, 200, service.getPortfolio(userId));
    }
    if (positionId && req.method === 'DELETE') {
      service.removeBrokeragePosition(positionId, userId);
      return sendJson(res, 200, service.getPortfolio(userId));
    }
    if (route === 'POST /api/brokerage/connect') {
      const url = await service.startBrokerageConnection(`${config.appUrl}/portfolio.html?brokerage=connected`, userId);
      return sendJson(res, 200, { url });
    }
    if (route === 'POST /api/brokerage/sync') {
      const synced = await service.syncBrokerage(userId);
      await service.refreshPrices({ userId }); // newly synced tickers need prices too
      return sendJson(res, 200, { ...synced, ...service.getPortfolio(userId) });
    }
    if (route === 'POST /api/brokerage/conflicts') {
      const { keepMine } = await readJson(req);
      if (typeof keepMine !== 'boolean') throw new BadRequest('keepMine must be true or false.');
      return sendJson(res, 200, service.resolveSyncConflicts(keepMine, userId));
    }
    if (route === 'POST /api/brokerage/disconnect') {
      return sendJson(res, 200, await service.disconnectBrokerage(userId));
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof BadRequest) return sendJson(res, err.status, { error: err.message });
      if (err instanceof auth.AuthError) return sendJson(res, err.status, { error: err.message, errors: err.errors });
      if (err instanceof service.NotConfiguredError) return sendJson(res, 503, { error: err.message });
      if (err instanceof service.NotConnectedError) return sendJson(res, 409, { error: err.message });
      // Send the current portfolio along so the page can refresh its stale list.
      if (err instanceof service.NotFoundError) {
        return sendJson(res, 404, { error: err.message, portfolio: service.getPortfolio(req.userId) });
      }
      // SnapTrade failing doesn't stop the rest of Folio: send the portfolio so the
      // page keeps showing manual holdings and the last synced data.
      if (err instanceof service.BrokerageApiError) {
        console.error(`SnapTrade (${err.reason}): ${err.message}`);
        return sendJson(res, 502, { error: err.message, reason: err.reason, portfolio: service.getPortfolio(req.userId) });
      }
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const config = getConfig();
  createServer(config).listen(config.port, () => {
    console.log(`Folio running at http://localhost:${config.port}`);
  });
}
