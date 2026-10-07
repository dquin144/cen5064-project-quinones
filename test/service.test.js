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
  assert.deepStrictEqual(summary, { totalInvested: 0, holdingsCount: 0, accountsConnected: 0 });
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
