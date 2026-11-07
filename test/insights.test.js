const { test } = require('node:test');
const assert = require('node:assert');

const { consolidateHoldings, summarizePortfolio } = require('../src/domain.js');
const {
  scorePortfolio,
  headlineSentiment,
  companyKeywords,
  identifyRelevantTopics,
  matchNewsToHoldings,
  topNews,
  generateInsights,
} = require('../src/insights.js');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

const lot = (ticker, shares, purchasePrice, currentPrice) =>
  ({ ticker, shares, purchasePrice, purchaseDate: '2024-01-15', currentPrice });
// One share per ticker, priced at the given value; bought at that value unless cost says otherwise.
const rowsWorth = (values, cost = null) =>
  consolidateHoldings(Object.entries(values).map(([t, v]) => lot(t, 1, cost?.[t] ?? v, v)));

const stock = (name) => ({ name, assetType: 'EQUITY' });
const fund = (name) => ({ name, assetType: 'ETF' });

// ---- Diversification score ----

test('nothing priced means nothing to score', () => {
  assert.strictEqual(scorePortfolio([]), null);
  assert.strictEqual(scorePortfolio(consolidateHoldings([lot('ZZZQX', 5, 10, null)])), null);
});

test('everything in one stock scores 0 with high concentration risk', () => {
  const score = scorePortfolio(rowsWorth({ AAPL: 1000 }));
  assert.deepStrictEqual(score, {
    diversificationScore: 0,
    effectiveHoldings: 1,
    largestStock: { ticker: 'AAPL', percent: 100 },
    concentratedStocks: [{ ticker: 'AAPL', percent: 100 }],
    concentrationWarning: true,
    riskLabel: 'High',
  });
});

test('ten equal stocks score 100 with low risk', () => {
  const values = Object.fromEntries('ABCDEFGHIJ'.split('').map((t) => [`${t}${t}${t}`, 100]));
  const score = scorePortfolio(rowsWorth(values));
  assert.strictEqual(score.diversificationScore, 100);
  assert.strictEqual(score.effectiveHoldings, 10);
  assert.strictEqual(score.concentrationWarning, false);
  assert.strictEqual(score.riskLabel, 'Low');
});

test('a broad fund counts as many holdings, and is never a concentration warning', () => {
  const rows = rowsWorth({ VOO: 1000 });
  const score = scorePortfolio(rows, new Map([['VOO', fund('Vanguard S&P 500 ETF')]]));
  assert.strictEqual(score.diversificationScore, 100);
  assert.strictEqual(score.largestStock, null);
  assert.strictEqual(score.riskLabel, 'Low');
});

test('one big stock next to a fund is moderate risk with a concentration warning', () => {
  const rows = rowsWorth({ VOO: 700, NVDA: 300 });
  const score = scorePortfolio(rows, new Map([['VOO', fund('Vanguard S&P 500 ETF')]]));
  assert.strictEqual(score.largestStock.ticker, 'NVDA');
  assert.strictEqual(score.concentrationWarning, true);
  assert.strictEqual(score.riskLabel, 'Moderate');
});

test('unpriced holdings are left out of the score', () => {
  const rows = consolidateHoldings([lot('AAPL', 1, 100, 100), lot('MSFT', 1, 100, 100), lot('ZZZQX', 1, 10, null)]);
  assert.strictEqual(scorePortfolio(rows).effectiveHoldings, 2);
});

// ---- Sentiment ----

test('headline sentiment reads the obvious cases', () => {
  assert.strictEqual(headlineSentiment('Apple beats estimates as iPhone sales surge'), 'positive');
  assert.strictEqual(headlineSentiment('Tesla shares plunge after recall and weak deliveries'), 'negative');
  assert.strictEqual(headlineSentiment('Microsoft to hold annual shareholder meeting'), 'neutral');
  assert.strictEqual(headlineSentiment('Stock jumps, then falls'), 'neutral');
  assert.strictEqual(headlineSentiment('Nvidia Is Worth $1.3 Trillion Less After Its 5th Straight Losing Week'), 'negative');
  assert.strictEqual(headlineSentiment('After the Chip Sell-Off, I\'d Buy This'), 'negative');
  assert.strictEqual(headlineSentiment(undefined), 'neutral');
});

// ---- Matching news to holdings ----

test('company keywords drop legal suffixes and keep a distinctive first word', () => {
  assert.deepStrictEqual(companyKeywords('Apple Inc.'), ['Apple']);
  assert.deepStrictEqual(companyKeywords('Meta Platforms, Inc.'), ['Meta Platforms', 'Meta']);
  assert.deepStrictEqual(companyKeywords('Amazon.com, Inc.'), ['Amazon']);
  assert.deepStrictEqual(companyKeywords('General Motors Company'), ['General Motors']);
  assert.deepStrictEqual(companyKeywords(null), []);
});

test('topics are the largest holdings first, capped, with their share and keywords', () => {
  const rows = rowsWorth({ MSFT: 100, AAPL: 300, NVDA: 600 });
  const topics = identifyRelevantTopics(rows, new Map([['AAPL', stock('Apple Inc.')]]), 2);
  assert.deepStrictEqual(topics, [
    { ticker: 'NVDA', keywords: [], percent: 60, fund: false },
    { ticker: 'AAPL', keywords: ['Apple'], percent: 30, fund: false },
  ]);
});

const article = (over) => ({
  id: over.url, summary: '', source: 'Reuters', publishedAt: hoursAgo(2), tickers: [], ...over,
});

test('keeps news that names a holding and drops loosely tagged stories', () => {
  const topics = identifyRelevantTopics(rowsWorth({ AAPL: 100 }), new Map([['AAPL', stock('Apple Inc.')]]));
  const matches = matchNewsToHoldings([
    article({ url: 'u1', headline: 'Apple unveils new MacBook', tickers: ['AAPL'] }),
    article({ url: 'u2', headline: 'Booking vs. DoorDash: which is the better buy?', tickers: ['AAPL'] }),
    article({ url: 'u3', headline: 'Is AAPL still a buy?', tickers: [] }),
    article({ url: 'u4', headline: 'Ford recalls trucks', tickers: ['F'] }),
  ], topics, NOW);
  assert.deepStrictEqual(matches.map((m) => m.url).sort(), ['u1', 'u3']);
  assert.deepStrictEqual(matches[0].named, ['AAPL']);
});

test('a fund keeps its tagged news, since its name rarely appears in headlines', () => {
  const topics = identifyRelevantTopics(rowsWorth({ VOO: 100 }), new Map([['VOO', fund('Vanguard S&P 500 ETF')]]));
  const [m] = matchNewsToHoldings([article({ url: 'u1', headline: 'How far can the AI trade fall?', tickers: ['VOO'] })], topics, NOW);
  assert.deepStrictEqual([m.tickers, m.named], [['VOO'], []]);
});

test('short tickers only match with a $ or in parentheses', () => {
  const topics = identifyRelevantTopics(rowsWorth({ T: 100 }));
  const matches = matchNewsToHoldings([
    article({ url: 'u1', headline: 'T is for trouble' }),
    article({ url: 'u2', headline: 'AT&T (T) raises its dividend' }),
  ], topics, NOW);
  assert.deepStrictEqual(matches.map((m) => m.url), ['u2']);
});

test('the same story under several tickers is listed once, with all of them', () => {
  const profiles = new Map([['AAPL', stock('Apple Inc.')], ['MSFT', stock('Microsoft Corporation')]]);
  const topics = identifyRelevantTopics(rowsWorth({ AAPL: 100, MSFT: 100 }), profiles);
  const story = { url: 'https://news.example/x?ref=1', headline: 'Apple and Microsoft rally' };
  const matches = matchNewsToHoldings([
    article({ ...story, tickers: ['AAPL'] }),
    article({ ...story, url: 'https://news.example/x?ref=2', tickers: ['MSFT'] }),
  ], topics, NOW);
  assert.strictEqual(matches.length, 1);
  assert.deepStrictEqual(matches[0].tickers.sort(), ['AAPL', 'MSFT']);
  assert.strictEqual(matches[0].sentiment, 'positive');
});

test('different stories whose links differ only by query string stay separate (Finnhub links)', () => {
  const topics = identifyRelevantTopics(rowsWorth({ AAPL: 100 }), new Map([['AAPL', stock('Apple Inc.')]]));
  const matches = matchNewsToHoldings([
    article({ url: 'https://finnhub.io/api/news?id=1', headline: 'Apple unveils a phone' }),
    article({ url: 'https://finnhub.io/api/news?id=2', headline: 'Apple unveils a laptop' }),
  ], topics, NOW);
  assert.strictEqual(matches.length, 2);
});

test('sentiment comes from the headline, not the summary', () => {
  const topics = identifyRelevantTopics(rowsWorth({ NVDA: 100 }), new Map([['NVDA', stock('NVIDIA Corporation')]]));
  const [m] = matchNewsToHoldings([article({
    url: 'u1', headline: 'Nvidia reports on Tuesday', summary: 'Chip stocks had one of their best stretches on record.',
  })], topics, NOW);
  assert.strictEqual(m.sentiment, 'neutral');
});

test('ranks headline mentions over summary mentions, recent over old, big holdings over small', () => {
  const profiles = new Map([['AAPL', stock('Apple Inc.')], ['MSFT', stock('Microsoft Corporation')]]);
  const topics = identifyRelevantTopics(rowsWorth({ AAPL: 900, MSFT: 100 }), profiles);
  const matches = matchNewsToHoldings([
    article({ url: 'summary', headline: 'Tech roundup', summary: 'Apple shipped a phone.' }),
    article({ url: 'old', headline: 'Apple shipped a watch', publishedAt: hoursAgo(24 * 6) }),
    article({ url: 'small', headline: 'Microsoft shipped a laptop' }),
    article({ url: 'best', headline: 'Apple shipped a phone' }),
  ], topics, NOW);
  assert.strictEqual(matches[0].url, 'best');
  assert.ok(matches.findIndex((m) => m.url === 'summary') > 0);
  assert.ok(matches.findIndex((m) => m.url === 'best') < matches.findIndex((m) => m.url === 'small'));
  assert.ok(matches.findIndex((m) => m.url === 'best') < matches.findIndex((m) => m.url === 'old'));
});

test('topNews caps how many stories any one holding leads', () => {
  const m = (i, lead) => ({ url: `u${i}`, tickers: [lead] });
  const list = [m(1, 'AAPL'), m(2, 'AAPL'), m(3, 'AAPL'), m(4, 'MSFT')];
  assert.deepStrictEqual(topNews(list, { perTicker: 2 }).map((x) => x.url), ['u1', 'u2', 'u4']);
  assert.strictEqual(topNews(list, { total: 1 }).length, 1);
});

// ---- Recommendations ----

const insightsFor = (rows, { profiles = new Map(), news = [] } = {}) =>
  generateInsights({ rows, summary: summarizePortfolio(rows), score: scorePortfolio(rows, profiles), news, profiles, now: NOW });
const ids = (insights) => insights.map((i) => i.id);

test('an empty portfolio has no recommendations', () => {
  assert.deepStrictEqual(insightsFor([]), []);
});

test('a single stock gets a diversification warning', () => {
  const [first] = insightsFor(rowsWorth({ AAPL: 1000 }));
  assert.strictEqual(first.id, 'low-diversification');
  assert.strictEqual(first.severity, 'warning');
  assert.match(first.title, /0\/100/);
});

test('warns when one stock is over a quarter of the portfolio', () => {
  const rows = rowsWorth({ VOO: 600, NVDA: 400 });
  const insights = insightsFor(rows, { profiles: new Map([['VOO', fund('Vanguard S&P 500 ETF')]]) });
  const concentration = insights.find((i) => i.id === 'concentration:NVDA');
  assert.strictEqual(concentration.title, 'NVDA is 40% of your portfolio');
});

test('warns about every stock over a quarter, not just the largest', () => {
  const insights = insightsFor(rowsWorth({ TSLA: 350, NVDA: 270, AAPL: 170, KO: 210 }));
  assert.deepStrictEqual(ids(insights).filter((id) => id.startsWith('concentration:')), ['concentration:TSLA', 'concentration:NVDA']);
});

test('flags large losses and large gains', () => {
  const values = Object.fromEntries('ABCDEFGHIJ'.split('').map((t) => [`${t}${t}${t}`, 100]));
  const rows = rowsWorth({ ...values, AAA: 150, BBB: 70 }, { AAA: 50, BBB: 100 }); // AAA +200%, BBB -30%
  const insights = insightsFor(rows);
  assert.ok(ids(insights).includes('gain:AAA'));
  assert.ok(ids(insights).includes('loss:BBB'));
  assert.match(insights.find((i) => i.id === 'loss:BBB').title, /down 30%/);
  // Warnings come before information.
  assert.ok(ids(insights).indexOf('loss:BBB') < ids(insights).indexOf('gain:AAA'));
});

test('a large gain in a tiny position is not worth rebalancing', () => {
  const values = Object.fromEntries('ABCDEFGHIJ'.split('').map((t) => [`${t}${t}${t}`, 1000]));
  const rows = rowsWorth({ ...values, ZZZ: 20 }, { ZZZ: 5 }); // +300%, but ~0.2% of the portfolio
  assert.ok(!ids(insightsFor(rows)).includes('gain:ZZZ'));
});

const newsItem = (ticker, sentiment, hours = 5) => ({ tickers: [ticker], named: [ticker], sentiment, publishedAt: hoursAgo(hours) });

test('a week of mostly negative news about a holding is a warning', () => {
  const rows = rowsWorth({ TSLA: 100 });
  const news = [newsItem('TSLA', 'negative'), newsItem('TSLA', 'negative'), newsItem('TSLA', 'neutral')];
  assert.ok(ids(insightsFor(rows, { news })).includes('news-negative:TSLA'));
});

test('news trends ignore old, unnamed, and too-few articles', () => {
  const rows = rowsWorth({ TSLA: 100 });
  const old = [newsItem('TSLA', 'negative', 24 * 10), newsItem('TSLA', 'negative', 24 * 10), newsItem('TSLA', 'negative', 24 * 10)];
  const tagged = [1, 2, 3].map(() => ({ ...newsItem('TSLA', 'negative'), named: [] }));
  const few = [newsItem('TSLA', 'negative'), newsItem('TSLA', 'negative')];
  for (const news of [old, tagged, few]) {
    assert.ok(!ids(insightsFor(rows, { news })).some((id) => id.startsWith('news-')));
  }
});

test('a couple of positive headlines in a lot of coverage is not a trend', () => {
  const rows = rowsWorth({ TSLA: 100 });
  const news = [newsItem('TSLA', 'positive'), newsItem('TSLA', 'positive'),
    ...Array.from({ length: 15 }, () => newsItem('TSLA', 'neutral'))];
  assert.ok(!ids(insightsFor(rows, { news })).some((id) => id.startsWith('news-')));
});

test('upbeat news is noted as positive', () => {
  const rows = rowsWorth({ AAPL: 100 });
  const news = [newsItem('AAPL', 'positive'), newsItem('AAPL', 'positive'), newsItem('AAPL', 'positive')];
  const insight = insightsFor(rows, { news }).find((i) => i.id === 'news-positive:AAPL');
  assert.strictEqual(insight.severity, 'positive');
});

test('names the holdings without a price', () => {
  const rows = consolidateHoldings([lot('AAPL', 1, 100, 100), lot('ZZZQX', 1, 10, null), lot('QQQQZ', 1, 10, null)]);
  assert.strictEqual(insightsFor(rows).find((i) => i.id === 'unpriced').title, 'No market price for ZZZQX and QQQQZ');
});

// ---- Specific amounts in the recommendations ----

const dated = (ticker, shares, purchasePrice, currentPrice, purchaseDate) =>
  ({ ticker, shares, purchasePrice, purchaseDate, currentPrice });
const insight = (rows, id, options) => insightsFor(rows, options).find((i) => i.id === id);

test('concentration says how many shares to sell, or how much to add elsewhere, to reach 25%', () => {
  // TSLA: 20 shares at $350 = $7,000 of $10,000 total; bought at $400 over a year ago.
  const rows = consolidateHoldings([dated('TSLA', 20, 400, 350, '2024-01-15'), dated('AAPL', 10, 100, 300, '2024-01-15')]);
  const { action, detail } = insight(rows, 'concentration:TSLA');
  assert.match(detail, /TSLA is \$7,000 of your \$10,000/);
  // (7,000 - 2,500) / 0.75 = $6,000 -> 18 shares (~$6,300); 7,000 / 0.25 - 10,000 = $18,000 elsewhere.
  assert.match(action, /sell about 18 shares of your 20 \(~\$6,300\)/);
  assert.match(action, /realize a loss of about \$900/);
  assert.match(action, /about \$18,000 of new money into your other holdings/);
  assert.match(action, /\$900 loss could offset capital gains/);
});

test('large gains say how many shares would take back the original money, and the tax rate by holding period', () => {
  const values = Object.fromEntries('ABCDEFG'.split('').map((t) => [`${t}${t}${t}`, 100]));
  const others = Object.entries(values).map(([t, v]) => dated(t, 1, v, v, '2024-01-15'));
  const longTerm = consolidateHoldings([...others, dated('NVDA', 30, 40, 100, '2024-01-15')]);
  const { detail, action } = insight(longTerm, 'gain:NVDA');
  assert.match(detail, /The \$1,200 you put in is now worth \$3,000/);
  // 1,200 / $100 = 12 shares; afterwards NVDA is (3,000 - 1,200) / (3,700 - 1,200) = 72%.
  assert.match(action, /Selling about 12 shares of your 30 \(~\$1,200\) would take back what you put in, leave the rest invested, and bring NVDA to 72% of your portfolio/);
  assert.match(action, /realize a gain of about \$720/); // 12 x (100 - 40)
  assert.match(action, /lower long-term capital-gains rate/);

  const shortTerm = consolidateHoldings([...others, dated('NVDA', 30, 40, 100, '2026-03-02')]);
  assert.match(insight(shortTerm, 'gain:NVDA').action, /taxed as ordinary income\. After Mar 3, 2027/);

  const mixed = consolidateHoldings([...others, dated('NVDA', 15, 40, 100, '2024-01-15'), dated('NVDA', 15, 40, 100, '2026-06-01')]);
  assert.match(insight(mixed, 'gain:NVDA').action, /Some of these shares were bought within the last year/);
});

test('without purchase dates (synced holdings), no tax-rate claim is made', () => {
  const values = Object.fromEntries('ABCDEFG'.split('').map((t) => [`${t}${t}${t}`, 100]));
  const rows = consolidateHoldings([
    ...Object.entries(values).map(([t, v]) => dated(t, 1, v, v, '2024-01-15')),
    dated('NVDA', 30, 40, 100, null),
  ]);
  assert.doesNotMatch(insight(rows, 'gain:NVDA').action, /rate/);
});

test('large gains in funds are not flagged', () => {
  const rows = consolidateHoldings([dated('VOO', 10, 100, 300, '2024-01-15'), dated('AAPL', 10, 100, 150, '2024-01-15')]);
  const profiles = new Map([['VOO', fund('Vanguard S&P 500 ETF')]]);
  assert.strictEqual(insight(rows, 'gain:VOO', { profiles }), undefined);
});

test('large losses give the average cost, current price and holding period', () => {
  const rows = consolidateHoldings([dated('TSLA', 10, 300, 200, '2024-01-15')]);
  const news = [{ headline: 'Tesla recalls cars', url: 'u1', source: 'Reuters', publishedAt: hoursAgo(5), tickers: ['TSLA'], named: ['TSLA'], sentiment: 'negative' }];
  const { detail, action, links } = insight(rows, 'loss:TSLA', { news });
  assert.match(detail, /average of \$300\.00 a share; it's \$200\.00 now, an unrealized loss of \$1,000 on 10 shares\. You've held it since Jan 2024\./);
  assert.match(action, /starting with the headlines below/);
  assert.match(action, /in a taxable account, that \$1,000 loss could offset/);
  assert.deepStrictEqual(links.map((l) => l.headline), ['Tesla recalls cars']);
});

test('low diversification says how much in an index fund would reach a score of 70', () => {
  const rows = rowsWorth({ AAPL: 6000, MSFT: 4000 });
  const { detail, action } = insight(rows, 'low-diversification');
  assert.match(detail, /AAPL and MSFT alone are 100% of it/);
  const amount = Number(action.match(/about \$([\d,]+) into a broad-market index fund/)[1].replace(/,/g, ''));
  // Check the claim with the real score: adding that much as a fund reaches 70, and $100 less doesn't.
  const withFund = (added) => scorePortfolio(rowsWorth({ AAPL: 6000, MSFT: 4000, VTI: added }), new Map([['VTI', fund('Vanguard Total Stock Market ETF')]]));
  assert.ok(withFund(amount).diversificationScore >= 70);
  assert.ok(withFund(amount - 100).diversificationScore < 70);
});

test('news trends quote a headline and link the ones behind it', () => {
  const rows = rowsWorth({ TSLA: 100 });
  const item = (headline, sentiment) => ({ headline, url: headline, source: 'Reuters', publishedAt: hoursAgo(5), tickers: ['TSLA'], named: ['TSLA'], sentiment });
  const news = [item('Tesla shares plunge', 'negative'), item('Tesla recall widens', 'negative'), item('Tesla to hold event', 'neutral')];
  const found = insight(rows, 'news-negative:TSLA', { news });
  assert.match(found.detail, /2 of the 3 headlines naming TSLA in the last 7 days read as negative, for example "Tesla shares plunge" \(Reuters, Nov 7\)/);
  assert.deepStrictEqual(found.links.map((l) => l.headline), ['Tesla shares plunge', 'Tesla recall widens']);
});

test('a well-diversified portfolio with nothing to warn about says so', () => {
  const rows = rowsWorth({ VOO: 800, VXUS: 200 });
  const profiles = new Map([['VOO', fund('Vanguard S&P 500 ETF')], ['VXUS', fund('Vanguard Total International Stock ETF')]]);
  assert.deepStrictEqual(ids(insightsFor(rows, { profiles })), ['well-diversified']);
});
