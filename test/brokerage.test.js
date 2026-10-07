const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';
const { closeDb } = require('../src/data.js');
const snaptrade = require('../src/snaptrade.js');
const service = require('../src/service.js');

// Stands in for the SnapTrade SDK; SDK calls resolve to { data }.
function fakeClient({ accounts = [], positionsByAccount = {}, buysByAccount = {} } = {}) {
  const calls = { register: 0, login: [], deleted: [] };
  const ok = (data) => Promise.resolve({ data });
  return {
    calls,
    authentication: {
      registerSnapTradeUser: ({ userId }) => { calls.register++; return ok({ userId, userSecret: 'secret-1' }); },
      loginSnapTradeUser: (params) => { calls.login.push(params); return ok({ redirectURI: 'https://portal.example/abc' }); },
    },
    connections: {
      listBrokerageAuthorizations: () => ok([{ id: 'conn-1' }, { id: 'conn-2' }]),
      deleteConnection: ({ connectionId }) => { calls.deleted.push(connectionId); return ok({}); },
    },
    accountInformation: {
      listUserAccounts: () => ok(accounts),
      getAllAccountPositions: ({ accountId }) => ok({ results: positionsByAccount[accountId] || [] }),
      getAccountActivities: ({ accountId }) => {
        const data = buysByAccount[accountId] || [];
        return ok({ data, pagination: { offset: 0, limit: 1000, total: data.length } });
      },
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

test('disconnect deletes every SnapTrade connection and clears synced holdings only', async () => {
  const fake = fakeClient({
    accounts: [{ id: 'acc-1', name: 'E*TRADE Individual', institution_name: 'E*TRADE' }],
    positionsByAccount: { 'acc-1': [stock('VTI', 4, 200)] },
  });
  snaptrade.setClientForTests(fake);
  service.addHolding({ ticker: 'AAPL', shares: '1', purchasePrice: '100', purchaseDate: '2024-01-15' });
  await service.startBrokerageConnection('http://x');
  await service.syncBrokerage();

  const { rows, summary } = await service.disconnectBrokerage();
  assert.deepStrictEqual(fake.calls.deleted, ['conn-1', 'conn-2']);
  assert.deepStrictEqual(rows.map((r) => r.ticker), ['AAPL']);
  assert.strictEqual(summary.accountsConnected, 0);
});

test('synced market price gives the row a value', async () => {
  snaptrade.setClientForTests(fakeClient({
    accounts: [{ id: 'acc-1', name: 'E*TRADE Individual', institution_name: 'E*TRADE' }],
    positionsByAccount: { 'acc-1': [{ ...stock('VTI', 4, 200), price: '250' }] },
  }));
  await service.startBrokerageConnection('http://x');
  const { rows } = await service.syncBrokerage();
  assert.strictEqual(rows[0].value, 1000);
});

const buy = (symbol, units, price, date) =>
  ({ type: 'BUY', symbol: { symbol, raw_symbol: symbol }, units, price, trade_date: date + 'T15:00:00Z' });

test('sync stores buy history; latest buy shows first, cost still uses the average', async () => {
  snaptrade.setClientForTests(fakeClient({
    accounts: [{ id: 'acc-1', name: 'E*TRADE Individual', institution_name: 'E*TRADE' }],
    positionsByAccount: { 'acc-1': [{ ...stock('VOO', 11, 553.57), price: '600' }] },
    buysByAccount: { 'acc-1': [buy('VOO', 5, 520, '2025-06-01'), buy('VOO', 6, 580, '2026-02-10'), buy('CABA', 3, 4, '2025-07-01')] },
  }));
  await service.startBrokerageConnection('http://x');
  const { rows } = await service.syncBrokerage();

  assert.deepStrictEqual(rows.map((r) => r.ticker), ['VOO'], 'buys for stocks no longer held are ignored');
  const [voo] = rows;
  assert.deepStrictEqual(voo.purchases.map((p) => [p.purchaseDate, p.purchasePrice]), [['2026-02-10', 580], ['2025-06-01', 520]]);
  assert.strictEqual(voo.costBasis, 11 * 553.57);
  assert.strictEqual(voo.value, 6600);
});

test('a failing purchase-history request does not break the sync', async () => {
  const fake = fakeClient({
    accounts: [{ id: 'acc-1', name: 'E*TRADE Individual', institution_name: 'E*TRADE' }],
    positionsByAccount: { 'acc-1': [stock('VTI', 4, 200)] },
  });
  fake.accountInformation.getAccountActivities = () => Promise.reject(new Error('not supported'));
  snaptrade.setClientForTests(fake);
  await service.startBrokerageConnection('http://x');
  const { rows } = await service.syncBrokerage();
  assert.deepStrictEqual(rows.map((r) => [r.ticker, r.purchases[0].purchaseDate]), [['VTI', null]]);
});
