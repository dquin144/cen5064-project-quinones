// Service tier: orchestrates user actions — asks Domain to decide, Data to store,
// the SnapTrade client to talk to brokerages, the price client for market prices,
// the news client for news about the user's holdings, and the Claude client for
// the written summary and AI recommendations.

const crypto = require('node:crypto');
const {
  validateHolding,
  validatePositionEdit,
  applyOverrides,
  findConflicts,
  consolidateHoldings,
  summarizePortfolio,
  allocatePortfolio,
} = require('./domain');
const {
  scorePortfolio,
  identifyRelevantTopics,
  matchNewsToHoldings,
  topNews,
  generateInsights,
} = require('./insights');
const { buildAdvisorBrief, validateAdvice, fallbackAdvice } = require('./advice');
const data = require('./data');
const snaptrade = require('./snaptrade');
const prices = require('./prices');
const news = require('./news');
const claude = require('./claude');

// Single built-in user until real login exists.
const APP_USER_ID = 'local';

// Latest live quotes (ticker -> { price, asOf, source }), filled by refreshPrices().
let latestQuotes = new Map();

// Message from the last SnapTrade failure, shown on the page until a SnapTrade
// request works again. Everything else in Folio keeps working meanwhile.
let brokerageIssue = null;

// Runs a SnapTrade request, remembering whether SnapTrade is currently failing.
async function brokerage(request) {
  try {
    const result = await request();
    brokerageIssue = null;
    return result;
  } catch (err) {
    if (err instanceof snaptrade.BrokerageApiError) brokerageIssue = err.message;
    throw err;
  }
}

// Hands the app's config to the Data-tier modules that need it. Called once by
// server.js at startup.
function configure(config) {
  data.configure(config);
  prices.configure(config);
  news.configure(config);
  claude.configure(config);
  snaptrade.configure(config);
}

class NotConfiguredError extends Error {
  constructor() {
    super("Brokerage connection isn't set up. Add SnapTrade keys to .env and restart the server.");
  }
}
class NotConnectedError extends Error {
  constructor() {
    super('No brokerage connected yet. Use "Connect brokerage" first.');
  }
}
class NotFoundError extends Error {
  constructor() {
    super('That holding no longer exists. The list has been refreshed.');
  }
}

// Returns { errors }. An empty errors object means the holding was saved.
function addHolding(input) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length === 0) data.saveHolding(holding);
  return { errors };
}

// Same rules as adding. Returns { errors }; throws NotFoundError for an unknown id.
function updateHolding(id, input) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length > 0) return { errors };
  if (!data.updateHolding(id, holding)) throw new NotFoundError();
  return { errors };
}

function removeHolding(id) {
  if (!data.deleteHolding(id)) throw new NotFoundError();
}

// Edits and removals of synced holdings are saved as the user's own changes;
// the brokerage's data underneath is untouched. A later sync asks the user
// which to keep if the two disagree.
function editBrokeragePosition(id, input) {
  const position = data.getBrokeragePosition(APP_USER_ID, id);
  if (!position) throw new NotFoundError();
  const { values, errors } = validatePositionEdit(input);
  if (Object.keys(errors).length > 0) return { errors };
  data.saveOverride(APP_USER_ID, { accountId: position.accountId, ticker: position.ticker, action: 'edit', ...values });
  return { errors };
}

function removeBrokeragePosition(id) {
  const position = data.getBrokeragePosition(APP_USER_ID, id);
  if (!position) throw new NotFoundError();
  data.saveOverride(APP_USER_ID, { accountId: position.accountId, ticker: position.ticker, action: 'remove' });
}

// keepMine: true keeps the user's changes; false discards the ones the brokerage
// disagrees with, restoring the brokerage's numbers (and removed holdings).
function resolveSyncConflicts(keepMine) {
  if (!keepMine) {
    const { conflicts } = findConflicts(data.loadBrokeragePositions(APP_USER_ID), data.loadOverrides(APP_USER_ID));
    data.deleteOverrides(APP_USER_ID, conflicts);
  }
  return getPortfolio();
}

// Fetches live prices for every ticker the user holds. Never throws: tickers that
// can't be priced fall back to the brokerage's price, or show no price.
// fresh: true skips the price cache (the "Refresh prices" button).
async function refreshPrices({ fresh = false } = {}) {
  const tickers = [
    ...data.loadHoldings().map((h) => h.ticker),
    ...data.loadBrokeragePositions(APP_USER_ID).map((p) => p.ticker),
  ];
  latestQuotes = await prices.getQuotes(tickers, { fresh });
}

// What the price source told us about each ticker: Map<ticker, { name, assetType }>.
// Lets the Domain tell funds from single stocks and find company names in news.
function profiles() {
  return new Map([...latestQuotes].map(([ticker, q]) => [ticker, { name: q.name ?? null, assetType: q.assetType ?? null }]));
}

function getPortfolio() {
  const livePrice = (ticker) => latestQuotes.get(ticker.toUpperCase())?.price ?? null;
  const manual = data.loadHoldings().map((h) => ({ ...h, kind: 'manual', currentPrice: livePrice(h.ticker) }));
  // Synced positions (with the user's changes applied) become undated purchases at
  // their average cost, labeled with their account. A live price beats the
  // brokerage's last price.
  const positions = applyOverrides(data.loadBrokeragePositions(APP_USER_ID), data.loadOverrides(APP_USER_ID));
  const synced = positions.map((p) => ({
    id: p.id,
    kind: 'synced',
    edited: Boolean(p.edited),
    ticker: p.ticker,
    shares: p.shares,
    purchasePrice: p.averagePrice,
    purchaseDate: null,
    source: p.accountName,
    currentPrice: livePrice(p.ticker) ?? p.price,
  }));
  const buys = data.loadBrokerageBuys(APP_USER_ID).map((b) => ({
    ticker: b.ticker,
    shares: b.shares,
    purchasePrice: b.price,
    purchaseDate: b.date,
    source: b.accountName,
  }));
  const rows = consolidateHoldings([...manual, ...synced], buys);
  // Oldest live quote shown, so the page can say "Prices as of ...".
  const asOfs = rows.map((r) => latestQuotes.get(r.ticker)?.asOf).filter(Boolean).sort();
  return {
    rows,
    pricesAsOf: asOfs[0] ?? null,
    summary: { ...summarizePortfolio(rows), accountsConnected: data.countBrokerageAccounts(APP_USER_ID) },
    allocation: allocatePortfolio(rows),
    score: scorePortfolio(rows, profiles()),
    brokerageConfigured: snaptrade.isConfigured(),
    brokerageIssue,
  };
}

// Recommendations for the current portfolio (UC4): the risk score, rule-based
// insights, and the news about what the user owns. Uses the latest prices, so call
// refreshPrices() first. Never throws for news problems: if no news source answers,
// the insights that don't need news are still returned, with newsIssue explaining.
// fresh: true skips the news cache.
async function getRecommendations({ fresh = false, now = Date.now() } = {}) {
  const { rows, summary, score } = getPortfolio();
  const topics = identifyRelevantTopics(rows, profiles());
  const { articles, failed } = topics.length > 0
    ? await news.fetchNews(topics.map((t) => t.ticker), { fresh })
    : { articles: [], failed: [] };
  const matches = matchNewsToHoldings(articles, topics, now);
  const allFailed = topics.length > 0 && failed.length === topics.length;
  return {
    score,
    insights: generateInsights({ rows, summary, score, news: matches, profiles: profiles(), now }),
    news: topNews(matches),
    newsIssue: allFailed ? "Couldn't load news right now. The suggestions below are based on your holdings only." : null,
  };
}

// The written summary of the portfolio and Claude's recommendations: a few specific
// moves built from Folio's findings, each saying which findings it uses (basedOn).
// Claude writes them when ANTHROPIC_API_KEY is set, and Folio checks every number
// in them against the facts it gave Claude. Without a key, or if Claude fails, the
// summary is written from the rules and recommendations is empty (the page then
// shows Folio's findings as the recommendations), with aiIssue saying why. Returns
//   { summary, recommendations, dropped, source: 'claude' | 'rules', model,
//     generatedAt, aiConfigured, aiIssue }
// fresh: true asks Claude for a new answer instead of the cached one.
async function getAdvice({ fresh = false, now = Date.now() } = {}) {
  const { rows, summary } = getPortfolio();
  const { score, insights, news: shown } = await getRecommendations({ now });
  const rulesOnly = fallbackAdvice({ rows, summary, score, insights });
  const fromRules = (aiIssue) => ({
    ...rulesOnly,
    dropped: 0,
    source: 'rules',
    model: null,
    generatedAt: null,
    aiConfigured: claude.isConfigured(),
    aiIssue,
  });
  if (rows.length === 0 || !claude.isConfigured()) return fromRules(null);

  const brief = buildAdvisorBrief({ rows, summary, score, insights, news: shown, profiles: profiles() });
  try {
    const { advice, model, generatedAt } = await claude.generateAdvice(brief, { fresh });
    const checked = validateAdvice(advice, {
      brief,
      heldTickers: rows.map((r) => r.ticker),
      insightIds: insights.map((i) => i.id),
    });
    if (!checked) return fromRules("Claude's answer didn't pass Folio's checks, so these come from the rules.");
    return {
      summary: checked.summary ?? rulesOnly.summary, // a summary with unverifiable numbers is replaced
      recommendations: checked.recommendations,
      dropped: checked.dropped,
      source: 'claude',
      model,
      generatedAt,
      aiConfigured: true,
      aiIssue: null,
    };
  } catch (err) {
    if (!(err instanceof claude.AdvisorError)) throw err;
    console.warn(`Claude (${err.reason}): ${err.message}`);
    return fromRules(err.message);
  }
}

// Returns the SnapTrade Connection Portal URL to send the user to.
async function startBrokerageConnection(redirectUrl) {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  let user = data.getBrokerageUser(APP_USER_ID);
  if (!user) {
    user = await brokerage(() => snaptrade.registerUser(`folio-${crypto.randomUUID()}`));
    data.saveBrokerageUser(APP_USER_ID, user);
  }
  return brokerage(() => snaptrade.getConnectionUrl(user, redirectUrl));
}

async function syncBrokerage() {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  const user = data.getBrokerageUser(APP_USER_ID);
  if (!user) throw new NotConnectedError();
  // If SnapTrade fails here, nothing is replaced: the last synced holdings stay.
  const { accounts, positions, buys } = await brokerage(() => snaptrade.fetchAccountsAndPositions(user));
  data.replaceBrokerageData(APP_USER_ID, accounts, positions, buys);

  // Holdings the user hasn't changed are now up to date. For the ones they have,
  // quietly drop changes that no longer matter and report the rest as conflicts.
  const { conflicts, settled } = findConflicts(data.loadBrokeragePositions(APP_USER_ID), data.loadOverrides(APP_USER_ID));
  data.deleteOverrides(APP_USER_ID, settled);
  return { ...getPortfolio(), conflicts };
}

// Revokes SnapTrade's access to every connected brokerage and removes synced
// holdings from Folio. Manual holdings are kept.
async function disconnectBrokerage() {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  const user = data.getBrokerageUser(APP_USER_ID);
  if (user) await brokerage(() => snaptrade.disconnectAll(user));
  data.replaceBrokerageData(APP_USER_ID, [], []);
  data.deleteOverrides(APP_USER_ID);
  return getPortfolio();
}

module.exports = {
  configure,
  addHolding,
  updateHolding,
  removeHolding,
  editBrokeragePosition,
  removeBrokeragePosition,
  resolveSyncConflicts,
  refreshPrices,
  getPortfolio,
  getRecommendations,
  getAdvice,
  startBrokerageConnection,
  syncBrokerage,
  disconnectBrokerage,
  NotConfiguredError,
  NotConnectedError,
  NotFoundError,
  BrokerageApiError: snaptrade.BrokerageApiError,
};
