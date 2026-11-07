const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const Anthropic = require('@anthropic-ai/sdk');
const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const news = require('../src/news.js');
const claude = require('../src/claude.js');
const service = require('../src/service.js');
const { consolidateHoldings, summarizePortfolio } = require('../src/domain.js');
const { scorePortfolio, generateInsights } = require('../src/insights.js');
const { buildAdvisorBrief, validateAdvice, fallbackAdvice } = require('../src/advice.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

const NOW = Date.parse('2026-11-07T12:00:00Z');
const lot = (ticker, shares, purchasePrice, currentPrice, purchaseDate = '2024-01-15') =>
  ({ ticker, shares, purchasePrice, purchaseDate, currentPrice });

function portfolio(lots, profiles = new Map()) {
  const rows = consolidateHoldings(lots);
  const summary = summarizePortfolio(rows);
  const score = scorePortfolio(rows, profiles);
  const insights = generateInsights({ rows, summary, score, news: [], profiles, now: NOW });
  return { rows, summary, score, insights, profiles };
}

// ---- The brief Claude is given ----

test('the brief has each holding with its numbers, largest first, and the findings with their amounts', () => {
  const p = portfolio([lot('AAPL', 10, 100, 151.37), lot('VOO', 1, 400, 512.2)],
    new Map([['AAPL', { name: 'Apple Inc.', assetType: 'EQUITY' }], ['VOO', { name: 'Vanguard S&P 500 ETF', assetType: 'ETF' }]]));
  const brief = buildAdvisorBrief(p);
  assert.deepStrictEqual(brief.holdings[0], {
    ticker: 'AAPL', name: 'Apple Inc.', kind: 'stock', shares: 10, value: 1514, percentOfPortfolio: 75,
    averageCost: 100, price: 151.37, gainLoss: 514, gainLossPercent: 51, heldSince: '2024-01-15',
  });
  assert.strictEqual(brief.holdings[1].kind, 'fund');
  assert.strictEqual(brief.portfolio.totalValue, 2026);
  const finding = brief.findings.find((f) => f.id === 'concentration:AAPL');
  assert.match(finding.action, /sell about \d+ shares/);
});

test('synced holdings (no purchase dates) have no "held since"', () => {
  const brief = buildAdvisorBrief(portfolio([lot('AAPL', 10, 100, 150, null)]));
  assert.strictEqual(brief.holdings[0].heldSince, null);
});

test('headlines in the brief are ordered by date and capped', () => {
  const headline = (i) => ({ headline: `H${i}`, tickers: ['AAPL'], sentiment: 'neutral', publishedAt: `2026-11-0${(i % 7) + 1}T00:00:00Z` });
  const brief = buildAdvisorBrief({ ...portfolio([lot('AAPL', 1, 1, 2)]), news: Array.from({ length: 20 }, (_, i) => headline(i)) });
  assert.strictEqual(brief.headlines.length, 12);
  assert.ok(brief.headlines.every((h, i, all) => i === 0 || all[i - 1].date >= h.date));
});

// ---- Checking what Claude wrote ----

// A brief with the numbers the tests cite: TSLA 20 shares, sell 8 (~$2,866), loss $494.
const brief = {
  portfolio: { totalValue: 20524 },
  holdings: [{ ticker: 'TSLA', shares: 20, percentOfPortfolio: 35, heldSince: '2024-01-15' }],
  findings: [{ id: 'concentration:TSLA', action: 'sell about 8 shares of your 20 (~$2,866), which would realize a loss of about $494, or put about $8,134 of new money' }],
  headlines: [{ date: '2026-11-07', headline: 'Tesla recalls cars' }],
};
const rec = (over) => ({ title: 'Consider selling about 8 TSLA shares', why: 'TSLA is 35% of your portfolio.', steps: ['Check whether the account is taxable.'], ticker: 'TSLA', priority: 'high', basedOn: ['concentration:TSLA'], ...over });
const check = (raw) => validateAdvice(raw, { brief, heldTickers: ['TSLA'], insightIds: ['concentration:TSLA'] });

test('keeps recommendations whose numbers all come from the brief, within rounding', () => {
  const result = check({
    summary: 'Your $20,500 portfolio leans on TSLA at 35%.',
    recommendations: [rec({ why: 'Selling ~$2,866 realizes a $494 loss, held since Jan 2024; 1-2 options.' })],
  });
  assert.strictEqual(result.summary, 'Your $20,500 portfolio leans on TSLA at 35%.');
  assert.strictEqual(result.recommendations.length, 1);
  assert.strictEqual(result.dropped, 0);
});

test('drops a recommendation with a number Folio did not provide', () => {
  const result = check({
    summary: 'Your portfolio leans on TSLA.',
    recommendations: [
      rec({ title: 'Sell 12 TSLA shares' }), // 12 isn't in the brief
      rec({ steps: ['Invest $550 a month instead'] }), // a monthly split Claude calculated
      rec({ title: 'Consider selling about 8 TSLA shares (~$2,866)' }),
    ],
  });
  assert.strictEqual(result.dropped, 2);
  assert.deepStrictEqual(result.recommendations.map((r) => r.title), ['Consider selling about 8 TSLA shares (~$2,866)']);
});

test('a day of the month does not vouch for a share count', () => {
  // "07" appears in the headline date, but 7 shares appears nowhere.
  assert.strictEqual(check({ summary: 'S', recommendations: [rec({ title: 'Sell 7 TSLA shares' })] }).dropped, 1);
});

test('a summary with an unverifiable number is removed, but good recommendations stay', () => {
  const result = check({ summary: 'You could make $9,999 this year.', recommendations: [rec({})] });
  assert.strictEqual(result.summary, null);
  assert.strictEqual(result.recommendations.length, 1);
});

test('cleans up tickers, finding ids, priorities and steps, and keeps at most six', () => {
  const result = check({
    summary: 'S',
    recommendations: [
      rec({ ticker: 'GME', basedOn: ['concentration:TSLA', 'gain:GME', 'concentration:TSLA'], priority: 'urgent', steps: ['a', ' ', 'b', 'c', 'd'] }),
      ...Array.from({ length: 7 }, () => rec({ priority: 'high' })),
    ],
  });
  assert.strictEqual(result.recommendations.length, 6);
  const odd = check({ summary: 'S', recommendations: [rec({ ticker: 'GME', basedOn: ['concentration:TSLA', 'gain:GME', 'concentration:TSLA'], priority: 'urgent', steps: ['a', ' ', 'b', 'c', 'd'] })] }).recommendations[0];
  assert.deepStrictEqual([odd.ticker, odd.basedOn, odd.priority, odd.steps], [null, ['concentration:TSLA'], 'medium', ['a', 'b', 'c']]);
});

test('highest priority first', () => {
  const result = check({ summary: 'S', recommendations: [rec({ priority: 'low', title: 'L' }), rec({ priority: 'high', title: 'H' }), rec({ priority: 'medium', title: 'M' })] });
  assert.deepStrictEqual(result.recommendations.map((r) => r.title), ['H', 'M', 'L']);
});

test('nothing usable is rejected', () => {
  assert.strictEqual(check(null), null);
  assert.strictEqual(check({ summary: '', recommendations: [] }), null);
  assert.strictEqual(check({ summary: 'You could make $9,999.', recommendations: [rec({ title: 'Sell 12' })] }), null);
});

// ---- Without Claude ----

test('the rules-only summary states value, largest holdings and the score', () => {
  const { summary, recommendations } = fallbackAdvice(portfolio([lot('TSLA', 10, 300, 200), lot('AAPL', 10, 100, 150)]));
  assert.match(summary, /Your 2 holdings are worth about \$3,500, down 12\.5% from what you paid\./);
  assert.match(summary, /TSLA \(57%\) and AAPL \(43%\)/);
  assert.match(summary, /diversification score is \d+\/100/);
  assert.deepStrictEqual(recommendations, []);
});

test('the rules-only advice for an empty portfolio is empty', () => {
  assert.deepStrictEqual(fallbackAdvice(portfolio([])), { summary: null, recommendations: [] });
});

// ---- The Claude client ----

// Stands in for the Anthropic client. reply: (params) -> response, or throws.
function fakeClaude(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { parse: async (params) => { calls.push(params); return reply(params); } } },
  };
}
const answer = (parsed, extra = {}) => ({ stop_reason: 'end_turn', model: 'claude-haiku-5-5', parsed_output: parsed, ...extra });
const goodAdvice = { summary: 'You own mostly TSLA.', recommendations: [rec({})] };

beforeEach(() => {
  claude.clearCacheForTests();
  claude.configure(loadConfig({}));
});

test('is off without an API key', async () => {
  assert.strictEqual(claude.isConfigured(), false);
  await assert.rejects(claude.generateAdvice({}), (err) => err instanceof claude.AdvisorError && err.reason === 'not_configured');
});

test('asks Haiku for structured recommendations from the brief, without fallbacks it does not support', async () => {
  const fake = fakeClaude(() => answer(goodAdvice));
  claude.setClientForTests(fake, 'claude-haiku-5-5');
  const { advice, model } = await claude.generateAdvice({ holdings: [{ ticker: 'TSLA' }] });
  assert.deepStrictEqual(advice, goodAdvice);
  assert.strictEqual(model, 'claude-haiku-5-5');
  const [params] = fake.calls;
  assert.strictEqual(params.model, 'claude-haiku-5-5');
  assert.strictEqual(params.fallbacks, undefined);
  assert.strictEqual(params.betas, undefined);
  assert.strictEqual(params.output_config.effort, 'low');
  assert.strictEqual(params.output_config.format.type, 'json_schema');
  assert.match(params.messages[0].content, /"ticker": "TSLA"/);
  assert.match(params.system, /Use only numbers that appear in the brief/);
});

test('on a model that supports them, server-side refusal fallbacks are on', async () => {
  const fake = fakeClaude(() => answer(goodAdvice));
  claude.setClientForTests(fake, 'claude-opus-5-5');
  await claude.generateAdvice({ x: 1 });
  assert.strictEqual(fake.calls[0].fallbacks, 'default');
  assert.deepStrictEqual(fake.calls[0].betas, ['server-side-fallback-2026-07-01']);
});

test('reuses the answer for the same brief, shares one request between callers, and refreshes on demand', async () => {
  const fake = fakeClaude(() => answer(goodAdvice));
  claude.setClientForTests(fake);
  await Promise.all([claude.generateAdvice({ a: 1 }), claude.generateAdvice({ a: 1 })]);
  await claude.generateAdvice({ a: 1 });
  assert.strictEqual(fake.calls.length, 1);
  await claude.generateAdvice({ a: 2 });
  await claude.generateAdvice({ a: 1 }, { fresh: true });
  assert.strictEqual(fake.calls.length, 3);
});

test('a refusal or unreadable answer becomes an AdvisorError', async () => {
  claude.setClientForTests(fakeClaude(() => answer(null, { stop_reason: 'refusal' })));
  await assert.rejects(claude.generateAdvice({ r: 1 }), (err) => err.reason === 'refusal');
  claude.setClientForTests(fakeClaude(() => answer(null)));
  await assert.rejects(claude.generateAdvice({ r: 2 }), (err) => err.reason === 'invalid');
});

test('API failures become AdvisorErrors the page can explain', async () => {
  const cases = [
    [new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()), 'auth'],
    [new Anthropic.RateLimitError(429, {}, 'slow down', new Headers()), 'rate_limit'],
    [new Anthropic.APIConnectionError({ message: 'offline' }), 'connection'],
    [new Anthropic.InternalServerError(500, {}, 'oops', new Headers()), 'api'],
  ];
  for (const [i, [error, reason]] of cases.entries()) {
    claude.setClientForTests(fakeClaude(() => { throw error; }));
    await assert.rejects(claude.generateAdvice({ e: i }), (err) => err instanceof claude.AdvisorError && err.reason === reason);
  }
});

test('a failed request is not cached', async () => {
  let fail = true;
  const fake = fakeClaude(() => { if (fail) throw new Anthropic.RateLimitError(429, {}, 'slow', new Headers()); return answer(goodAdvice); });
  claude.setClientForTests(fake);
  await assert.rejects(claude.generateAdvice({ c: 1 }));
  fail = false;
  assert.deepStrictEqual((await claude.generateAdvice({ c: 1 })).advice, goodAdvice);
});

// ---- Through the Service tier ----

const chart = (price, longName) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: 1760000000, longName, instrumentType: 'EQUITY' } }] } });
async function withHoldings() {
  data.closeDb();
  prices.clearCacheForTests();
  news.clearCacheForTests();
  service.configure(loadConfig({ DB_FILE: ':memory:' }));
  service.addHolding({ ticker: 'TSLA', shares: '10', purchasePrice: '300', purchaseDate: '2024-01-15' });
  service.addHolding({ ticker: 'AAPL', shares: '10', purchasePrice: '100', purchaseDate: '2024-01-15' });
  const fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('/search') ? { news: [] } : chart(url.includes('TSLA') ? 200 : 150, url.includes('TSLA') ? 'Tesla, Inc.' : 'Apple Inc.')),
  });
  prices.setFetchForTests(fetch);
  news.setFetchForTests(fetch);
  await service.refreshPrices();
}

test('without a key, the summary comes from the rules and there are no AI recommendations', async () => {
  await withHoldings();
  const advice = await service.getAdvice();
  assert.strictEqual(advice.source, 'rules');
  assert.strictEqual(advice.aiConfigured, false);
  assert.strictEqual(advice.aiIssue, null);
  assert.match(advice.summary, /worth about/);
  assert.deepStrictEqual(advice.recommendations, []);
});

test("with Claude, its recommendations are checked against the brief it was given", async () => {
  await withHoldings();
  const fake = fakeClaude(({ messages }) => {
    const sent = JSON.parse(messages[0].content.replace(/^[^{]*/, ''));
    const tsla = sent.findings.find((f) => f.id === 'concentration:TSLA');
    const shares = tsla.action.match(/sell about (\d+) shares/)[1];
    return answer({
      summary: 'Most of your money is in TSLA, which is down from what you paid.',
      recommendations: [
        { title: `Consider selling about ${shares} TSLA shares`, why: 'It brings TSLA to 25%.', steps: [], ticker: 'TSLA', priority: 'high', basedOn: ['concentration:TSLA'] },
        { title: 'Sell 4,321 TSLA shares', why: 'Made up.', steps: [], ticker: 'TSLA', priority: 'high', basedOn: [] },
      ],
    });
  });
  claude.setClientForTests(fake);
  const advice = await service.getAdvice();
  assert.strictEqual(advice.source, 'claude');
  assert.strictEqual(advice.model, 'claude-haiku-5-5');
  assert.strictEqual(advice.recommendations.length, 1);
  assert.match(advice.recommendations[0].title, /^Consider selling about \d+ TSLA shares$/);
  assert.strictEqual(advice.dropped, 1);
});

test("when Claude's summary fails the check, the rules' summary is used with Claude's recommendations", async () => {
  await withHoldings();
  claude.setClientForTests(fakeClaude(() => answer({
    summary: 'You will make $123,456.',
    recommendations: [{ title: 'Review your TSLA position', why: '', steps: [], ticker: 'TSLA', priority: 'high', basedOn: [] }],
  })));
  const advice = await service.getAdvice();
  assert.strictEqual(advice.source, 'claude');
  assert.match(advice.summary, /worth about/);
  assert.strictEqual(advice.recommendations.length, 1);
});

test('when Claude fails, the rules-based summary is shown with the reason', async () => {
  await withHoldings();
  claude.setClientForTests(fakeClaude(() => { throw new Anthropic.RateLimitError(429, {}, 'slow', new Headers()); }));
  const advice = await service.getAdvice();
  assert.strictEqual(advice.source, 'rules');
  assert.match(advice.aiIssue, /rate limited/);
  assert.match(advice.summary, /worth about/);
  assert.deepStrictEqual(advice.recommendations, []);
});
