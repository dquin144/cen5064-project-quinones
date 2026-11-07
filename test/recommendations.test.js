// UC4 end to end through the Service tier: holdings -> prices -> news -> recommendations.
// Network calls are faked; everything else is the real code.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const news = require('../src/news.js');
const service = require('../src/service.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

const NOW = Date.now();
const secondsAgo = (hours) => Math.floor((NOW - hours * 3600000) / 1000);

const chart = (price, longName, instrumentType = 'EQUITY') =>
  ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: secondsAgo(0), longName, instrumentType } }] } });
const search = (...items) => ({ news: items });
const story = (uuid, title, ticker, hours = 3) =>
  ({ uuid, title, publisher: 'Reuters', link: `https://news.example/${uuid}`, providerPublishTime: secondsAgo(hours), relatedTickers: [ticker] });

// Yahoo only (no Finnhub key): chart URLs give prices, search URLs give news.
function fakeYahoo({ quotes, newsFor = () => search(), newsDown = false }) {
  return async (url) => {
    const ticker = decodeURIComponent(url.match(/chart\/([^?]+)|[?&]q=([^&]+)/).slice(1).find(Boolean));
    if (url.includes('/search')) {
      if (newsDown) throw new Error('down');
      return { ok: true, status: 200, json: async () => newsFor(ticker) };
    }
    return { ok: true, status: 200, json: async () => quotes[ticker] };
  };
}

async function setUp(fetch) {
  prices.setFetchForTests(fetch);
  news.setFetchForTests(fetch);
  await service.refreshPrices();
}

beforeEach(() => {
  data.closeDb();
  prices.clearCacheForTests();
  news.clearCacheForTests();
  service.configure(loadConfig({ DB_FILE: ':memory:' }));
});

const add = (ticker, shares, purchasePrice) =>
  service.addHolding({ ticker, shares: String(shares), purchasePrice: String(purchasePrice), purchaseDate: '2024-01-15' });

test('an empty portfolio has no score, no recommendations and fetches no news', async () => {
  let calls = 0;
  await setUp(async () => { calls += 1; throw new Error('should not be called'); });
  assert.deepStrictEqual(await service.getRecommendations(), { score: null, insights: [], news: [], newsIssue: null });
  assert.strictEqual(calls, 0);
});

test('the portfolio view includes the diversification score', async () => {
  add('VOO', 2, 400);
  await setUp(fakeYahoo({ quotes: { VOO: chart(500, 'Vanguard S&P 500 ETF', 'ETF') } }));
  const { score } = service.getPortfolio();
  assert.strictEqual(score.diversificationScore, 100);
  assert.strictEqual(score.riskLabel, 'Low');
});

test('recommends based on holdings and the news about them', async () => {
  add('TSLA', 10, 300); // bought at 300, now 200: down 33%
  add('VOO', 1, 400);
  await setUp(fakeYahoo({
    quotes: { TSLA: chart(200, 'Tesla, Inc.'), VOO: chart(500, 'Vanguard S&P 500 ETF', 'ETF') },
    newsFor: (ticker) => (ticker === 'TSLA'
      ? search(
        story('t1', 'Tesla shares plunge after recall', 'TSLA'),
        story('t2', 'Tesla deliveries miss estimates', 'TSLA', 20),
        story('t3', 'Tesla to hold investor day', 'TSLA', 30),
        story('t4', 'Booking vs. DoorDash: which to buy?', 'TSLA'))
      : search(story('v1', 'Index funds see record inflows', 'VOO'))),
  }));

  const { score, insights, news: shown, newsIssue } = await service.getRecommendations({ now: NOW });
  const ids = insights.map((i) => i.id);
  assert.strictEqual(newsIssue, null);
  assert.ok(score.concentrationWarning); // TSLA is 2000 of 2500
  assert.ok(ids.includes('concentration:TSLA'));
  assert.ok(ids.includes('loss:TSLA'));
  assert.ok(ids.includes('news-negative:TSLA'));
  // The loosely tagged story is gone; the fund's tagged news stays.
  assert.deepStrictEqual(shown.map((n) => n.url).sort(),
    ['https://news.example/t1', 'https://news.example/t2', 'https://news.example/t3', 'https://news.example/v1']);
  assert.strictEqual(shown.find((n) => n.url.endsWith('t1')).sentiment, 'negative');
});

test('when news is down, holding-based recommendations still come back', async () => {
  add('AAPL', 10, 100);
  await setUp(fakeYahoo({ quotes: { AAPL: chart(150, 'Apple Inc.') }, newsDown: true }));
  const { insights, news: shown, newsIssue } = await service.getRecommendations();
  assert.ok(insights.some((i) => i.id === 'low-diversification'));
  assert.deepStrictEqual(shown, []);
  assert.match(newsIssue, /Couldn't load news/);
});
