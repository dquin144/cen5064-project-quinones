// The "Value over time" chart: daily price history (prices.getHistory), the value
// and invested amount per day (domain.buildValueHistory), and the service that
// joins them for one user (service.getValueHistory).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const service = require('../src/service.js');
const { buildValueHistory, consolidateHoldings } = require('../src/domain.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

beforeEach(() => {
  data.closeDb();
  prices.clearCacheForTests();
});

// ---- Domain: value per day ----

const closes = (pairs) => pairs.map(([date, close]) => ({ date, close }));
const manual = (ticker, shares, purchasePrice, purchaseDate) => ({ ticker, shares, purchasePrice, purchaseDate, kind: 'manual' });

test('counts each purchase from its date on, in both value and invested', () => {
  const rows = consolidateHoldings([
    manual('AAPL', 10, 100, '2026-01-01'),
    manual('AAPL', 5, 120, '2026-01-06'),
  ]);
  const history = new Map([['AAPL', closes([['2026-01-05', 110], ['2026-01-06', 120], ['2026-01-07', 130]])]]);
  const { points, missing } = buildValueHistory(rows, history);
  assert.deepStrictEqual(points, [
    { date: '2026-01-05', value: 1100, invested: 1000 },
    { date: '2026-01-06', value: 1800, invested: 1600 },
    { date: '2026-01-07', value: 1950, invested: 1600 },
  ]);
  assert.deepStrictEqual(missing, []);
});

test('drops the days before anything was owned', () => {
  const rows = consolidateHoldings([manual('MSFT', 2, 400, '2026-03-03')]);
  const history = new Map([['MSFT', closes([['2026-03-02', 390], ['2026-03-03', 410], ['2026-03-04', 420]])]]);
  assert.deepStrictEqual(buildValueHistory(rows, history).points.map((p) => p.date), ['2026-03-03', '2026-03-04']);
});

const synced = (ticker, shares, averagePrice, accountId = 'acc-1') =>
  ({ ticker, shares, purchasePrice: averagePrice, purchaseDate: null, kind: 'synced', accountId });
const brokerageBuy = (ticker, shares, purchaseDate, accountId = 'acc-1') =>
  ({ ticker, shares, purchasePrice: 1, purchaseDate, accountId });

test('a synced position with no buy history counts on every day, and is reported as undated', () => {
  const rows = consolidateHoldings([synced('VTI', 3, 200)]);
  const history = new Map([['VTI', closes([['2026-02-02', 210], ['2026-02-03', 215]])]]);
  const { points, undated } = buildValueHistory(rows, history);
  assert.deepStrictEqual(points, [
    { date: '2026-02-02', value: 630, invested: 600 },
    { date: '2026-02-03', value: 645, invested: 600 },
  ]);
  assert.deepStrictEqual(undated, ['VTI']);
});

test('a synced position bought last month is not shown as owned before then', () => {
  // The peer-review case: NVDA bought through the brokerage on Oct 15, on a chart
  // that starts long before.
  const rows = consolidateHoldings([synced('NVDA', 10, 180)]);
  const buys = [brokerageBuy('NVDA', 10, '2026-10-15')];
  const history = new Map([['NVDA', closes([['2021-11-19', 30], ['2026-10-14', 175], ['2026-10-15', 180], ['2026-11-19', 190]])]]);
  const { points, undated } = buildValueHistory(rows, history, { buys });
  assert.deepStrictEqual(points, [
    { date: '2026-10-15', value: 1800, invested: 1800 },
    { date: '2026-11-19', value: 1900, invested: 1800 },
  ]);
  assert.deepStrictEqual(undated, []);
});

test('synced shares are dated newest buys first; shares the history does not cover count throughout', () => {
  // Holds 8 now. Buys: 5 (Jan), 4 (Mar), 2 (May) = 11, so 3 were sold. Taking the
  // oldest as sold leaves May's 2, March's 4 and 2 of January's.
  const rows = consolidateHoldings([synced('VOO', 8, 500)]);
  const buys = [brokerageBuy('VOO', 5, '2026-01-10'), brokerageBuy('VOO', 4, '2026-03-10'), brokerageBuy('VOO', 2, '2026-05-10')];
  const history = new Map([['VOO', closes([['2026-01-10', 1], ['2026-03-10', 1], ['2026-05-10', 1]])]]);
  assert.deepStrictEqual(buildValueHistory(rows, history, { buys }).points.map((p) => [p.date, p.value]),
    [['2026-01-10', 2], ['2026-03-10', 6], ['2026-05-10', 8]]);

  // Holds 10 but the history only shows 4 bought: the other 6 count from the start.
  const more = consolidateHoldings([synced('VOO', 10, 500)]);
  const partial = buildValueHistory(more, history, { buys: [brokerageBuy('VOO', 4, '2026-03-10')] });
  assert.deepStrictEqual(partial.points.map((p) => [p.date, p.value]), [['2026-01-10', 6], ['2026-03-10', 10], ['2026-05-10', 10]]);
  assert.deepStrictEqual(partial.undated, ['VOO']);
});

test("one account's buys don't date another account's shares", () => {
  const rows = consolidateHoldings([synced('VTI', 2, 200, 'acc-1'), synced('VTI', 3, 200, 'acc-2')]);
  const buys = [brokerageBuy('VTI', 2, '2026-02-03', 'acc-1')];
  const history = new Map([['VTI', closes([['2026-02-02', 1], ['2026-02-03', 1]])]]);
  const { points, undated } = buildValueHistory(rows, history, { buys });
  assert.deepStrictEqual(points.map((p) => [p.date, p.value]), [['2026-02-02', 3], ['2026-02-03', 5]]);
  assert.deepStrictEqual(undated, ['VTI']);
});

test('dated synced shares keep the average cost, so invested still ends on the cost basis', () => {
  const rows = consolidateHoldings([synced('VOO', 2, 550)]);
  const buys = [{ ...brokerageBuy('VOO', 1, '2026-01-10'), purchasePrice: 520 }, { ...brokerageBuy('VOO', 1, '2026-03-10'), purchasePrice: 580 }];
  const history = new Map([['VOO', closes([['2026-01-10', 600], ['2026-03-10', 600]])]]);
  const { points } = buildValueHistory(rows, history, { buys });
  assert.deepStrictEqual(points.map((p) => p.invested), [550, 1100]);
  assert.strictEqual(points.at(-1).invested, rows[0].costBasis);
});

test('carries a close forward over a day that ticker did not trade', () => {
  const rows = consolidateHoldings([manual('AAA', 1, 10, '2026-01-01'), manual('BBB', 1, 20, '2026-01-01')]);
  const history = new Map([
    ['AAA', closes([['2026-01-05', 11], ['2026-01-06', 12]])],
    ['BBB', closes([['2026-01-05', 21]])], // no close on the 6th
  ]);
  assert.deepStrictEqual(buildValueHistory(rows, history).points.at(-1), { date: '2026-01-06', value: 33, invested: 30 });
});

test('the last day uses the live price, so the chart ends on the summary total', () => {
  const rows = consolidateHoldings([manual('AAPL', 2, 100, '2026-01-01')]);
  const history = new Map([['AAPL', closes([['2026-01-05', 110], ['2026-01-06', 120]])]]);
  const { points } = buildValueHistory(rows, history, { livePrices: new Map([['AAPL', 125.5]]) });
  assert.deepStrictEqual(points.map((p) => p.value), [220, 251]);
});

test('holdings with no history are listed as missing and left out of both lines', () => {
  const rows = consolidateHoldings([manual('AAPL', 1, 100, '2026-01-01'), manual('ZZZZ', 1, 999, '2026-01-01')]);
  const history = new Map([['AAPL', closes([['2026-01-05', 110], ['2026-01-06', 111]])]]);
  const { points, missing } = buildValueHistory(rows, history);
  assert.deepStrictEqual(missing, ['ZZZZ']);
  assert.deepStrictEqual(points[0], { date: '2026-01-05', value: 110, invested: 100 });
});

test('an empty portfolio has no points', () => {
  assert.deepStrictEqual(buildValueHistory([], new Map()), { points: [], missing: [], undated: [] });
});

// ---- Data: Yahoo daily history ----

// Yahoo's chart response: timestamps at market open (New York, UTC-5 here).
const NY = -18000;
const at = (date) => Date.parse(`${date}T14:30:00Z`) / 1000;
const yahooHistory = (pairs) => ({
  chart: {
    result: [{
      meta: { gmtoffset: NY, regularMarketPrice: pairs.at(-1)[1] },
      timestamp: pairs.map(([d]) => at(d)),
      indicators: { quote: [{ close: pairs.map(([, c]) => c) }] },
    }],
  },
});

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

test('reads daily closes from Yahoo, dated in the exchange time zone, skipping gaps', async () => {
  prices.setFetchForTests(fakeFetch(() => yahooHistory([['2026-01-05', 110], ['2026-01-06', null], ['2026-01-07', 112.5]])));
  const history = await prices.getHistory(['aapl'], '1mo');
  assert.deepStrictEqual(history.get('AAPL'), closes([['2026-01-05', 110], ['2026-01-07', 112.5]]));
});

test('asks Yahoo for the chosen range; weekly closes for 5 years; unknown ranges mean 1y', async () => {
  const fetch = fakeFetch(() => yahooHistory([['2026-01-05', 1]]));
  prices.setFetchForTests(fetch);
  await prices.getHistory(['A'], '3mo');
  await prices.getHistory(['B'], '5y');
  await prices.getHistory(['C'], 'forever');
  assert.match(fetch.urls[0], /\/A\?range=3mo&interval=1d$/);
  assert.match(fetch.urls[1], /\/B\?range=5y&interval=1wk$/);
  assert.match(fetch.urls[2], /\/C\?range=1y&interval=1d$/);
});

test('caches history, and keeps the last history when Yahoo later fails', async () => {
  let up = true;
  const fetch = fakeFetch(() => (up ? yahooHistory([['2026-01-05', 50]]) : new Error('down')));
  prices.setFetchForTests(fetch);
  await prices.getHistory(['AAPL'], '1y');
  await prices.getHistory(['AAPL'], '1y');
  assert.strictEqual(fetch.urls.length, 1, 'second call is served from the cache');

  up = false;
  const failing = await prices.getHistory(['MSFT', 'AAPL'], '1y');
  assert.deepStrictEqual([...failing.keys()], ['AAPL'], 'MSFT has no history; AAPL is still there');
});

// ---- Service: one user's value over time ----

test("builds the chart from the user's own holdings only", async () => {
  prices.setFetchForTests(fakeFetch((url) => {
    if (url.includes('range=')) return url.includes('/AAPL') ? yahooHistory([['2026-01-05', 110], ['2026-01-06', 120]]) : new Error('none');
    return new Error('no live quotes in this test');
  }));
  service.addHolding('1', { ticker: 'AAPL', shares: '2', purchasePrice: '100', purchaseDate: '2025-12-01' });
  service.addHolding('2', { ticker: 'MSFT', shares: '9', purchasePrice: '400', purchaseDate: '2025-12-01' });

  const mine = await service.getValueHistory('1', { range: '1mo' });
  assert.deepStrictEqual(mine, {
    range: '1mo',
    points: [{ date: '2026-01-05', value: 220, invested: 200 }, { date: '2026-01-06', value: 240, invested: 200 }],
    missing: [],
    undated: [],
  });
  assert.deepStrictEqual(await service.getValueHistory('3'), { range: '1y', points: [], missing: [], undated: [] });
});

test('synced positions are dated from the stored brokerage buys, and priced without any earlier call', async () => {
  prices.setFetchForTests(fakeFetch((url) => {
    if (url.includes('range=')) return yahooHistory([['2026-01-05', 100], ['2026-01-06', 100], ['2026-01-07', 100]]);
    return { chart: { result: [{ meta: { regularMarketPrice: 110, regularMarketTime: at('2026-01-07') } }] } };
  }));
  data.replaceBrokerageData('1',
    [{ id: 'acc-1', name: 'E*TRADE Individual' }],
    [{ accountId: 'acc-1', ticker: 'NVDA', shares: 4, averagePrice: 100, price: 105 }],
    [{ accountId: 'acc-1', ticker: 'NVDA', shares: 4, price: 100, date: '2026-01-06' }]);

  // Nothing fetched prices first: getValueHistory gets them itself.
  const { points, undated } = await service.getValueHistory('1', { range: '1mo' });
  assert.deepStrictEqual(points, [
    { date: '2026-01-06', value: 400, invested: 400 },
    { date: '2026-01-07', value: 440, invested: 400 },
  ]);
  assert.deepStrictEqual(undated, []);
});
