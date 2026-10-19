const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const service = require('../src/service.js');

// Stands in for fetch. routes: (url) -> JSON body, or an Error to fail the request.
// Records every URL requested.
function fakeFetch(routes) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const body = routes(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.urls = urls;
  return fn;
}

const yahoo = (price) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: 1760000000 } }] } });
const finnhub = (price) => ({ c: price, t: 1760000000 });
const isYahoo = (url) => url.includes('yahoo');

beforeEach(() => {
  data.closeDb();
  prices.clearCacheForTests();
  delete process.env.FINNHUB_API_KEY;
});

// ---- Price client ----

test('reads the price from Yahoo with no key', async () => {
  prices.setFetchForTests(fakeFetch((url) => (url.includes('/AAPL') ? yahoo(231.5) : new Error('?'))));
  const quotes = await prices.getQuotes(['aapl']);
  assert.deepStrictEqual(quotes.get('AAPL'), { price: 231.5, asOf: new Date(1760000000 * 1000).toISOString(), source: 'yahoo' });
});

test('never calls Finnhub without a key', async () => {
  const fetch = fakeFetch(() => new Error('down'));
  prices.setFetchForTests(fetch);
  const quotes = await prices.getQuotes(['AAPL']);
  assert.strictEqual(quotes.size, 0);
  assert.ok(fetch.urls.every(isYahoo));
});

test('falls back to Finnhub when Yahoo fails and a key is set', async () => {
  process.env.FINNHUB_API_KEY = 'test-key';
  prices.setFetchForTests(fakeFetch((url) => (isYahoo(url) ? new Error('down') : finnhub(99.25))));
  const quotes = await prices.getQuotes(['MSFT']);
  assert.strictEqual(quotes.get('MSFT').price, 99.25);
  assert.strictEqual(quotes.get('MSFT').source, 'finnhub');
});

test('Finnhub price 0 means unknown ticker, so it is left out', async () => {
  process.env.FINNHUB_API_KEY = 'test-key';
  prices.setFetchForTests(fakeFetch((url) => (isYahoo(url) ? new Error('down') : finnhub(0))));
  assert.strictEqual((await prices.getQuotes(['NOPE'])).size, 0);
});

test('uses the cache within a minute, unless fresh is asked for', async () => {
  const fetch = fakeFetch(() => yahoo(10));
  prices.setFetchForTests(fetch);
  await prices.getQuotes(['AAPL']);
  await prices.getQuotes(['AAPL']);
  assert.strictEqual(fetch.urls.length, 1);
  await prices.getQuotes(['AAPL'], { fresh: true });
  assert.strictEqual(fetch.urls.length, 2);
});

test('keeps the last known price when a refresh fails', async () => {
  prices.setFetchForTests(fakeFetch(() => yahoo(10)));
  await prices.getQuotes(['AAPL']);
  prices.setFetchForTests(fakeFetch(() => new Error('down')));
  assert.strictEqual((await prices.getQuotes(['AAPL'], { fresh: true })).get('AAPL').price, 10);
});

// ---- Service: live prices in the portfolio ----

const valid = { ticker: 'AAPL', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' };

function syncedVti(brokeragePrice) {
  data.replaceBrokerageData('local', [{ id: 'a1', name: 'Brokerage', institution: 'X' }],
    [{ accountId: 'a1', ticker: 'VTI', shares: 2, averagePrice: 200, price: brokeragePrice }], []);
}

test('a manual holding gets a value from the live price', async () => {
  prices.setFetchForTests(fakeFetch(() => yahoo(200)));
  service.addHolding(valid);
  await service.refreshPrices();
  const { rows, summary, pricesAsOf } = service.getPortfolio();
  assert.strictEqual(rows[0].currentPrice, 200);
  assert.strictEqual(rows[0].value, 2000);
  assert.strictEqual(summary.gainLoss, 500);
  assert.strictEqual(summary.unpricedCount, 0);
  assert.strictEqual(pricesAsOf, new Date(1760000000 * 1000).toISOString());
});

test('a live price beats the brokerage price for a synced holding', async () => {
  prices.setFetchForTests(fakeFetch(() => yahoo(250)));
  syncedVti(220);
  await service.refreshPrices();
  assert.strictEqual(service.getPortfolio().rows[0].currentPrice, 250);
});

test('with no live price, a synced holding keeps the brokerage price and a manual one has none', async () => {
  prices.setFetchForTests(fakeFetch(() => new Error('offline')));
  syncedVti(220);
  service.addHolding(valid);
  await service.refreshPrices();
  const { rows, summary, pricesAsOf } = service.getPortfolio();
  assert.strictEqual(rows.find((r) => r.ticker === 'VTI').currentPrice, 220);
  assert.strictEqual(rows.find((r) => r.ticker === 'AAPL').currentPrice, null);
  assert.strictEqual(summary.unpricedCount, 1);
  assert.strictEqual(pricesAsOf, null);
});
