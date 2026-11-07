// The login gate, end to end over HTTP: the real server, an in-memory database,
// and fetch with a cookie jar of one cookie.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const news = require('../src/news.js');
const { createServer } = require('../server.js');

let server;
let base;

before(async () => {
  data.closeDb();
  server = createServer(loadConfig({ DB_FILE: ':memory:', PORT: '0' }));
  // No network in tests: no prices and no news.
  const offline = async () => { throw new Error('offline'); };
  prices.setFetchForTests(offline);
  news.setFetchForTests(offline);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

// A browser with its own cookie.
function browser() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
}

test('logged out: the portfolio page redirects to login, the API says 401, public pages load', async () => {
  const visit = browser();
  const page = await visit('/portfolio.html?brokerage=connected');
  assert.strictEqual(page.status, 302);
  assert.strictEqual(page.headers.get('location'), '/login.html?next=%2Fportfolio.html%3Fbrokerage%3Dconnected');
  assert.strictEqual((await visit('/api/portfolio')).status, 401);
  assert.strictEqual((await visit('/api/holdings', { method: 'POST', body: {} })).status, 401);
  assert.strictEqual((await visit('/')).status, 200);
  assert.strictEqual((await visit('/login.html')).status, 200);
  assert.deepStrictEqual((await visit('/api/auth/me')).body, { user: null });
});

test('signing up sets an HttpOnly session cookie and opens the portfolio', async () => {
  const visit = browser();
  const signup = await visit('/api/auth/register', { method: 'POST', body: { username: 'dave', password: 'correct horse' } });
  assert.strictEqual(signup.status, 201);
  assert.match(signup.headers.get('set-cookie'), /^folio_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800$/);
  assert.deepStrictEqual((await visit('/api/auth/me')).body, { user: { username: 'dave' } });
  assert.strictEqual((await visit('/portfolio.html')).status, 200);
  assert.strictEqual((await visit('/api/portfolio')).status, 200);
});

test('each logged-in browser sees only its own holdings', async () => {
  const anna = browser();
  const ben = browser();
  await anna('/api/auth/register', { method: 'POST', body: { username: 'anna', password: 'correct horse' } });
  await ben('/api/auth/register', { method: 'POST', body: { username: 'ben', password: 'correct horse' } });
  const added = await anna('/api/holdings', { method: 'POST', body: { ticker: 'AAPL', shares: '1', purchasePrice: '100', purchaseDate: '2024-01-15' } });
  assert.strictEqual(added.status, 201);
  assert.deepStrictEqual((await anna('/api/portfolio')).body.rows.map((r) => r.ticker), ['AAPL']);
  assert.deepStrictEqual((await ben('/api/portfolio')).body.rows, []);

  const id = added.body.rows[0].holdings[0].id;
  assert.strictEqual((await ben(`/api/holdings/${id}`, { method: 'DELETE' })).status, 404);
  assert.strictEqual((await anna('/api/portfolio')).body.rows.length, 1);
});

test('logging in and out', async () => {
  const visit = browser();
  await visit('/api/auth/register', { method: 'POST', body: { username: 'carla', password: 'correct horse' } });
  await visit('/api/auth/logout', { method: 'POST' });
  assert.strictEqual((await visit('/api/portfolio')).status, 401);

  const wrong = await visit('/api/auth/login', { method: 'POST', body: { username: 'carla', password: 'wrong horse' } });
  assert.deepStrictEqual([wrong.status, wrong.body.error], [401, 'Incorrect username or password.']);
  const right = await visit('/api/auth/login', { method: 'POST', body: { username: 'carla', password: 'correct horse' } });
  assert.strictEqual(right.status, 200);
  assert.strictEqual((await visit('/api/portfolio')).status, 200);
});

test('sign-up errors come back per field', async () => {
  const visit = browser();
  const res = await visit('/api/auth/register', { method: 'POST', body: { username: 'x', password: 'y' } });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.errors.username && res.body.errors.password);
  assert.strictEqual(res.headers.get('set-cookie'), null);
});
