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
  }));
  const rows = consolidateHoldings([...data.loadHoldings(), ...synced]);
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
  const { accounts, positions } = await snaptrade.fetchAccountsAndPositions(user);
  data.replaceBrokerageData(APP_USER_ID, accounts, positions);
  return getPortfolio();
}

module.exports = {
  addHolding,
  getPortfolio,
  startBrokerageConnection,
  syncBrokerage,
  NotConfiguredError,
  NotConnectedError,
  BrokerageApiError: snaptrade.BrokerageApiError,
};
