const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';
const { closeDb } = require('../src/data.js');
const service = require('../src/service.js');

const valid = { ticker: 'AAPL', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' };

beforeEach(() => closeDb());

test('starts with an empty portfolio', () => {
  const { rows, summary } = service.getPortfolio();
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(summary, { ...{ totalInvested: 0, holdingsCount: 0, totalValue: 0, gainLoss: 0, gainLossPercent: null, unpricedCount: 0 }, accountsConnected: 0 });
});

test('rejects an invalid holding and saves nothing', () => {
  const { errors } = service.addHolding({ ...valid, ticker: 'AAPL!' });
  assert.ok(errors.ticker);
  assert.deepStrictEqual(service.getPortfolio().rows, []);
});

test('saves a valid holding so it can be loaded back', () => {
  assert.deepStrictEqual(service.addHolding(valid).errors, {});
  const { rows, summary } = service.getPortfolio();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ticker, 'AAPL');
  assert.strictEqual(summary.totalInvested, 1500);
});

test('merges repeat purchases of the same ticker into one row', () => {
  service.addHolding(valid);
  service.addHolding({ ...valid, shares: '5', purchasePrice: '200', purchaseDate: '2024-06-01' });
  const { rows, summary } = service.getPortfolio();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shares, 15);
  assert.strictEqual(summary.totalInvested, 2500);
});

test('same-date purchases: the later save counts as the latest', () => {
  service.addHolding({ ...valid, purchasePrice: '100' });
  service.addHolding({ ...valid, purchasePrice: '110' });
  assert.strictEqual(service.getPortfolio().rows[0].purchases[0].purchasePrice, 110);
});

test('adds the price column to a database created before it existed', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const data = require('../src/data.js');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'folio-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE brokerage_accounts (id TEXT PRIMARY KEY, app_user_id TEXT NOT NULL, name TEXT NOT NULL, institution TEXT, synced_at TEXT);
            CREATE TABLE brokerage_positions (account_id TEXT NOT NULL, ticker TEXT NOT NULL, shares REAL NOT NULL, average_price REAL NOT NULL);
            INSERT INTO brokerage_accounts VALUES ('a1', 'local', 'Old Account', NULL, NULL);
            INSERT INTO brokerage_positions VALUES ('a1', 'VTI', 3, 200);`);
  old.close();

  closeDb();
  process.env.DB_FILE = file;
  try {
    assert.deepStrictEqual(data.loadBrokeragePositions('local'),
      [{ ticker: 'VTI', shares: 3, averagePrice: 200, price: null, accountName: 'Old Account' }]);
  } finally {
    closeDb();
    process.env.DB_FILE = ':memory:';
  }
});
