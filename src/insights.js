// Domain tier: analysis of a portfolio, as pure functions (no I/O, imports nothing).
//   - scorePortfolio: how diversified the portfolio is, and how risky its concentration is
//   - identifyRelevantTopics / matchNewsToHoldings: which news is about what the user owns
//   - generateInsights: plain-language, rule-based recommendations
//
// Works on the rows built by domain.consolidateHoldings. "profiles" is an optional
// Map<ticker, { name, assetType }> from the price source; without it, every holding is
// treated as a single stock known only by its ticker.

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Diversification and concentration ----

// A fund (ETF, mutual fund) holds many companies, so it spreads risk as if it were
// this many equal holdings. Folio can't see inside a fund, so two funds that hold the
// same companies (e.g. two S&P 500 funds) still count as separate.
const FUND_SPREAD = 10;
const FUND_TYPES = new Set(['ETF', 'MUTUALFUND']);
// Effective holdings at which the diversification score reaches 100.
const WELL_DIVERSIFIED_HOLDINGS = 10;
// A single stock above this share of total value is a concentration warning.
const CONCENTRATION_LIMIT_PERCENT = 25;

const isFund = (profiles, ticker) => FUND_TYPES.has(profiles.get(ticker)?.assetType);

// Share of total value per priced row, in percent: Map<ticker, percent>.
function percentByTicker(rows) {
  const priced = rows.filter((r) => r.value > 0);
  const total = priced.reduce((sum, r) => sum + r.value, 0);
  return new Map(priced.map((r) => [r.ticker, (r.value / total) * 100]));
}

// Returns null when no holding has a market price (nothing to score yet). Otherwise:
//   diversificationScore: 0 (everything in one stock) to 100 (spread like 10+ equal holdings)
//   effectiveHoldings:    how many equal-sized holdings the portfolio behaves like
//                         (1 / Herfindahl index of the value weights)
//   largestStock:         the biggest single stock by value, { ticker, percent }, or null
//   concentratedStocks:   every stock over 25% of value, largest first, [{ ticker, percent }]
//   concentrationWarning: true when any stock is over 25% of value
//   riskLabel:            'Low' | 'Moderate' | 'High' concentration risk
function scorePortfolio(rows, profiles = new Map()) {
  const percents = percentByTicker(rows);
  if (percents.size === 0) return null;

  let herfindahl = 0;
  const stocks = [];
  for (const [ticker, percent] of percents) {
    const w = percent / 100;
    if (isFund(profiles, ticker)) {
      herfindahl += (w * w) / FUND_SPREAD;
    } else {
      herfindahl += w * w;
      stocks.push({ ticker, percent });
    }
  }
  stocks.sort((a, b) => b.percent - a.percent);
  const effectiveHoldings = 1 / herfindahl;
  const diversificationScore = Math.round(
    Math.min(1, (effectiveHoldings - 1) / (WELL_DIVERSIFIED_HOLDINGS - 1)) * 100);
  const concentratedStocks = stocks.filter((s) => s.percent > CONCENTRATION_LIMIT_PERCENT);
  const concentrationWarning = concentratedStocks.length > 0;

  let riskLabel = 'High';
  if (diversificationScore >= 70 && !concentrationWarning) riskLabel = 'Low';
  else if (diversificationScore >= 40) riskLabel = 'Moderate';

  return {
    diversificationScore,
    effectiveHoldings: Math.round(effectiveHoldings * 10) / 10,
    largestStock: stocks[0] ?? null,
    concentratedStocks,
    concentrationWarning,
    riskLabel,
  };
}

// ---- Headline sentiment ----
// A small word list, not a language model: good enough to tell "beats estimates,
// shares surge" from "misses estimates, shares plunge", and easy to explain and test.
// Only the headline is read. Summaries are longer and wander ("one of the ugliest
// stretches on record", or a paragraph about a different company), which made the
// word count less accurate, not more, on real news.

const POSITIVE_WORDS = new Set([
  'beat', 'beats', 'surge', 'surges', 'surged', 'soar', 'soars', 'soared', 'jump', 'jumps',
  'jumped', 'rally', 'rallies', 'rallied', 'record', 'upgrade', 'upgrades', 'upgraded',
  'raises', 'raised', 'gain', 'gains', 'rise', 'rises', 'rose', 'climb', 'climbs', 'climbed',
  'strong', 'stronger', 'growth', 'profit', 'profits', 'outperform', 'outperforms', 'bullish',
  'tops', 'topped', 'rebound', 'rebounds', 'approval', 'approved', 'wins', 'boost', 'boosts',
  'boosted', 'expands', 'breakthrough', 'buyback',
]);
const NEGATIVE_WORDS = new Set([
  'miss', 'misses', 'missed', 'plunge', 'plunges', 'plunged', 'fall', 'falls', 'fell', 'drop',
  'drops', 'dropped', 'slump', 'slumps', 'slide', 'slides', 'sink', 'sinks', 'sank', 'tumble',
  'tumbles', 'tumbled', 'crash', 'crashes', 'downgrade', 'downgrades', 'downgraded', 'cut',
  'cuts', 'slash', 'slashes', 'lawsuit', 'sued', 'sues', 'probe', 'investigation', 'recall',
  'recalls', 'loss', 'losses', 'weak', 'weaker', 'warns', 'warning', 'bearish', 'layoffs',
  'fraud', 'decline', 'declines', 'declined', 'bankruptcy', 'fined', 'delay', 'delays',
  'delayed', 'halt', 'halts', 'lowers', 'antitrust', 'selloff', 'plummet', 'plummets', 'fail',
  'fails', 'failed', 'losing', 'worst', 'ugliest', 'tank', 'tanks', 'tanked',
]);

// Returns 'positive' | 'negative' | 'neutral'.
function headlineSentiment(text) {
  let score = 0;
  const normalized = String(text ?? '').toLowerCase().replace(/sell-off/g, 'selloff');
  for (const word of normalized.match(/[a-z]+/g) ?? []) {
    if (POSITIVE_WORDS.has(word)) score += 1;
    else if (NEGATIVE_WORDS.has(word)) score -= 1;
  }
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// ---- Which news is about what the user owns ----

// "Meta Platforms, Inc." -> "Meta Platforms"; "Berkshire Hathaway Inc. New" -> "Berkshire Hathaway".
const NAME_SUFFIX = /(?:,|\s)+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|class [a-c]|common stock|new)\.?$/i;
function coreName(name) {
  let s = String(name ?? '').trim().replace(/\.com\b/i, '');
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(NAME_SUFFIX, '').trim();
  }
  return s.replace(/^the\s+/i, '');
}

// First words too common to stand for one company on their own ("General", "Bank").
const GENERIC_FIRST_WORDS = new Set([
  'american', 'general', 'united', 'first', 'national', 'international', 'global', 'advanced',
  'bank', 'capital', 'financial', 'digital', 'energy', 'health', 'royal', 'southern', 'northern',
  'western', 'eastern', 'pacific', 'new', 'great', 'applied', 'vanguard', 'ishares', 'invesco',
  'spdr', 'schwab', 'fidelity',
]);

// Words a headline would use for the company: its short name, and for a
// multi-word name its distinctive first word ("Meta Platforms" -> also "Meta").
function companyKeywords(name) {
  const core = coreName(name);
  if (!core) return [];
  const keywords = [core];
  const [first, ...rest] = core.split(/\s+/);
  if (rest.length > 0 && first.length >= 4 && !GENERIC_FIRST_WORDS.has(first.toLowerCase())) keywords.push(first);
  return keywords;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Tickers of 3+ letters match as an uppercase word ("AAPL"). Shorter ones ("T", "GE")
// are ordinary words or initials too often, so they only match as "$T", "(T)" or ":T".
function mentionsTicker(text, ticker) {
  const t = escapeRegex(ticker);
  const pattern = ticker.length >= 3 ? `(?<![A-Za-z.])${t}(?![A-Za-z])` : `(?:\\$|\\(|:\\s?)${t}(?![A-Za-z])`;
  return new RegExp(pattern).test(text);
}

function mentions(text, topic) {
  if (!text) return false;
  if (mentionsTicker(text, topic.ticker)) return true;
  return topic.keywords.some((k) => new RegExp(`(?<![A-Za-z0-9])${escapeRegex(k)}(?![A-Za-z0-9])`, 'i').test(text));
}

// The holdings worth fetching news for: the largest by value first (unpriced last),
// at most max of them so free-tier news APIs aren't overloaded. Each topic carries
// what matching needs: keywords for the company, its share of the portfolio, and
// whether it's a fund.
function identifyRelevantTopics(rows, profiles = new Map(), max = 10) {
  const percents = percentByTicker(rows);
  return rows
    .slice()
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
    .slice(0, max)
    .map((r) => ({
      ticker: r.ticker,
      keywords: companyKeywords(profiles.get(r.ticker)?.name),
      percent: percents.get(r.ticker) ?? 0,
      fund: isFund(profiles, r.ticker),
    }));
}

// How much weight a match gets, by where the holding is mentioned.
const MENTION_IN_HEADLINE = 1;
const MENTION_IN_SUMMARY = 0.6;
const TAGGED_ONLY = 0.25; // the news source tagged it, but the text never names it
const RECENCY_HALF_LIFE_HOURS = 72;

// articles: [{ id, headline, summary, url, source, publishedAt, tickers }] from the news
// client, possibly with the same story listed under several tickers.
// Returns the articles about the user's holdings, each once, best first:
//   [{ id, headline, url, source, publishedAt, tickers, named, sentiment, relevance }]
// tickers: the held tickers the article is about, most relevant first.
// named: those of them the text actually names (the rest were only tagged by the source).
//
// An article only tagged with a stock's ticker, whose text never names the company,
// is dropped when Folio knows the company's name: news sources tag loosely ("Booking
// vs. DoorDash" tagged AAPL). For funds and holdings with no known name, a tag is
// all there is, so tagged articles are kept but ranked low.
function matchNewsToHoldings(articles, topics, now = Date.now()) {
  const byTicker = new Map(topics.map((t) => [t.ticker, t]));
  const largest = Math.max(1, ...topics.map((t) => t.percent));
  const merged = new Map(); // link or headline -> match (each match under both)

  for (const a of articles) {
    if (!a.headline || !a.url) continue;
    const scores = new Map(); // ticker -> mention weight
    const tagged = new Set((a.tickers ?? []).map((t) => String(t).toUpperCase()));
    for (const topic of topics) {
      let weight = 0;
      if (mentions(a.headline, topic)) weight = MENTION_IN_HEADLINE;
      else if (mentions(a.summary, topic)) weight = MENTION_IN_SUMMARY;
      else if (tagged.has(topic.ticker) && (topic.fund || topic.keywords.length === 0)) weight = TAGGED_ONLY;
      if (weight > 0) scores.set(topic.ticker, weight);
    }
    if (scores.size === 0) continue;

    const ageHours = Math.max(0, (now - Date.parse(a.publishedAt)) / 3600000) || 0;
    const recency = 0.5 ** (ageHours / RECENCY_HALF_LIFE_HOURS);
    const relevanceOf = (ticker) => scores.get(ticker) * (0.5 + 0.5 * (byTicker.get(ticker).percent / largest)) * recency;
    const tickers = [...scores.keys()].sort((x, y) => relevanceOf(y) - relevanceOf(x));
    const match = {
      id: a.id ?? a.url,
      headline: a.headline,
      url: a.url,
      source: a.source ?? null,
      publishedAt: a.publishedAt,
      tickers,
      sentiment: headlineSentiment(a.headline),
      named: tickers.filter((t) => scores.get(t) > TAGGED_ONLY),
      relevance: relevanceOf(tickers[0]),
    };

    // The same story often comes back once per ticker, sometimes with a different
    // link; keep one, with every ticker. (Not the link without its query string:
    // Finnhub's links differ only by ?id=.)
    const urlKey = `url:${a.url.split('#')[0]}`;
    const headlineKey = `headline:${a.headline.trim().toLowerCase()}`;
    const existing = merged.get(urlKey) ?? merged.get(headlineKey);
    if (!existing) {
      merged.set(urlKey, match);
      merged.set(headlineKey, match);
    } else {
      existing.tickers = [...new Set([...existing.tickers, ...match.tickers])];
      existing.named = [...new Set([...existing.named, ...match.named])];
      existing.relevance = Math.max(existing.relevance, match.relevance);
    }
  }

  return [...new Set(merged.values())].sort((a, b) => b.relevance - a.relevance);
}

// The best matches to show: at most perTicker led by any one holding, so one
// heavily covered stock doesn't fill the list, and at most total overall.
function topNews(matches, { perTicker = 4, total = 15 } = {}) {
  const shown = new Map();
  const result = [];
  for (const m of matches) {
    const lead = m.tickers[0];
    if ((shown.get(lead) ?? 0) >= perTicker) continue;
    shown.set(lead, (shown.get(lead) ?? 0) + 1);
    result.push(m);
    if (result.length === total) break;
  }
  return result;
}

// ---- Recommendations ----
// Each rule looks at the portfolio and returns zero or more insights:
//   { id, severity: 'warning' | 'info' | 'positive', ticker, title, detail, action, links }
// They use the user's own numbers: how many shares to sell or how much to add to
// reach a target, the gain or loss a sale would realize, and how long the shares
// have been held (which decides the US capital-gains rate). links: headlines behind
// the insight, [{ headline, url, source, publishedAt }], often empty.
// Adding a recommendation means adding a rule to RULES; generateInsights doesn't change.

const LARGE_GAIN_PERCENT = 50;
const LARGE_GAIN_MIN_SHARE = 10; // only worth rebalancing if it's a real slice of the portfolio
const LARGE_LOSS_PERCENT = -20;
const NEWS_WINDOW_DAYS = 7;
const MIN_NEWS_FOR_TREND = 3;
const MIN_TREND_SHARE = 1 / 3;
const TARGET_SCORE = 70; // where concentration risk becomes "Low"
const MAX_LINKS = 3;
const LONG_TERM_DAYS = 365;

const pct = (n) => `${Math.round(Math.abs(n))}%`;
const money = (n) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const price = (n) => `$${n.toFixed(2)}`;
const plural = (n, word) => `${n.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${word}${n === 1 ? '' : 's'}`;
const monthYear = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayMonth = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const priced = (rows) => rows.filter((r) => r.value > 0);
const totalValue = (rows) => priced(rows).reduce((sum, r) => sum + r.value, 0);
const averageCost = (r) => r.costBasis / r.shares;

// Whole shares to sell to raise at least `dollars`, never more than the user owns.
function sharesToSell(r, dollars) {
  return Math.min(r.shares, Math.max(1, Math.ceil(dollars / r.currentPrice)));
}

// How long the user has held a row's shares, from purchase dates:
//   { term: 'long' | 'short' | 'mixed' | 'unknown', since, longTermOn }
// 'unknown' when any shares are synced from a brokerage (no purchase dates).
// since: the earliest purchase date; longTermOn: when the newest shares turn a year old.
function holdingPeriod(r, now) {
  const dates = r.holdings.map((h) => h.purchaseDate);
  if (dates.length === 0 || dates.some((d) => !d)) return { term: 'unknown', since: null, longTermOn: null };
  const times = dates.map((d) => Date.parse(`${d}T00:00:00Z`));
  const cutoff = now - LONG_TERM_DAYS * DAY_MS;
  const long = times.filter((t) => t <= cutoff).length;
  const term = long === times.length ? 'long' : long === 0 ? 'short' : 'mixed';
  return {
    term,
    since: dates.slice().sort()[0],
    longTermOn: term === 'long' ? null : Math.max(...times) + (LONG_TERM_DAYS + 1) * DAY_MS,
  };
}

// What a sale realizing `amount` (positive = gain) means for US taxes, in a taxable account.
function taxNote(amount, period) {
  if (amount < 0) {
    return `In a taxable account, that ${money(amount)} loss could offset capital gains, plus up to $3,000 a year of other income (US rules).`;
  }
  if (period.term === 'long') {
    return "You've held all of it for over a year, so in a taxable account that gain would be taxed at the lower long-term capital-gains rate.";
  }
  if (period.term === 'short') {
    return `You've held it for under a year, so in a taxable account that gain would be taxed as ordinary income. After ${dayMonth(period.longTermOn)} it would qualify for the lower long-term rate.`;
  }
  if (period.term === 'mixed') {
    return 'Some of these shares were bought within the last year; in a taxable account, gains on those are taxed at the higher short-term rate.';
  }
  return '';
}

const realized = (r, shares) => shares * (r.currentPrice - averageCost(r));
const describeSale = (r, shares) => {
  const gain = realized(r, shares);
  return `${Math.abs(gain) < 1 ? 'roughly no gain or loss' : `${gain >= 0 ? 'a gain' : 'a loss'} of about ${money(gain)}`}`;
};

// Dollars to put into a broad index fund so the diversification score reaches
// targetScore, given how scorePortfolio counts funds. null if it can't get there.
function fundAmountForScore(rows, profiles, targetScore) {
  const total = totalValue(rows);
  if (total <= 0) return null;
  const weighted = priced(rows).reduce((sum, r) => sum + (r.value ** 2) / (isFund(profiles, r.ticker) ? FUND_SPREAD : 1), 0);
  // The score is shown rounded, so aim for the lowest value that rounds to targetScore.
  const targetHoldings = 1 + ((targetScore - 0.5) / 100) * (WELL_DIVERSIFIED_HOLDINGS - 1);
  const herfindahl = (added) => (weighted + (added ** 2) / FUND_SPREAD) / (total + added) ** 2;
  // herfindahl falls until `best`, then rises again, so search below it.
  const best = (weighted * FUND_SPREAD) / total;
  if (1 / herfindahl(best) < targetHoldings) return null;
  let low = 0;
  let high = best;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (1 / herfindahl(mid) >= targetHoldings) high = mid;
    else low = mid;
  }
  return Math.ceil(high / 100) * 100;
}

const linksFor = (articles) => articles.slice(0, MAX_LINKS)
  .map((n) => ({ headline: n.headline, url: n.url, source: n.source, publishedAt: n.publishedAt }));

const RULES = [
  function lowDiversification({ rows, score, profiles }) {
    if (!score || score.diversificationScore >= 40) return [];
    const total = totalValue(rows);
    const top = priced(rows).sort((a, b) => b.value - a.value).slice(0, 2);
    const topShare = top.reduce((sum, r) => sum + r.value, 0) / total * 100;
    const leaders = top.length === 2
      ? `${top[0].ticker} and ${top[1].ticker} alone are ${pct(topShare)} of it`
      : `${top[0].ticker} is all of it`;
    const amount = fundAmountForScore(rows, profiles, TARGET_SCORE);
    return [{
      id: 'low-diversification',
      severity: 'warning',
      ticker: null,
      title: `Diversification score is ${score.diversificationScore}/100`,
      detail: `Your ${money(total)} is spread like about ${score.effectiveHoldings} equal holdings: ${leaders}. A bad stretch for one company moves your whole portfolio.`,
      action: amount
        ? `Putting about ${money(amount)} into a broad-market index fund (a total-market or S&P 500 fund holds hundreds of companies) would raise your score to about ${TARGET_SCORE}. Adding it gradually, for example monthly, works too.`
        : 'Spread new money across more companies, or a broad-market index fund, rather than adding to your largest holdings.',
      links: [],
    }];
  },

  function concentration({ rows, score, now }) {
    if (!score || priced(rows).length < 2) return []; // one holding: lowDiversification covers it
    const total = totalValue(rows);
    const limit = CONCENTRATION_LIMIT_PERCENT / 100;
    return score.concentratedStocks.map(({ ticker, percent }) => {
      const r = rows.find((x) => x.ticker === ticker);
      const toSell = (r.value - limit * total) / (1 - limit); // sale that leaves it at the limit
      const shares = sharesToSell(r, toSell);
      const toAdd = r.value / limit - total; // new money elsewhere that dilutes it to the limit
      const tax = taxNote(realized(r, shares), holdingPeriod(r, now));
      return {
        id: `concentration:${ticker}`,
        severity: 'warning',
        ticker,
        title: `${ticker} is ${pct(percent)} of your portfolio`,
        detail: `${ticker} is ${money(r.value)} of your ${money(total)}. Above ${CONCENTRATION_LIMIT_PERCENT}%, one stock's ups and downs dominate your results.`,
        action: `To bring it to ${CONCENTRATION_LIMIT_PERCENT}%, you could sell about ${plural(shares, 'share')} of your ${r.shares.toLocaleString('en-US')} (~${money(shares * r.currentPrice)}), which would realize ${describeSale(r, shares)}, or put about ${money(toAdd)} of new money into your other holdings instead. ${tax}`.trim(),
        links: [],
      };
    });
  },

  function largeLosses({ rows, news, now }) {
    return rows
      .filter((r) => r.gainLossPercent !== null && r.gainLossPercent <= LARGE_LOSS_PERCENT)
      .map((r) => {
        const period = holdingPeriod(r, now);
        const held = period.since ? ` You've held it since ${monthYear(period.since)}.` : '';
        const bad = news.filter((n) => n.named.includes(r.ticker) && n.sentiment === 'negative');
        return {
          id: `loss:${r.ticker}`,
          severity: 'warning',
          ticker: r.ticker,
          title: `${r.ticker} is down ${pct(r.gainLossPercent)} from what you paid`,
          detail: `You paid an average of ${price(averageCost(r))} a share; it's ${price(r.currentPrice)} now, an unrealized loss of ${money(r.gainLoss)} on ${plural(r.shares, 'share')}.${held}`,
          action: `A drop alone isn't a reason to sell: check whether your reason for buying ${r.ticker} still holds${bad.length > 0 ? ', starting with the headlines below' : ''}. If you do sell it all, ${taxNote(r.gainLoss, period).replace(/^In a/, 'in a')}`,
          links: linksFor(bad),
        };
      });
  },

  // Funds are left out: they're the diversified part of a portfolio.
  function largeGains({ rows, profiles, now }) {
    const total = totalValue(rows);
    return rows
      .filter((r) => !isFund(profiles, r.ticker) && r.gainLossPercent >= LARGE_GAIN_PERCENT
        && (r.value / total) * 100 >= LARGE_GAIN_MIN_SHARE)
      .map((r) => {
        const shares = sharesToSell(r, r.costBasis); // sell enough to get the original money back
        const sale = shares * r.currentPrice;
        const after = total - sale > 0 ? ((r.value - sale) / (total - sale)) * 100 : 0;
        const tax = taxNote(realized(r, shares), holdingPeriod(r, now));
        return {
          id: `gain:${r.ticker}`,
          severity: 'info',
          ticker: r.ticker,
          title: `${r.ticker} is up ${pct(r.gainLossPercent)} since you bought it`,
          detail: `The ${money(r.costBasis)} you put in is now worth ${money(r.value)}, ${pct((r.value / total) * 100)} of your portfolio.`,
          action: `Selling about ${plural(shares, 'share')} of your ${r.shares.toLocaleString('en-US')} (~${money(sale)}) would take back what you put in, leave the rest invested, and bring ${r.ticker} to ${pct(after)} of your portfolio; that sale would realize ${describeSale(r, shares)}. ${tax}`.trim(),
          links: [],
        };
      });
  },

  // Counts only articles that name the holding, from the last week. A trend needs
  // enough coverage, at least a third of it leaning one way, and twice as much
  // leaning that way as the other ("2 positive of 17" is not upbeat news).
  function newsTrends({ rows, news, now }) {
    const insights = [];
    for (const { ticker } of rows) {
      const recent = news.filter((n) => n.named.includes(ticker)
        && now - Date.parse(n.publishedAt) <= NEWS_WINDOW_DAYS * DAY_MS);
      const negative = recent.filter((n) => n.sentiment === 'negative');
      const positive = recent.filter((n) => n.sentiment === 'positive');
      const leans = (count, other) => recent.length >= MIN_NEWS_FOR_TREND && count >= 2
        && count >= recent.length * MIN_TREND_SHARE && count >= 2 * other;
      const example = (list) => `, for example "${list[0].headline}"${list[0].source ? ` (${list[0].source}, ${shortDate(list[0].publishedAt)})` : ''}`;
      if (leans(negative.length, positive.length)) {
        insights.push({
          id: `news-negative:${ticker}`,
          severity: 'warning',
          ticker,
          title: `Mostly negative news about ${ticker} this week`,
          detail: `${negative.length} of the ${recent.length} headlines naming ${ticker} in the last ${NEWS_WINDOW_DAYS} days read as negative${example(negative)}.`,
          action: `Read them before buying more ${ticker}. If they're about one event (a recall, a lawsuit, a missed earnings estimate), ask whether it changes the company's long-term prospects or just this month's price.`,
          links: linksFor(negative),
        });
      } else if (leans(positive.length, negative.length)) {
        insights.push({
          id: `news-positive:${ticker}`,
          severity: 'positive',
          ticker,
          title: `Upbeat news about ${ticker} this week`,
          detail: `${positive.length} of the ${recent.length} headlines naming ${ticker} in the last ${NEWS_WINDOW_DAYS} days read as positive${example(positive)}.`,
          action: "Good news usually shows up in the price within days, so there's no need to chase it with extra money.",
          links: linksFor(positive),
        });
      }
    }
    return insights;
  },

  function unpricedHoldings({ rows }) {
    const tickers = rows.filter((r) => !(r.value > 0)).map((r) => r.ticker);
    if (tickers.length === 0) return [];
    const list = tickers.length === 1 ? tickers[0] : `${tickers.slice(0, -1).join(', ')} and ${tickers.at(-1)}`;
    return [{
      id: 'unpriced',
      severity: 'info',
      ticker: tickers.length === 1 ? tickers[0] : null,
      title: `No market price for ${list}`,
      detail: `${tickers.length === 1 ? "It's" : "They're"} left out of your total value, allocation and scores.`,
      action: `Check that the ticker symbol is right (for example on your brokerage statement). Delisted or very new tickers may not be priced.`,
      links: [],
    }];
  },
];

const SEVERITY_ORDER = { warning: 0, info: 1, positive: 2 };

// context: { rows, summary, score, news, profiles, now }; news is the output of
// matchNewsToHoldings. Returns insights, warnings first. A well-diversified
// portfolio with nothing to warn about says so, so an empty list never looks like a failure.
function generateInsights({ rows, summary = null, score = null, news = [], profiles = new Map(), now = Date.now() }) {
  if (rows.length === 0) return [];
  const insights = RULES.flatMap((rule) => rule({ rows, summary, score, news, profiles, now }));
  if (score && score.riskLabel === 'Low' && !insights.some((i) => i.severity === 'warning')) {
    const largest = score.largestStock;
    insights.push({
      id: 'well-diversified',
      severity: 'positive',
      ticker: null,
      title: 'Your portfolio is well diversified',
      detail: `Diversification score ${score.diversificationScore}/100${largest ? `; your largest single stock, ${largest.ticker}, is ${pct(largest.percent)}` : ', and most of it is in funds'}.`,
      action: `Keep it that way: once a year, check whether any stock has grown past ${CONCENTRATION_LIMIT_PERCENT}%, and spread new money across your holdings.`,
      links: [],
    });
  }
  return insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

module.exports = {
  scorePortfolio,
  headlineSentiment,
  coreName,
  companyKeywords,
  identifyRelevantTopics,
  matchNewsToHoldings,
  topNews,
  generateInsights,
};
