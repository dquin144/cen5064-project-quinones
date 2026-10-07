const { test } = require('node:test');
const assert = require('node:assert');
const { validateHolding, consolidateHoldings } = require('../public/js/domain.js');

const TODAY = '2026-09-28';
const valid = { ticker: 'AAPL', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' };

test('accepts a valid holding and parses numbers', () => {
  const { holding, errors } = validateHolding(valid, TODAY);
  assert.deepStrictEqual(errors, {});
  assert.deepStrictEqual(holding, { ticker: 'AAPL', shares: 10, purchasePrice: 150, purchaseDate: '2024-01-15' });
});

test('normalizes ticker to uppercase and trims it', () => {
  const { holding, errors } = validateHolding({ ...valid, ticker: '  aapl ' }, TODAY);
  assert.deepStrictEqual(errors, {});
  assert.strictEqual(holding.ticker, 'AAPL');
});

test('accepts class-share tickers like BRK.B', () => {
  assert.deepStrictEqual(validateHolding({ ...valid, ticker: 'BRK.B' }, TODAY).errors, {});
});

test('rejects invalid ticker symbols with a clear message', () => {
  for (const ticker of ['', '123', 'AAPL!', 'TOOLONG', 'BRK.', undefined]) {
    const { errors } = validateHolding({ ...valid, ticker }, TODAY);
    assert.match(errors.ticker, /Invalid ticker symbol/, `expected "${ticker}" to be rejected`);
  }
});

test('rejects zero, negative, empty, or non-numeric shares and price', () => {
  for (const bad of ['0', '-5', '', 'abc', undefined]) {
    const { errors } = validateHolding({ ...valid, shares: bad, purchasePrice: bad }, TODAY);
    assert.ok(errors.shares, `shares "${bad}" should be rejected`);
    assert.ok(errors.purchasePrice, `price "${bad}" should be rejected`);
  }
});

test('rejects missing, malformed, or future purchase dates', () => {
  assert.ok(validateHolding({ ...valid, purchaseDate: '' }, TODAY).errors.purchaseDate);
  assert.ok(validateHolding({ ...valid, purchaseDate: '2024-02-30' }, TODAY).errors.purchaseDate);
  assert.match(validateHolding({ ...valid, purchaseDate: '2026-09-29' }, TODAY).errors.purchaseDate, /future/);
  assert.deepStrictEqual(validateHolding({ ...valid, purchaseDate: TODAY }, TODAY).errors, {});
});

const lot = (ticker, shares, purchasePrice, purchaseDate) => ({ ticker, shares, purchasePrice, purchaseDate });

test('consolidates an empty list to no rows', () => {
  assert.deepStrictEqual(consolidateHoldings([]), []);
});

test('consolidates same ticker, same date and price into one row', () => {
  const rows = consolidateHoldings([lot('AAPL', 10, 150, '2024-01-15'), lot('AAPL', 5, 150, '2024-01-15')]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shares, 15);
  assert.strictEqual(rows[0].costBasis, 2250);
  assert.strictEqual(rows[0].purchases.length, 2);
});

test('shows the most recent purchase first, keeping older ones', () => {
  const [row] = consolidateHoldings([
    lot('AAPL', 10, 100, '2024-01-15'),
    lot('AAPL', 10, 200, '2025-06-01'),
    lot('AAPL', 5, 120, '2024-08-10'),
  ]);
  assert.deepStrictEqual(row.purchases.map((p) => p.purchaseDate), ['2025-06-01', '2024-08-10', '2024-01-15']);
  assert.strictEqual(row.purchases[0].purchasePrice, 200);
  assert.strictEqual(row.shares, 25);
  assert.strictEqual(row.costBasis, 3600);
});

test('same-date purchases: the most recently saved one counts as latest', () => {
  const [row] = consolidateHoldings([lot('AAPL', 1, 100, '2024-01-15'), lot('AAPL', 1, 110, '2024-01-15')]);
  assert.strictEqual(row.purchases[0].purchasePrice, 110);
});

test('keeps different tickers as separate rows and merges ticker case', () => {
  const rows = consolidateHoldings([lot('AAPL', 1, 100, '2024-01-15'), lot('MSFT', 2, 300, '2024-01-15'), lot('aapl', 3, 100, '2024-02-01')]);
  assert.deepStrictEqual(rows.map((r) => [r.ticker, r.shares]), [['AAPL', 4], ['MSFT', 2]]);
});
