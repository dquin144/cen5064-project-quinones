// Data tier (external API client): the only file that fetches market prices.
// Yahoo Finance first (no key needed); tickers Yahoo can't price are retried on
// Finnhub when FINNHUB_API_KEY is set. Quotes are cached briefly so page polling
// and repeated loads don't hit rate limits.

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 5000;

let fetchImpl = (...args) => fetch(...args);
const cache = new Map(); // ticker -> { price, asOf, source, fetchedAt }

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

// asOf is an ISO timestamp of the quote itself (falls back to now if the API omits it).
const isoFromSeconds = (s) => new Date(s > 0 ? s * 1000 : Date.now()).toISOString();

async function fromYahoo(ticker) {
  const body = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  const meta = body.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!(price > 0)) throw new Error('no price');
  return { price, asOf: isoFromSeconds(meta.regularMarketTime), source: 'yahoo' };
}

// Finnhub returns c = 0 for symbols it doesn't know.
async function fromFinnhub(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  const body = await getJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`);
  const price = Number(body.c);
  if (!(price > 0)) throw new Error('no price');
  return { price, asOf: isoFromSeconds(body.t), source: 'finnhub' };
}

async function fetchQuote(ticker) {
  try {
    return await fromYahoo(ticker);
  } catch (yahooErr) {
    if (!process.env.FINNHUB_API_KEY) throw yahooErr;
    return fromFinnhub(ticker);
  }
}

// Returns Map<ticker, { price, asOf, source }> for the tickers that could be priced.
// A ticker that fails everywhere keeps its last cached quote if there is one;
// otherwise it is logged and left out. This never throws.
// fresh: true ignores the cache (the "Refresh prices" button).
async function getQuotes(tickers, { fresh = false } = {}) {
  const now = Date.now();
  const quotes = new Map();
  const toFetch = [];
  for (const ticker of new Set(tickers.map((t) => t.toUpperCase()))) {
    const hit = cache.get(ticker);
    if (!fresh && hit && now - hit.fetchedAt < CACHE_MS) quotes.set(ticker, hit);
    else toFetch.push(ticker);
  }

  const results = await Promise.allSettled(toFetch.map(fetchQuote));
  results.forEach((r, i) => {
    const ticker = toFetch[i];
    if (r.status === 'fulfilled') {
      const quote = { ...r.value, fetchedAt: now };
      cache.set(ticker, quote);
      quotes.set(ticker, quote);
    } else if (cache.has(ticker)) {
      quotes.set(ticker, cache.get(ticker)); // keep showing the last known price
    } else {
      console.warn(`No live price for ${ticker}: ${r.reason?.message}`);
    }
  });

  return new Map([...quotes].map(([t, { price, asOf, source }]) => [t, { price, asOf, source }]));
}

module.exports = { getQuotes, setFetchForTests, clearCacheForTests };
