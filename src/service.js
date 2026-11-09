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

// Every function below works on one user's portfolio, given as userId (an account
// id from auth.js, as a string). 'local' owns data saved before accounts existed,
// and is the default so tests and scripts can leave it out; the first account
// created takes that data over (data.claimLocalData).
const APP_USER_ID = 'local';

// Per user, the quotes from their latest refreshPrices():
// userId -> Map<ticker, { price, asOf, source, name?, assetType? }>.
const latestQuotes = new Map();
const quotesFor = (userId) => latestQuotes.get(userId) ?? new Map();

// Per user, the message from their last SnapTrade failure, shown on the page until
// a SnapTrade request works again. Everything else in Folio keeps working meanwhile.
const brokerageIssues = new Map();

// Runs a SnapTrade request, remembering whether SnapTrade is currently failing.
async function brokerage(userId, request) {
  try {
    const result = await request();
    brokerageIssues.delete(userId);
    return result;
  } catch (err) {
    if (err instanceof snaptrade.BrokerageApiError) brokerageIssues.set(userId, err.message);
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
function addHolding(input, userId = APP_USER_ID) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length === 0) data.saveHolding(holding, userId);
  return { errors };
}

// Same rules as adding. Returns { errors }; throws NotFoundError for an unknown id.
function updateHolding(id, input, userId = APP_USER_ID) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length > 0) return { errors };
  if (!data.updateHolding(id, holding, userId)) throw new NotFoundError();
  return { errors };
}

function removeHolding(id, userId = APP_USER_ID) {
  if (!data.deleteHolding(id, userId)) throw new NotFoundError();
}

// Edits and removals of synced holdings are saved as the user's own changes;
// the brokerage's data underneath is untouched. A later sync asks the user
// which to keep if the two disagree.
function editBrokeragePosition(id, input, userId = APP_USER_ID) {
  const position = data.getBrokeragePosition(userId, id);
  if (!position) throw new NotFoundError();
  const { values, errors } = validatePositionEdit(input);
  if (Object.keys(errors).length > 0) return { errors };
  data.saveOverride(userId, { accountId: position.accountId, ticker: position.ticker, action: 'edit', ...values });
  return { errors };
}

function removeBrokeragePosition(id, userId = APP_USER_ID) {
  const position = data.getBrokeragePosition(userId, id);
  if (!position) throw new NotFoundError();
  data.saveOverride(userId, { accountId: position.accountId, ticker: position.ticker, action: 'remove' });
}

// keepMine: true keeps the user's changes; false discards the ones the brokerage
// disagrees with, restoring the brokerage's numbers (and removed holdings).
function resolveSyncConflicts(keepMine, userId = APP_USER_ID) {
  if (!keepMine) {
    const { conflicts } = findConflicts(data.loadBrokeragePositions(userId), data.loadOverrides(userId));
    data.deleteOverrides(userId, conflicts);
  }
  return getPortfolio(userId);
}

// Fetches live prices for every ticker the user holds. Never throws: tickers that
// can't be priced fall back to the brokerage's price, or show no price.
// fresh: true skips the price cache (the "Refresh prices" button).
async function refreshPrices({ fresh = false, userId = APP_USER_ID } = {}) {
  const tickers = [
    ...data.loadHoldings(userId).map((h) => h.ticker),
    ...data.loadBrokeragePositions(userId).map((p) => p.ticker),
  ];
  latestQuotes.set(userId, await prices.getQuotes(tickers, { fresh }));
}

// What the price source told us about each ticker: Map<ticker, { name, assetType }>.
// Lets the Domain tell funds from single stocks and find company names in news.
function profiles(userId) {
  return new Map([...quotesFor(userId)].map(([ticker, q]) => [ticker, { name: q.name ?? null, assetType: q.assetType ?? null }]));
}

function getPortfolio(userId = APP_USER_ID) {
  const quotes = quotesFor(userId);
  const livePrice = (ticker) => quotes.get(ticker.toUpperCase())?.price ?? null;
  const manual = data.loadHoldings(userId).map((h) => ({ ...h, kind: 'manual', currentPrice: livePrice(h.ticker) }));
  // Synced positions (with the user's changes applied) become undated purchases at
  // their average cost, labeled with their account. A live price beats the
  // brokerage's last price.
  const positions = applyOverrides(data.loadBrokeragePositions(userId), data.loadOverrides(userId));
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
  const buys = data.loadBrokerageBuys(userId).map((b) => ({
    ticker: b.ticker,
    shares: b.shares,
    purchasePrice: b.price,
    purchaseDate: b.date,
    source: b.accountName,
  }));
  const rows = consolidateHoldings([...manual, ...synced], buys);
  // Oldest live quote shown, so the page can say "Prices as of ...".
  const asOfs = rows.map((r) => quotes.get(r.ticker)?.asOf).filter(Boolean).sort();
  return {
    rows,
    pricesAsOf: asOfs[0] ?? null,
    summary: { ...summarizePortfolio(rows), accountsConnected: data.countBrokerageAccounts(userId) },
    allocation: allocatePortfolio(rows),
    score: scorePortfolio(rows, profiles(userId)),
    brokerageConfigured: snaptrade.isConfigured(),
    brokerageIssue: brokerageIssues.get(userId) ?? null,
  };
}

// Recommendations for the current portfolio (UC4): the risk score, rule-based
// insights, and the news about what the user owns. Uses the latest prices, so call
// refreshPrices() first. Never throws for news problems: if no news source answers,
// the insights that don't need news are still returned, with newsIssue explaining.
// fresh: true skips the news cache.
async function getRecommendations({ fresh = false, now = Date.now(), userId = APP_USER_ID } = {}) {
  const { rows, summary, score } = getPortfolio(userId);
  const topics = identifyRelevantTopics(rows, profiles(userId));
  const { articles, failed } = topics.length > 0
    ? await news.fetchNews(topics.map((t) => t.ticker), { fresh })
    : { articles: [], failed: [] };
  const matches = matchNewsToHoldings(articles, topics, now);
  const allFailed = topics.length > 0 && failed.length === topics.length;
  return {
    score,
    insights: generateInsights({ rows, summary, score, news: matches, profiles: profiles(userId), now }),
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
async function getAdvice({ fresh = false, now = Date.now(), userId = APP_USER_ID } = {}) {
  const { rows, summary } = getPortfolio(userId);
  const { score, insights, news: shown } = await getRecommendations({ now, userId });
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

  const brief = buildAdvisorBrief({ rows, summary, score, insights, news: shown, profiles: profiles(userId) });
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
async function startBrokerageConnection(redirectUrl, userId = APP_USER_ID) {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  let user = data.getBrokerageUser(userId);
  if (!user) {
    user = await brokerage(userId, () => snaptrade.registerUser(`folio-${crypto.randomUUID()}`));
    data.saveBrokerageUser(userId, user);
  }
  return brokerage(userId, () => snaptrade.getConnectionUrl(user, redirectUrl));
}

async function syncBrokerage(userId = APP_USER_ID) {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  const user = data.getBrokerageUser(userId);
  if (!user) throw new NotConnectedError();
  // If SnapTrade fails here, nothing is replaced: the last synced holdings stay.
  const { accounts, positions, buys } = await brokerage(userId, () => snaptrade.fetchAccountsAndPositions(user));
  data.replaceBrokerageData(userId, accounts, positions, buys);

  // Holdings the user hasn't changed are now up to date. For the ones they have,
  // quietly drop changes that no longer matter and report the rest as conflicts.
  const { conflicts, settled } = findConflicts(data.loadBrokeragePositions(userId), data.loadOverrides(userId));
  data.deleteOverrides(userId, settled);
  return { ...getPortfolio(userId), conflicts };
}

// Revokes SnapTrade's access to every connected brokerage and removes synced
// holdings from Folio. Manual holdings are kept.
async function disconnectBrokerage(userId = APP_USER_ID) {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  const user = data.getBrokerageUser(userId);
  if (user) await brokerage(userId, () => snaptrade.disconnectAll(user));
  data.replaceBrokerageData(userId, [], []);
  data.deleteOverrides(userId);
  return getPortfolio(userId);
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
