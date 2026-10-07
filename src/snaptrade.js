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

// One SnapTrade position -> { accountId, ticker, shares, averagePrice, price }, or null to skip it.
// SnapTrade sends amounts as strings; cost_basis is the average price per share and
// price is the brokerage's last known market price per share (null if not provided).
function toPosition(raw, accountId) {
  const { instrument } = raw;
  if (!instrument || !SUPPORTED_KINDS.has(instrument.kind) || raw.cash_equivalent) return null;
  if (raw.currency && raw.currency !== 'USD') return null;

  const ticker = String(instrument.raw_symbol || instrument.symbol || '').toUpperCase();
  const shares = Number(raw.units);
  const averagePrice = Number(raw.cost_basis);
  if (!ticker || !(shares > 0) || !(averagePrice > 0)) return null;

  const price = Number(raw.price);
  return { accountId, ticker, shares, averagePrice, price: price > 0 ? price : null };
}

// One SnapTrade activity -> { accountId, ticker, shares, price, date }, or null to skip it.
// BUY and REI (dividend reinvestment) both add shares at a price.
function toBuy(raw, accountId) {
  if (!['BUY', 'REI'].includes(raw.type)) return null;
  const ticker = String(raw.symbol?.raw_symbol || raw.symbol?.symbol || '').toUpperCase();
  const shares = Number(raw.units);
  const price = Number(raw.price);
  const date = String(raw.trade_date || raw.settlement_date || '').slice(0, 10);
  const currency = raw.currency?.code;
  if (!ticker || !(shares > 0) || !(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (currency && currency !== 'USD') return null;
  return { accountId, ticker, shares, price, date };
}

const ACTIVITY_PAGE_SIZE = 1000;

async function fetchBuys(auth, accountId) {
  const buys = [];
  for (let offset = 0; ; offset += ACTIVITY_PAGE_SIZE) {
    const page = await call(() => getClient().accountInformation.getAccountActivities({
      ...auth, accountId, type: 'BUY,REI', offset, limit: ACTIVITY_PAGE_SIZE,
    }));
    const rows = page.data || [];
    for (const raw of rows) {
      const buy = toBuy(raw, accountId);
      if (buy) buys.push(buy);
    }
    const total = page.pagination?.total ?? rows.length;
    if (rows.length === 0 || offset + rows.length >= total) return buys;
  }
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
  const buys = [];
  for (const account of accounts) {
    const { results = [] } = await call(() =>
      getClient().accountInformation.getAllAccountPositions({ ...auth, accountId: account.id }));
    for (const raw of results) {
      const position = toPosition(raw, account.id);
      if (position) positions.push(position);
    }
    // Purchase history is a nice-to-have: if the brokerage won't provide it, keep the sync.
    try {
      buys.push(...await fetchBuys(auth, account.id));
    } catch (err) {
      console.warn(`Skipping purchase history for ${account.name}: ${err.message}`);
    }
  }
  return { accounts, positions, buys };
}

// Deletes every brokerage connection for this user at SnapTrade, which revokes
// SnapTrade's access to those brokerage accounts. Returns how many were removed.
async function disconnectAll(user) {
  const auth = { userId: user.userId, userSecret: user.userSecret };
  const connections = await call(() => getClient().connections.listBrokerageAuthorizations(auth));
  for (const c of connections) {
    await call(() => getClient().connections.deleteConnection({ ...auth, connectionId: c.id }));
  }
  return connections.length;
}

module.exports = {
  isConfigured,
  registerUser,
  getConnectionUrl,
  fetchAccountsAndPositions,
  disconnectAll,
  toPosition,
  toBuy,
  setClientForTests,
  BrokerageApiError,
};
