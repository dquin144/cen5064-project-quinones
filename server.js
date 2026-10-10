// HTTP entry point: serves the pages in public/ and the JSON API.
// Kept thin — parses requests, calls the Service tier, sends responses.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const service = require('./src/service');

const PORT = Number(process.env.PORT) || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 10 * 1024;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(contents);
  });
}

// "/api/holdings/12" with prefix "/api/holdings/" -> 12; anything else -> null.
function matchId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return /^[1-9]\d{0,15}$/.test(rest) ? Number(rest) : null;
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${pathname}`;

  if (route === 'GET /api/portfolio') {
    return sendJson(res, 200, service.getPortfolio());
  }
  if (route === 'POST /api/holdings') {
    const { errors } = service.addHolding(await readJson(req));
    if (Object.keys(errors).length > 0) return sendJson(res, 400, { errors });
    return sendJson(res, 201, service.getPortfolio());
  }
  const holdingId = matchId(pathname, '/api/holdings/');
  if (holdingId && req.method === 'PUT') {
    const { errors } = service.updateHolding(holdingId, await readJson(req));
    if (Object.keys(errors).length > 0) return sendJson(res, 400, { errors });
    return sendJson(res, 200, service.getPortfolio());
  }
  if (holdingId && req.method === 'DELETE') {
    service.removeHolding(holdingId);
    return sendJson(res, 200, service.getPortfolio());
  }
  const positionId = matchId(pathname, '/api/brokerage/positions/');
  if (positionId && req.method === 'DELETE') {
    service.removeBrokeragePosition(positionId);
    return sendJson(res, 200, service.getPortfolio());
  }
  if (route === 'POST /api/brokerage/connect') {
    const url = await service.startBrokerageConnection(`${APP_URL}/portfolio.html?brokerage=connected`);
    return sendJson(res, 200, { url });
  }
  if (route === 'POST /api/brokerage/sync') {
    return sendJson(res, 200, await service.syncBrokerage());
  }
  if (route === 'POST /api/brokerage/disconnect') {
    return sendJson(res, 200, await service.disconnectBrokerage());
  }
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    return serveStatic(pathname, res);
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof BadRequest) return sendJson(res, err.status, { error: err.message });
    if (err instanceof service.NotConfiguredError) return sendJson(res, 503, { error: err.message });
    if (err instanceof service.NotConnectedError) return sendJson(res, 409, { error: err.message });
    // Send the current portfolio along so the page can refresh its stale list.
    if (err instanceof service.NotFoundError) {
      return sendJson(res, 404, { error: err.message, portfolio: service.getPortfolio() });
    }
    if (err instanceof service.BrokerageApiError) {
      console.error(err.message);
      return sendJson(res, 502, { error: err.message });
    }
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  });
});

server.listen(PORT, () => {
  console.log(`Folio running at http://localhost:${PORT}`);
});
