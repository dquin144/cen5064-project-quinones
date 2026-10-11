// Service tier: orchestrates user actions — asks Domain to decide, Data to store,
// and the SnapTrade client to talk to brokerages.

const crypto = require('node:crypto');
const { validateHolding, consolidateHoldings, summarizePortfolio } = require('./domain');
const data = require('./data');
const snaptrade = require('./snaptrade');

// Single built-in user until real login exists.
const APP_USER_ID = 'local';

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

// Returns { errors }. An empty errors object means the holding was saved.
function addHolding(input) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length === 0) data.saveHolding(holding);
  return { errors };
}

function getPortfolio() {
  // Synced positions become undated purchases at their average cost, labeled with their account.
  const synced = data.loadBrokeragePositions(APP_USER_ID).map((p) => ({
    ticker: p.ticker,
    shares: p.shares,
    purchasePrice: p.averagePrice,
    purchaseDate: null,
    source: p.accountName,
    currentPrice: p.price,
  }));
  const buys = data.loadBrokerageBuys(APP_USER_ID).map((b) => ({
    ticker: b.ticker,
    shares: b.shares,
    purchasePrice: b.price,
    purchaseDate: b.date,
    source: b.accountName,
  }));
  const rows = consolidateHoldings([...data.loadHoldings(), ...synced], buys);
  return {
    rows,
    summary: { ...summarizePortfolio(rows), accountsConnected: data.countBrokerageAccounts(APP_USER_ID) },
    brokerageConfigured: snaptrade.isConfigured(),
  };
}

// Returns the SnapTrade Connection Portal URL to send the user to.
async function startBrokerageConnection(redirectUrl) {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  let user = data.getBrokerageUser(APP_USER_ID);
  if (!user) {
    user = await snaptrade.registerUser(`folio-${crypto.randomUUID()}`);
    data.saveBrokerageUser(APP_USER_ID, user);
  }
  return snaptrade.getConnectionUrl(user, redirectUrl);
}

async function syncBrokerage() {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  const user = data.getBrokerageUser(APP_USER_ID);
  if (!user) throw new NotConnectedError();
  const { accounts, positions, buys } = await snaptrade.fetchAccountsAndPositions(user);
  data.replaceBrokerageData(APP_USER_ID, accounts, positions, buys);
  return getPortfolio();
}

// Revokes SnapTrade's access to every connected brokerage and removes synced
// holdings from Folio. Manual holdings are kept.
async function disconnectBrokerage() {
  if (!snaptrade.isConfigured()) throw new NotConfiguredError();
  const user = data.getBrokerageUser(APP_USER_ID);
  if (user) await snaptrade.disconnectAll(user);
  data.replaceBrokerageData(APP_USER_ID, [], []);
  return getPortfolio();
}

module.exports = {
  addHolding,
  getPortfolio,
  startBrokerageConnection,
  syncBrokerage,
  disconnectBrokerage,
  NotConfiguredError,
  NotConnectedError,
  BrokerageApiError: snaptrade.BrokerageApiError,
};
