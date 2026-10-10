// Service tier: orchestrates user actions — asks Domain to decide, Data to store,
// and the SnapTrade client to talk to brokerages.

const crypto = require('node:crypto');
const {
  validateHolding,
  validatePositionEdit,
  applyOverrides,
  findConflicts,
  consolidateHoldings,
  summarizePortfolio,
} = require('./domain');
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

function getPortfolio() {
  const manual = data.loadHoldings().map((h) => ({ ...h, kind: 'manual' }));
  // Synced positions (with the user's changes applied) become undated purchases at
  // their average cost, labeled with their account.
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
    currentPrice: p.price,
  }));
  const buys = data.loadBrokerageBuys(APP_USER_ID).map((b) => ({
    ticker: b.ticker,
    shares: b.shares,
    purchasePrice: b.price,
    purchaseDate: b.date,
    source: b.accountName,
  }));
  const rows = consolidateHoldings([...manual, ...synced], buys);
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
  if (user) await snaptrade.disconnectAll(user);
  data.replaceBrokerageData(APP_USER_ID, [], []);
  data.deleteOverrides(APP_USER_ID);
  return getPortfolio();
}

module.exports = {
  addHolding,
  updateHolding,
  removeHolding,
  editBrokeragePosition,
  removeBrokeragePosition,
  resolveSyncConflicts,
  getPortfolio,
  startBrokerageConnection,
  syncBrokerage,
  disconnectBrokerage,
  NotConfiguredError,
  NotConnectedError,
  NotFoundError,
  BrokerageApiError: snaptrade.BrokerageApiError,
};
