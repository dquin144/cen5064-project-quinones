const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const service = require('../src/service.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

const USER = '1'; // the account every test here acts as

// No live prices in these tests: every price lookup fails fast instead of going to
// the network, so values come from the brokerage's price or are left out.
prices.setFetchForTests(async () => { throw new Error('offline in tests'); });

const valid = { ticker: 'AAPL', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' };

beforeEach(() => data.closeDb());

test('starts with an empty portfolio', async () => {
  const { rows, summary } = await service.getPortfolio(USER);
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(summary, { ...{ totalInvested: 0, holdingsCount: 0, totalValue: 0, gainLoss: 0, gainLossPercent: null, unpricedCount: 0 }, accountsConnected: 0 });
});

test('rejects an invalid holding and saves nothing', async () => {
  const { errors } = service.addHolding(USER, { ...valid, ticker: 'AAPL!' });
  assert.ok(errors.ticker);
  assert.deepStrictEqual((await service.getPortfolio(USER)).rows, []);
});

test('saves a valid holding so it can be loaded back', async () => {
  assert.deepStrictEqual(service.addHolding(USER, valid).errors, {});
  const { rows, summary } = await service.getPortfolio(USER);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ticker, 'AAPL');
  assert.strictEqual(summary.totalInvested, 1500);
});

test('merges repeat purchases of the same ticker into one row', async () => {
  service.addHolding(USER, valid);
  service.addHolding(USER, { ...valid, shares: '5', purchasePrice: '200', purchaseDate: '2024-06-01' });
  const { rows, summary } = await service.getPortfolio(USER);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shares, 15);
  assert.strictEqual(summary.totalInvested, 2500);
});

test('same-date purchases: the later save counts as the latest', async () => {
  service.addHolding(USER, { ...valid, purchasePrice: '100' });
  service.addHolding(USER, { ...valid, purchasePrice: '110' });
  assert.strictEqual((await service.getPortfolio(USER)).rows[0].purchases[0].purchasePrice, 110);
});

test('adds the price column to a database created before it existed', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'folio-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE brokerage_accounts (id TEXT PRIMARY KEY, app_user_id TEXT NOT NULL, name TEXT NOT NULL, institution TEXT, synced_at TEXT);
            CREATE TABLE brokerage_positions (account_id TEXT NOT NULL, ticker TEXT NOT NULL, shares REAL NOT NULL, average_price REAL NOT NULL);
            INSERT INTO brokerage_accounts VALUES ('a1', 'local', 'Old Account', NULL, NULL);
            INSERT INTO brokerage_positions VALUES ('a1', 'VTI', 3, 200);`);
  old.close();

  data.closeDb();
  data.configure(loadConfig({ DB_FILE: file }));
  try {
    assert.deepStrictEqual(data.loadBrokeragePositions('local'),
      [{ id: 1, accountId: 'a1', ticker: 'VTI', shares: 3, averagePrice: 200, price: null, accountName: 'Old Account' }]);
  } finally {
    data.closeDb();
    data.configure(loadConfig({ DB_FILE: ':memory:' }));
  }
});

const firstManual = async () => (await service.getPortfolio(USER)).rows[0].holdings.find((h) => h.kind === 'manual');

test('edits a manual purchase with the same validation as adding', async () => {
  service.addHolding(USER, valid);
  const { id } = await firstManual();

  assert.ok(service.updateHolding(USER, id, { ...valid, shares: '0' }).errors.shares, 'invalid edit is rejected');
  assert.strictEqual((await firstManual()).shares, 10, 'and nothing changed');

  assert.deepStrictEqual(service.updateHolding(USER, id, { ...valid, shares: '4', purchasePrice: '120' }).errors, {});
  const h = await firstManual();
  assert.deepStrictEqual([h.shares, h.purchasePrice], [4, 120]);
});

test('removes one purchase and keeps the others of the same ticker', async () => {
  service.addHolding(USER, valid);
  service.addHolding(USER, { ...valid, shares: '5', purchaseDate: '2024-06-01' });
  const older = (await service.getPortfolio(USER)).rows[0].holdings.find((h) => h.purchaseDate === '2024-01-15');

  service.removeHolding(USER, older.id);
  const { rows } = await service.getPortfolio(USER);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shares, 5);
});

test('removing the last purchase removes the row', async () => {
  service.addHolding(USER, valid);
  service.removeHolding(USER, (await firstManual()).id);
  assert.deepStrictEqual((await service.getPortfolio(USER)).rows, []);
});

test('leaving out whose portfolio it is fails loudly instead of using a default user', async () => {
  service.addHolding(USER, valid);
  await assert.rejects(service.getPortfolio(), TypeError);
  await assert.rejects(service.getRecommendations(), TypeError);
  await assert.rejects(service.getValueHistory(), TypeError);
  // The old argument order (holding first) is caught too, not saved for nobody.
  assert.throws(() => service.addHolding(valid), TypeError);
  assert.throws(() => service.removeHolding(1), TypeError);
  assert.throws(() => data.loadHoldings(), TypeError);
  assert.throws(() => data.saveHolding(undefined, { ticker: 'AAPL', shares: 1, purchasePrice: 1, purchaseDate: '2024-01-15' }), TypeError);
  assert.throws(() => data.loadBrokeragePositions(''), TypeError);
  assert.strictEqual((await service.getPortfolio(USER)).rows.length, 1, 'the real holding is untouched');
});

test('editing or removing an unknown purchase throws NotFoundError', () => {
  assert.throws(() => service.updateHolding(USER, 999, valid), service.NotFoundError);
  assert.throws(() => service.removeHolding(USER, 999), service.NotFoundError);
  assert.throws(() => service.removeBrokeragePosition(USER, 999), service.NotFoundError);
});
