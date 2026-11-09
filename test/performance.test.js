const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const service = require('../src/service.js');
const { consolidateHoldings, allocatePortfolio } = require('../src/domain.js');

const lot = (ticker, shares, purchasePrice, currentPrice = null) =>
  ({ ticker, shares, purchasePrice, purchaseDate: '2024-01-15', currentPrice });

// ---- Gain/loss per holding ----

test('each holding shows its gain/loss since purchase, in dollars and percent', () => {
  const [aapl, msft] = consolidateHoldings([lot('AAPL', 10, 100, 150), lot('MSFT', 2, 300, 240)]);
  assert.deepStrictEqual([aapl.gainLoss, aapl.gainLossPercent], [500, 50]);
  assert.deepStrictEqual([msft.gainLoss, msft.gainLossPercent], [-120, -20]);
});

test('gain/loss covers every purchase of the ticker', () => {
  const [row] = consolidateHoldings([lot('AAPL', 10, 100, 150), lot('AAPL', 10, 200, 150)]);
  assert.strictEqual(row.gainLoss, 0);
  assert.strictEqual(row.gainLossPercent, 0);
});

test('a holding with no market price has no gain/loss', () => {
  const [row] = consolidateHoldings([lot('ZZZQX', 5, 10)]);
  assert.deepStrictEqual([row.gainLoss, row.gainLossPercent], [null, null]);
});

// ---- Allocation ----

test('allocation gives each ticker its share of total value, largest first', () => {
  const rows = consolidateHoldings([lot('MSFT', 1, 100, 250), lot('AAPL', 3, 100, 250), lot('AAPL', 1, 100, 250)]);
  assert.deepStrictEqual(allocatePortfolio(rows), [
    { label: 'AAPL', value: 1000, percent: 80 },
    { label: 'MSFT', value: 250, percent: 20 },
  ]);
});

test('allocation leaves out holdings without a price', () => {
  const rows = consolidateHoldings([lot('AAPL', 1, 100, 100), lot('ZZZQX', 5, 10)]);
  assert.deepStrictEqual(allocatePortfolio(rows).map((p) => [p.label, p.percent]), [['AAPL', 100]]);
});

test('an empty or unpriced portfolio has no allocation', () => {
  assert.deepStrictEqual(allocatePortfolio([]), []);
  assert.deepStrictEqual(allocatePortfolio(consolidateHoldings([lot('ZZZQX', 5, 10)])), []);
});

test('past the limit, the smallest holdings are folded into "Other"', () => {
  const tickers = ['A', 'B', 'C', 'D', 'E'];
  const rows = consolidateHoldings(tickers.map((t, i) => lot(t, 1, 1, 50 - i * 10))); // 50, 40, 30, 20, 10
  const parts = allocatePortfolio(rows, 3);
  assert.deepStrictEqual(parts.map((p) => [p.label, p.value, p.count]), [['A', 50, undefined], ['B', 40, undefined], ['Other', 60, 3]]);
  assert.strictEqual(parts.reduce((sum, p) => sum + p.percent, 0), 100);
});

// ---- Values follow price refreshes ----

beforeEach(() => {
  data.closeDb();
  prices.clearCacheForTests();
  delete process.env.FINNHUB_API_KEY;
});

const yahoo = (price) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: 1760000000 } }] } });
const fakeFetch = (priceFor) => async (url) =>
  ({ ok: true, status: 200, json: async () => yahoo(priceFor(url.includes('AAPL') ? 'AAPL' : 'MSFT')) });

test('gain/loss and allocation update when prices are refreshed', async () => {
  service.addHolding({ ticker: 'AAPL', shares: '10', purchasePrice: '100', purchaseDate: '2024-01-15' });
  service.addHolding({ ticker: 'MSFT', shares: '10', purchasePrice: '100', purchaseDate: '2024-01-15' });

  prices.setFetchForTests(fakeFetch(() => 100));
  await service.refreshPrices();
  let portfolio = service.getPortfolio();
  assert.deepStrictEqual(portfolio.rows.map((r) => r.gainLoss), [0, 0]);
  assert.deepStrictEqual(portfolio.allocation.map((p) => [p.label, p.percent]), [['AAPL', 50], ['MSFT', 50]]);

  prices.setFetchForTests(fakeFetch((t) => (t === 'AAPL' ? 300 : 100)));
  await service.refreshPrices({ fresh: true });
  portfolio = service.getPortfolio();
  assert.deepStrictEqual(portfolio.rows.map((r) => [r.ticker, r.gainLoss, r.gainLossPercent]), [['AAPL', 2000, 200], ['MSFT', 0, 0]]);
  assert.deepStrictEqual(portfolio.allocation.map((p) => [p.label, p.percent]), [['AAPL', 75], ['MSFT', 25]]);
  assert.strictEqual(portfolio.summary.gainLossPercent, 100);
});
