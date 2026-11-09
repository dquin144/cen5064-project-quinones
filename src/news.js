// Data tier (external API client): the only file that fetches news.
// Sources are tried in the order listed in PROVIDERS: Finnhub company news when
// FINNHUB_API_KEY is set (the same free key as the backup price source), then Yahoo
// Finance search, which needs no key. News is cached for 15 minutes per ticker, so
// page reloads and polling don't hit rate limits.
//
// Articles come back in Folio's shape:
//   { id, headline, summary, url, source, publishedAt (ISO), tickers: [UPPERCASE] }
// Deciding which articles matter is the Domain tier's job (insights.matchNewsToHoldings).

const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 5000;
const LOOKBACK_DAYS = 7;
const MAX_PER_TICKER = 30; // Finnhub can return hundreds a week for big names

let fetchImpl = (...args) => fetch(...args);
let finnhubApiKey = null;
const cache = new Map(); // ticker -> { articles, fetchedAt }

// Called once at startup (service.configure) or by a test.
function configure(config) {
  finnhubApiKey = config.finnhubApiKey;
}

function setFetchForTests(fake) {
  fetchImpl = fake;
}

function clearCacheForTests() {
  cache.clear();
}

async function getJson(url) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoFromSeconds = (s) => (s > 0 ? new Date(s * 1000).toISOString() : null);
const tickerList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(','))
  .map((t) => String(t).trim().toUpperCase())
  .filter(Boolean);

async function fromFinnhub(ticker) {
  const now = Date.now();
  const body = await getJson('https://finnhub.io/api/v1/company-news'
    + `?symbol=${encodeURIComponent(ticker)}&from=${isoDay(now - LOOKBACK_DAYS * 86400000)}&to=${isoDay(now)}`
    + `&token=${encodeURIComponent(finnhubApiKey)}`);
  if (!Array.isArray(body)) throw new Error(body?.error || 'unexpected response');
  return body.map((a) => ({
    id: `finnhub:${a.id}`,
    headline: a.headline,
    summary: a.summary || '',
    url: a.url,
    source: a.source || null,
    publishedAt: isoFromSeconds(a.datetime),
    tickers: [...new Set([ticker, ...tickerList(a.related)])],
  }));
}

async function fromYahoo(ticker) {
  const body = await getJson('https://query1.finance.yahoo.com/v1/finance/search'
    + `?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=10`);
  if (!Array.isArray(body?.news)) throw new Error('unexpected response');
  return body.news.map((a) => ({
    id: `yahoo:${a.uuid}`,
    headline: a.title,
    summary: '',
    url: a.link,
    source: a.publisher || null,
    publishedAt: isoFromSeconds(a.providerPublishTime),
    tickers: [...new Set([ticker, ...tickerList(a.relatedTickers)])],
  }));
}

// News sources, tried in order. Each one says when it can be used, so adding,
// removing, or reordering a source means editing this list, not fetchNewsFor.
const PROVIDERS = [
  { name: 'finnhub', isEnabled: () => Boolean(finnhubApiKey), fetch: fromFinnhub },
  { name: 'yahoo', isEnabled: () => true, fetch: fromYahoo },
];

// The first non-empty list an enabled provider gives (Finnhub has no news for most
// funds, Yahoo does), newest first. Empty everywhere is a valid answer; throws only
// when every provider failed.
async function fetchNewsFor(ticker) {
  let lastErr = null;
  let answered = false;
  for (const provider of PROVIDERS.filter((p) => p.isEnabled())) {
    try {
      const articles = (await provider.fetch(ticker)).filter((a) => a.headline && a.url && a.publishedAt);
      answered = true;
      if (articles.length > 0) {
        return articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, MAX_PER_TICKER);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (answered) return [];
  throw lastErr ?? new Error('no news source configured');
}

// Returns { articles, failed }: every article found for the tickers (the same story
// may appear under several tickers), and the tickers no source could answer for.
// A ticker that fails keeps its last cached news if there is one. This never throws.
// fresh: true ignores the cache.
async function fetchNews(tickers, { fresh = false } = {}) {
  const now = Date.now();
  const articles = [];
  const failed = [];
  const toFetch = [];
  for (const ticker of new Set(tickers.map((t) => t.toUpperCase()))) {
    const hit = cache.get(ticker);
    if (!fresh && hit && now - hit.fetchedAt < CACHE_MS) articles.push(...hit.articles);
    else toFetch.push(ticker);
  }

  const results = await Promise.allSettled(toFetch.map(fetchNewsFor));
  results.forEach((r, i) => {
    const ticker = toFetch[i];
    if (r.status === 'fulfilled') {
      cache.set(ticker, { articles: r.value, fetchedAt: now });
      articles.push(...r.value);
    } else if (cache.has(ticker)) {
      articles.push(...cache.get(ticker).articles); // keep showing the last news we had
    } else {
      console.warn(`No news for ${ticker}: ${r.reason?.message}`);
      failed.push(ticker);
    }
  });

  return { articles, failed };
}

module.exports = { configure, fetchNews, setFetchForTests, clearCacheForTests };
