const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const news = require('../src/news.js');

// Stands in for fetch. routes: (url) -> JSON body, or an Error to fail the request.
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

const isFinnhub = (url) => url.includes('finnhub');
const finnhubArticle = (id, headline, related = 'AAPL', datetime = 1794000000) =>
  ({ category: 'company', datetime, headline, id, related, source: 'Reuters', summary: 'Summary.', url: `https://f.example/${id}` });
const yahooArticle = (uuid, title, relatedTickers = ['AAPL']) =>
  ({ uuid, title, publisher: 'Yahoo', link: `https://y.example/${uuid}`, providerPublishTime: 1794000000, relatedTickers });

beforeEach(() => {
  news.clearCacheForTests();
  news.configure(loadConfig());
});

test('uses Yahoo with no key, and never calls Finnhub', async () => {
  const fetch = fakeFetch(() => ({ news: [yahooArticle('a1', 'Apple ships a phone', ['AAPL', 'MSFT'])] }));
  news.setFetchForTests(fetch);
  const { articles, failed } = await news.fetchNews(['aapl']);
  assert.deepStrictEqual(articles, [{
    id: 'yahoo:a1',
    headline: 'Apple ships a phone',
    summary: '',
    url: 'https://y.example/a1',
    source: 'Yahoo',
    publishedAt: new Date(1794000000 * 1000).toISOString(),
    tickers: ['AAPL', 'MSFT'],
  }]);
  assert.deepStrictEqual(failed, []);
  assert.ok(fetch.urls.every((u) => !isFinnhub(u)));
});

test('uses Finnhub first when a key is set, asking for the last week', async () => {
  news.configure(loadConfig({ FINNHUB_API_KEY: 'test-key' }));
  const fetch = fakeFetch((url) => (isFinnhub(url) ? [finnhubArticle(1, 'Apple beats', 'AAPL,MSFT')] : new Error('should not be called')));
  news.setFetchForTests(fetch);
  const { articles } = await news.fetchNews(['AAPL']);
  assert.strictEqual(articles[0].id, 'finnhub:1');
  assert.strictEqual(articles[0].summary, 'Summary.');
  assert.deepStrictEqual(articles[0].tickers, ['AAPL', 'MSFT']);
  assert.match(fetch.urls[0], /company-news\?symbol=AAPL&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&token=test-key/);
  assert.strictEqual(fetch.urls.length, 1);
});

test('falls back to Yahoo when Finnhub has nothing (e.g. most funds) or fails', async () => {
  news.configure(loadConfig({ FINNHUB_API_KEY: 'test-key' }));
  news.setFetchForTests(fakeFetch((url) => {
    if (!isFinnhub(url)) return { news: [yahooArticle('y1', 'Fund news', ['VOO'])] };
    return url.includes('VOO') ? [] : new Error('HTTP 429');
  }));
  const { articles, failed } = await news.fetchNews(['VOO', 'AAPL']);
  assert.deepStrictEqual(articles.map((a) => a.id), ['yahoo:y1', 'yahoo:y1']);
  assert.deepStrictEqual(failed, []);
});

test('returns newest first, and drops articles missing a headline, link or date', async () => {
  news.configure(loadConfig({ FINNHUB_API_KEY: 'test-key' }));
  news.setFetchForTests(fakeFetch(() => [
    finnhubArticle(1, 'Older', 'AAPL', 1794000000),
    finnhubArticle(2, 'Newer', 'AAPL', 1794050000),
    finnhubArticle(3, '', 'AAPL'),
    { ...finnhubArticle(4, 'No date'), datetime: 0 },
  ]));
  const { articles } = await news.fetchNews(['AAPL']);
  assert.deepStrictEqual(articles.map((a) => a.headline), ['Newer', 'Older']);
});

test('reports tickers no source could answer for, and never throws', async () => {
  news.setFetchForTests(fakeFetch(() => new Error('down')));
  assert.deepStrictEqual(await news.fetchNews(['AAPL']), { articles: [], failed: ['AAPL'] });
});

test('an empty answer is not a failure', async () => {
  news.setFetchForTests(fakeFetch(() => ({ news: [] })));
  assert.deepStrictEqual(await news.fetchNews(['AAPL']), { articles: [], failed: [] });
});

test('uses the cache, unless fresh is asked for, and keeps old news when a refresh fails', async () => {
  const fetch = fakeFetch(() => ({ news: [yahooArticle('a1', 'Apple ships a phone')] }));
  news.setFetchForTests(fetch);
  await news.fetchNews(['AAPL']);
  await news.fetchNews(['AAPL']);
  assert.strictEqual(fetch.urls.length, 1);

  news.setFetchForTests(fakeFetch(() => new Error('down')));
  const { articles, failed } = await news.fetchNews(['AAPL'], { fresh: true });
  assert.strictEqual(articles.length, 1);
  assert.deepStrictEqual(failed, []);
});
