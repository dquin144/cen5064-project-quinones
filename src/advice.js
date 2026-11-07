// Domain tier: the rules around the AI-written part of the Recommendations tab
// (pure functions, no I/O, imports nothing).
//   - buildAdvisorBrief: the facts the language model is given, and nothing else
//   - validateAdvice:    checks what the model wrote before the user sees it,
//                        including that every number in it came from the brief
//   - fallbackAdvice:    the summary written from the rules alone, for when no
//                        model is configured or it fails
//
// The model turns Folio's findings (insights.generateInsights, which calculate every
// amount) into a few specific recommendations. It may combine and explain findings,
// but not calculate: a recommendation with a number that isn't in the brief is dropped.

const MAX_HOLDINGS_IN_BRIEF = 15;
const MAX_HEADLINES_IN_BRIEF = 12;
const MAX_RECOMMENDATIONS = 6;
const MAX_STEPS = 3;
const MAX_SUMMARY_CHARS = 1200;
const MAX_TITLE_CHARS = 160;
const MAX_TEXT_CHARS = 500;
const PRIORITIES = ['high', 'medium', 'low'];
const FUND_TYPES = new Set(['ETF', 'MUTUALFUND']);

const round = (n, places = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** places) / 10 ** places);

// rows/summary/score from the portfolio view; insights from generateInsights; news
// from matchNewsToHoldings/topNews; profiles: Map<ticker, { name, assetType }>.
// Headlines are ordered by date, not relevance, so the same news gives the same
// brief (and a cached answer).
function buildAdvisorBrief({ rows, summary, score, insights = [], news = [], profiles = new Map() }) {
  const priced = rows.filter((r) => r.value > 0);
  const total = priced.reduce((sum, r) => sum + r.value, 0);
  const holdings = rows
    .slice()
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
    .slice(0, MAX_HOLDINGS_IN_BRIEF)
    .map((r) => {
      const dates = r.holdings.map((h) => h.purchaseDate);
      return {
        ticker: r.ticker,
        name: profiles.get(r.ticker)?.name ?? null,
        kind: FUND_TYPES.has(profiles.get(r.ticker)?.assetType) ? 'fund' : 'stock',
        shares: r.shares,
        value: round(r.value),
        percentOfPortfolio: r.value > 0 ? round((r.value / total) * 100) : null,
        averageCost: round(r.costBasis / r.shares, 2),
        price: round(r.currentPrice, 2),
        gainLoss: round(r.gainLoss),
        gainLossPercent: round(r.gainLossPercent),
        heldSince: dates.length > 0 && dates.every(Boolean) ? dates.slice().sort()[0] : null,
      };
    });

  return {
    portfolio: {
      holdingsCount: rows.length,
      totalValue: round(total),
      gainLoss: round(summary?.gainLoss),
      gainLossPercent: round(summary?.gainLossPercent, 1),
      unpricedCount: summary?.unpricedCount ?? 0,
    },
    riskScore: score && {
      diversificationScore: score.diversificationScore,
      effectiveHoldings: score.effectiveHoldings,
      concentrationRisk: score.riskLabel,
      stocksOver25Percent: score.concentratedStocks.map((s) => s.ticker),
    },
    holdings,
    // Folio's findings exactly as the user can see them, with every amount.
    findings: insights.map((i) => ({ id: i.id, severity: i.severity, ticker: i.ticker, title: i.title, detail: i.detail, action: i.action })),
    headlines: news
      .slice()
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)) || a.headline.localeCompare(b.headline))
      .slice(0, MAX_HEADLINES_IN_BRIEF)
      .map((n) => ({ date: String(n.publishedAt).slice(0, 10), tickers: n.tickers, headline: n.headline, tone: n.sentiment })),
  };
}

// ---- The numbers check ----

const ISO_DATE = /\b(\d{4})-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
// Numbers this small are wording ("1-2 options", "every 3 months"), not amounts.
const WORDING_MAX = 3;

const numbersIn = (text) => (String(text ?? '').match(NUMBER) ?? [])
  .map((t) => Number(t.replace(/,/g, '')))
  .filter(Number.isFinite);

// Every number the brief contains. Dates count only by their year ("since Jan 2024"),
// so a day like "-07" doesn't vouch for "7 shares".
function knownNumbers(brief) {
  const text = JSON.stringify(brief).replace(ISO_DATE, (_, year) => ` ${year} `);
  return numbersIn(text);
}

// A number passes if the brief has it: amounts of 100 or more within 1% (so
// "$20,500" matches 20,524), smaller ones within rounding ("35%" matches 34.9).
function isKnown(n, known) {
  if (n <= WORDING_MAX) return true;
  return known.some((m) => (m >= 100 ? Math.abs(n - m) <= 0.01 * m : Math.abs(n - m) < 0.5));
}

const unverified = (texts, known) => texts.flatMap(numbersIn).filter((n) => !isKnown(n, known));

// ---- Checking what the model wrote ----

const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// raw: { summary, recommendations: [{ title, why, steps, ticker, priority, basedOn }] }
// as the model wrote it. Returns { summary, recommendations, dropped }, or null when
// nothing usable is left:
//   summary: the summary, or null if it used a number the brief doesn't have
//   recommendations: at most 6, highest priority first; tickers the user doesn't
//     hold and finding ids that don't exist are removed
//   dropped: how many recommendations were removed for unverifiable numbers
function validateAdvice(raw, { brief, heldTickers = [], insightIds = [] }) {
  if (!raw || typeof raw !== 'object') return null;
  const known = knownNumbers(brief);
  const held = new Set(heldTickers.map((t) => t.toUpperCase()));
  const ids = new Set(insightIds);

  let summary = clean(raw.summary, MAX_SUMMARY_CHARS) || null;
  if (summary && unverified([summary], known).length > 0) summary = null;

  let dropped = 0;
  const recommendations = [];
  for (const item of Array.isArray(raw.recommendations) ? raw.recommendations : []) {
    const title = clean(item?.title, MAX_TITLE_CHARS);
    if (!title) continue;
    const why = clean(item?.why, MAX_TEXT_CHARS);
    const steps = (Array.isArray(item?.steps) ? item.steps : [])
      .map((s) => clean(s, MAX_TEXT_CHARS))
      .filter(Boolean)
      .slice(0, MAX_STEPS);
    if (unverified([title, why, ...steps], known).length > 0) {
      dropped += 1;
      continue;
    }
    const ticker = String(item?.ticker ?? '').trim().toUpperCase();
    recommendations.push({
      title,
      why,
      steps,
      ticker: held.has(ticker) ? ticker : null,
      priority: PRIORITIES.includes(item?.priority) ? item.priority : 'medium',
      basedOn: [...new Set((Array.isArray(item?.basedOn) ? item.basedOn : []).map(String))].filter((id) => ids.has(id)),
    });
  }
  recommendations.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  recommendations.splice(MAX_RECOMMENDATIONS);

  if (!summary && recommendations.length === 0) return null;
  return { summary, recommendations, dropped };
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

// The summary without a language model: a template over the same facts. Without a
// model, Folio's findings themselves are the recommendations, so none are added.
function fallbackAdvice({ rows, summary, score, insights = [] }) {
  if (rows.length === 0) return { summary: null, recommendations: [] };
  const priced = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const total = priced.reduce((sum, r) => sum + r.value, 0);
  const sentences = [];
  const count = `${rows.length} holding${rows.length === 1 ? '' : 's'}`;
  if (priced.length > 0) {
    const change = summary?.gainLossPercent;
    const trend = change === null || change === undefined ? '' : `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(1)}% from what you paid`;
    sentences.push(`Your ${count} ${rows.length === 1 ? 'is' : 'are'} worth about ${money(total)}${trend}.`);
    const largest = priced.slice(0, 2).map((r) => `${r.ticker} (${Math.round((r.value / total) * 100)}%)`);
    if (priced.length > 1) sentences.push(`The largest are ${largest.join(' and ')}.`);
  } else {
    sentences.push(`You have ${count}, but none has a market price yet.`);
  }
  if (score) {
    sentences.push(`Your diversification score is ${score.diversificationScore}/100, which means ${score.riskLabel.toLowerCase()} concentration risk.`);
  }
  const warnings = insights.filter((i) => i.severity === 'warning').length;
  sentences.push(warnings > 0
    ? `${warnings} of the findings below ${warnings === 1 ? 'is a warning' : 'are warnings'}, starting with the most important.`
    : 'Nothing below needs urgent attention.');
  return { summary: sentences.join(' '), recommendations: [] };
}

module.exports = { buildAdvisorBrief, validateAdvice, fallbackAdvice };
