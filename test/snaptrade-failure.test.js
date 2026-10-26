const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';
const { closeDb } = require('../src/data.js');
const snaptrade = require('../src/snaptrade.js');
const service = require('../src/service.js');

// Errors shaped like the SnapTrade SDK's SnaptradeError.
const unreachable = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
const serverError = () => Object.assign(new Error('Request failed with status code 503'), { status: 503 });
const userLimit = () => Object.assign(new Error('Request failed with status code 403'), {
  status: 403,
  responseBody: { detail: 'Maximum number of users reached for this plan.' },
});

// A SnapTrade client where every call fails with makeError(). Pass working: true
// to start with a client that works, then call fake.breakWith(makeError) later.
function failingClient(makeError, { working = false } = {}) {
  let failure = working ? null : makeError;
  const respond = (data) => (failure ? Promise.reject(failure()) : Promise.resolve({ data }));
  return {
    breakWith(next) { failure = next; },
    fix() { failure = null; },
    authentication: {
      registerSnapTradeUser: ({ userId }) => respond({ userId, userSecret: 'secret-1' }),
      loginSnapTradeUser: () => respond({ redirectURI: 'https://portal.example/abc' }),
    },
    connections: {
      listBrokerageAuthorizations: () => respond([]),
      deleteConnection: () => respond({}),
    },
    accountInformation: {
      listUserAccounts: () => respond([{ id: 'acc-1', name: 'E*TRADE Individual', institution_name: 'E*TRADE' }]),
      getAllAccountPositions: () => respond({ results: [{
        instrument: { kind: 'stock', symbol: 'VTI', raw_symbol: 'VTI' }, units: '4', cost_basis: '200', currency: 'USD',
      }] }),
      getAccountActivities: () => respond({ data: [], pagination: { total: 0 } }),
    },
  };
}

const manual = { ticker: 'AAPL', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' };

beforeEach(() => {
  closeDb();
  process.env.SNAPTRADE_CLIENT_ID = 'test-client';
  process.env.SNAPTRADE_CONSUMER_KEY = 'test-key';
});

test('when SnapTrade is down, manual holdings keep working and the user gets a clear message', async () => {
  snaptrade.setClientForTests(failingClient(unreachable));

  await assert.rejects(service.startBrokerageConnection('http://x'), (err) =>
    err instanceof service.BrokerageApiError && err.reason === 'unavailable' && /isn't responding/.test(err.message));

  // Add, edit, and remove manual holdings as usual.
  assert.deepStrictEqual(service.addHolding(manual).errors, {});
  assert.deepStrictEqual(service.addHolding({ ...manual, ticker: 'MSFT' }).errors, {});
  const msft = service.getPortfolio().rows.find((r) => r.ticker === 'MSFT').holdings[0];
  assert.deepStrictEqual(service.updateHolding(msft.id, { ...manual, ticker: 'MSFT', shares: '3' }).errors, {});
  const aapl = service.getPortfolio().rows.find((r) => r.ticker === 'AAPL').holdings[0];
  service.removeHolding(aapl.id);

  const portfolio = service.getPortfolio();
  assert.deepStrictEqual(portfolio.rows.map((r) => [r.ticker, r.shares]), [['MSFT', 3]]);
  assert.match(portfolio.brokerageIssue, /manual holdings still work/);
});

test('a SnapTrade server error is reported the same way as SnapTrade being down', async () => {
  snaptrade.setClientForTests(failingClient(serverError));
  await assert.rejects(service.startBrokerageConnection('http://x'), (err) => err.reason === 'unavailable');
});

test('when the free tier user limit is reached, the user is told and can still add holdings by hand', async () => {
  const fake = failingClient(userLimit);
  snaptrade.setClientForTests(fake);

  await assert.rejects(service.startBrokerageConnection('http://x'), (err) =>
    err instanceof service.BrokerageApiError && err.reason === 'user-limit' && /one connected user/.test(err.message));
  assert.match(service.getPortfolio().brokerageIssue, /holdings by hand/);

  assert.deepStrictEqual(service.addHolding(manual).errors, {});
  assert.deepStrictEqual(service.getPortfolio().rows.map((r) => r.ticker), ['AAPL']);

  // No half-registered user was saved, so connecting works once a spot frees up.
  fake.fix();
  assert.strictEqual(await service.startBrokerageConnection('http://x'), 'https://portal.example/abc');
  assert.strictEqual(service.getPortfolio().brokerageIssue, null);
});

test('a failed sync keeps the last synced holdings and the manual ones', async () => {
  const fake = failingClient(serverError, { working: true });
  snaptrade.setClientForTests(fake);
  service.addHolding(manual);
  await service.startBrokerageConnection('http://x');
  await service.syncBrokerage();

  fake.breakWith(unreachable);
  await assert.rejects(service.syncBrokerage(), service.BrokerageApiError);

  const portfolio = service.getPortfolio();
  assert.deepStrictEqual(portfolio.rows.map((r) => r.ticker).sort(), ['AAPL', 'VTI']);
  assert.strictEqual(portfolio.summary.accountsConnected, 1);
  assert.ok(portfolio.brokerageIssue);

  // Once SnapTrade is back, the next sync clears the message.
  fake.fix();
  assert.strictEqual((await service.syncBrokerage()).brokerageIssue, null);
});

test('a SnapTrade request that never answers times out instead of hanging the app', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = failingClient(null, { working: true });
  fake.authentication.registerSnapTradeUser = () => new Promise(() => {}); // never settles
  snaptrade.setClientForTests(fake);

  const pending = service.startBrokerageConnection('http://x');
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (err) => err.reason === 'unavailable');
  assert.deepStrictEqual(service.addHolding(manual).errors, {});
});

test('other SnapTrade errors keep their reason, without the SDK response headers', async () => {
  const fake = failingClient(() => Object.assign(new Error('Request failed with status code 401\nRESPONSE HEADERS:\n{}'), { status: 401 }));
  snaptrade.setClientForTests(fake);
  await assert.rejects(service.startBrokerageConnection('http://x'), (err) =>
    err.reason === 'rejected' && err.message === 'SnapTrade request failed: Request failed with status code 401');
});
