const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';
const { closeDb } = require('../src/data.js');
const snaptrade = require('../src/snaptrade.js');
const service = require('../src/service.js');

// Stands in for the SnapTrade SDK; SDK calls resolve to { data }.
function fakeClient({ accounts = [], positionsByAccount = {} } = {}) {
  const calls = { register: 0, login: [] };
  const ok = (data) => Promise.resolve({ data });
  return {
    calls,
    authentication: {
      registerSnapTradeUser: ({ userId }) => { calls.register++; return ok({ userId, userSecret: 'secret-1' }); },
      loginSnapTradeUser: (params) => { calls.login.push(params); return ok({ redirectURI: 'https://portal.example/abc' }); },
    },
    accountInformation: {
      listUserAccounts: () => ok(accounts),
      getAllAccountPositions: ({ accountId }) => ok({ results: positionsByAccount[accountId] || [] }),
    },
  };
}

const stock = (symbol, units, costBasis) => ({
  instrument: { kind: 'stock', symbol, raw_symbol: symbol },
  units: String(units),
  cost_basis: String(costBasis),
  currency: 'USD',
});

function configure(on) {
  process.env.SNAPTRADE_CLIENT_ID = on ? 'test-client' : '';
  process.env.SNAPTRADE_CONSUMER_KEY = on ? 'test-key' : '';
}

beforeEach(() => {
  closeDb();
  configure(true);
});

test('reports brokerage as not configured when keys are missing', async () => {
  configure(false);
  assert.strictEqual(service.getPortfolio().brokerageConfigured, false);
  await assert.rejects(service.startBrokerageConnection('http://x'), service.NotConfiguredError);
  await assert.rejects(service.syncBrokerage(), service.NotConfiguredError);
});

test('first connect registers a SnapTrade user; later connects reuse it', async () => {
  const fake = fakeClient();
  snaptrade.setClientForTests(fake);

  const url = await service.startBrokerageConnection('http://localhost:3000/portfolio.html?brokerage=connected');
  assert.strictEqual(url, 'https://portal.example/abc');
  await service.startBrokerageConnection('http://localhost:3000/back');

  assert.strictEqual(fake.calls.register, 1);
  assert.strictEqual(fake.calls.login[0].connectionType, 'read');
  assert.strictEqual(fake.calls.login[0].customRedirect, 'http://localhost:3000/portfolio.html?brokerage=connected');
  assert.strictEqual(fake.calls.login[1].userId, fake.calls.login[0].userId);
});

test('sync before any connection is rejected', async () => {
  snaptrade.setClientForTests(fakeClient());
  await assert.rejects(service.syncBrokerage(), service.NotConnectedError);
});

test('sync stores positions and merges them with manual holdings of the same ticker', async () => {
  snaptrade.setClientForTests(fakeClient({
    accounts: [{ id: 'acc-1', name: 'Robinhood Individual', institution_name: 'Robinhood' }],
    positionsByAccount: { 'acc-1': [stock('AAPL', 5, 120), stock('MSFT', 2, 300)] },
  }));
  service.addHolding({ ticker: 'AAPL', shares: '10', purchasePrice: '100', purchaseDate: '2024-01-15' });
  await service.startBrokerageConnection('http://x');

  const { rows, summary } = await service.syncBrokerage();
  const aapl = rows.find((r) => r.ticker === 'AAPL');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(aapl.shares, 15);
  assert.strictEqual(aapl.costBasis, 10 * 100 + 5 * 120);
  assert.deepStrictEqual(aapl.purchases.map((p) => p.source ?? 'manual'), ['manual', 'Robinhood Individual']);
  assert.strictEqual(summary.accountsConnected, 1);
});

test('re-sync replaces old positions instead of duplicating them, and keeps manual holdings', async () => {
  const fake = fakeClient({
    accounts: [{ id: 'acc-1', name: 'Schwab Brokerage', institution_name: 'Schwab' }],
    positionsByAccount: { 'acc-1': [stock('VTI', 4, 200)] },
  });
  snaptrade.setClientForTests(fake);
  service.addHolding({ ticker: 'AAPL', shares: '1', purchasePrice: '100', purchaseDate: '2024-01-15' });
  await service.startBrokerageConnection('http://x');
  await service.syncBrokerage();

  fake.accountInformation.getAllAccountPositions = () => Promise.resolve({ data: { results: [stock('VTI', 6, 210)] } });
  const { rows, summary } = await service.syncBrokerage();

  assert.deepStrictEqual(rows.map((r) => [r.ticker, r.shares]), [['AAPL', 1], ['VTI', 6]]);
  assert.strictEqual(summary.accountsConnected, 1);
});

test('SnapTrade failures surface as BrokerageApiError with the reason', async () => {
  const fake = fakeClient();
  fake.accountInformation.listUserAccounts = () => Promise.reject(Object.assign(new Error('401'), { responseBody: { detail: 'Invalid signature' } }));
  snaptrade.setClientForTests(fake);
  await service.startBrokerageConnection('http://x');
  await assert.rejects(service.syncBrokerage(), (err) =>
    err instanceof service.BrokerageApiError && /Invalid signature/.test(err.message));
});
