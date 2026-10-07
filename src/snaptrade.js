// Data tier (external API client): the only file that reads the SnapTrade keys
// and talks to SnapTrade. Converts SnapTrade's data into Folio's shape.

const { Snaptrade, SnaptradeAuth } = require('snaptrade-typescript-sdk');

// Instrument kinds Folio can show as holdings; options, crypto, etc. are skipped for now.
const SUPPORTED_KINDS = new Set(['stock', 'etf', 'mutualfund']);

// SnapTrade itself failed (bad keys, brokerage down, ...). The server reports these as 502.
class BrokerageApiError extends Error {}

let client = null;

function isConfigured() {
  return Boolean(process.env.SNAPTRADE_CLIENT_ID && process.env.SNAPTRADE_CONSUMER_KEY);
}

function getClient() {
  if (!client) {
    client = new Snaptrade({
      auth: SnaptradeAuth.commercialApiKey({
        clientId: process.env.SNAPTRADE_CLIENT_ID,
        consumerKey: process.env.SNAPTRADE_CONSUMER_KEY,
      }),
    });
  }
  return client;
}

function setClientForTests(fake) {
  client = fake;
}

// Turns an SDK error into a readable message for the UI.
async function call(request) {
  try {
    return (await request()).data;
  } catch (err) {
    const detail = err.responseBody?.detail || err.responseBody?.message || err.message;
    throw new BrokerageApiError(`SnapTrade request failed: ${detail}`);
  }
}

async function registerUser(snaptradeUserId) {
  const { userId, userSecret } = await call(() =>
    getClient().authentication.registerSnapTradeUser({ userId: snaptradeUserId }));
  return { userId, userSecret };
}

// Returns a Connection Portal URL. It expires in 5 minutes, so create it only when the user clicks.
async function getConnectionUrl(user, redirectUrl) {
  const data = await call(() => getClient().authentication.loginSnapTradeUser({
    userId: user.userId,
    userSecret: user.userSecret,
    customRedirect: redirectUrl,
    connectionType: 'read',
  }));
  if (!data.redirectURI) throw new BrokerageApiError('SnapTrade did not return a connection link.');
  return data.redirectURI;
}

// One SnapTrade position -> { accountId, ticker, shares, averagePrice }, or null to skip it.
// SnapTrade sends amounts as strings; cost_basis is the average price per share.
function toPosition(raw, accountId) {
  const { instrument } = raw;
  if (!instrument || !SUPPORTED_KINDS.has(instrument.kind) || raw.cash_equivalent) return null;
  if (raw.currency && raw.currency !== 'USD') return null;

  const ticker = String(instrument.raw_symbol || instrument.symbol || '').toUpperCase();
  const shares = Number(raw.units);
  const averagePrice = Number(raw.cost_basis);
  if (!ticker || !(shares > 0) || !(averagePrice > 0)) return null;

  return { accountId, ticker, shares, averagePrice };
}

async function fetchAccountsAndPositions(user) {
  const auth = { userId: user.userId, userSecret: user.userSecret };
  const rawAccounts = await call(() => getClient().accountInformation.listUserAccounts(auth));

  const accounts = rawAccounts.map((a) => ({
    id: a.id,
    name: a.name || a.institution_name,
    institution: a.institution_name,
  }));
  const positions = [];
  for (const account of accounts) {
    const { results = [] } = await call(() =>
      getClient().accountInformation.getAllAccountPositions({ ...auth, accountId: account.id }));
    for (const raw of results) {
      const position = toPosition(raw, account.id);
      if (position) positions.push(position);
    }
  }
  return { accounts, positions };
}

module.exports = {
  isConfigured,
  registerUser,
  getConnectionUrl,
  fetchAccountsAndPositions,
  toPosition,
  setClientForTests,
  BrokerageApiError,
};
