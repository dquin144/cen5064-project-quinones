const { test } = require('node:test');
const assert = require('node:assert');
const { validateHolding, consolidateHoldings, summarizePortfolio } = require('../src/domain.js');

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

test('synced positions (no purchase date) sort after dated purchases', () => {
  const [row] = consolidateHoldings([
    { ticker: 'AAPL', shares: 3, purchasePrice: 120, purchaseDate: null, source: 'Robinhood' },
    lot('AAPL', 1, 100, '2024-01-15'),
    lot('AAPL', 2, 110, '2025-03-01'),
  ]);
  assert.deepStrictEqual(row.purchases.map((p) => p.purchaseDate), ['2025-03-01', '2024-01-15', null]);
  assert.strictEqual(row.purchases[2].source, 'Robinhood');
  assert.strictEqual(row.shares, 6);
});

test('summarizes an empty portfolio as zero', () => {
  assert.deepStrictEqual(summarizePortfolio([]), { totalInvested: 0, holdingsCount: 0, totalValue: 0, gainLoss: 0, gainLossPercent: null, unpricedCount: 0 });
});

test('summarizes total invested across tickers and merged rows', () => {
  const rows = consolidateHoldings([
    lot('AAPL', 10, 100, '2024-01-15'),
    lot('AAPL', 10, 200, '2024-06-01'),
    lot('MSFT', 2, 300, '2024-01-15'),
  ]);
  const s = summarizePortfolio(rows);
  assert.strictEqual(s.totalInvested, 3600);
  assert.strictEqual(s.holdingsCount, 2);
});

test('value uses the synced market price for the whole row', () => {
  const [row] = consolidateHoldings([
    lot('AAPL', 10, 150, '2024-01-15'),
    { ticker: 'AAPL', shares: 5, purchasePrice: 120, purchaseDate: null, source: 'E*TRADE', currentPrice: 200 },
  ]);
  assert.strictEqual(row.currentPrice, 200);
  assert.strictEqual(row.value, 3000);
});

test('value is null when no market price is known', () => {
  const [row] = consolidateHoldings([lot('MSFT', 2, 300, '2024-01-15')]);
  assert.strictEqual(row.currentPrice, null);
  assert.strictEqual(row.value, null);
});

const synced = (ticker, shares, avg, price) =>
  ({ ticker, shares, purchasePrice: avg, purchaseDate: null, source: 'E*TRADE', currentPrice: price });

test('gain/loss is total value minus what was paid', () => {
  const s = summarizePortfolio(consolidateHoldings([synced('NVDA', 10, 100, 150), synced('INTC', 10, 20, 15)]));
  assert.strictEqual(s.totalValue, 1650);
  assert.strictEqual(s.gainLoss, 1650 - 1200);
  assert.strictEqual(s.gainLossPercent, 37.5);
  assert.strictEqual(s.unpricedCount, 0);
});

test('a loss comes out negative', () => {
  const s = summarizePortfolio(consolidateHoldings([synced('INTC', 10, 20, 15)]));
  assert.strictEqual(s.gainLoss, -50);
  assert.strictEqual(s.gainLossPercent, -25);
});

test('holdings without a market price are left out of gain/loss and counted', () => {
  const s = summarizePortfolio(consolidateHoldings([synced('NVDA', 10, 100, 150), lot('MSFT', 2, 300, '2024-01-15')]));
  assert.strictEqual(s.totalInvested, 1600);
  assert.strictEqual(s.gainLoss, 500);
  assert.strictEqual(s.gainLossPercent, 50);
  assert.strictEqual(s.unpricedCount, 1);
});

test('gain/loss percent is null when nothing has a price', () => {
  const s = summarizePortfolio(consolidateHoldings([lot('MSFT', 2, 300, '2024-01-15')]));
  assert.strictEqual(s.gainLoss, 0);
  assert.strictEqual(s.gainLossPercent, null);
  assert.strictEqual(s.unpricedCount, 1);
});

test('buy history replaces the average entry; manual purchases stay in the history', () => {
  const [row] = consolidateHoldings(
    [lot('VOO', 2, 400, '2024-01-15'), synced('VOO', 11, 553.57, 600)],
    [
      { ticker: 'VOO', shares: 5, purchasePrice: 520, purchaseDate: '2025-06-01', source: 'E*TRADE' },
      { ticker: 'VOO', shares: 6, purchasePrice: 580, purchaseDate: '2026-02-10', source: 'E*TRADE' },
    ],
  );
  assert.deepStrictEqual(row.purchases.map((p) => p.purchaseDate), ['2026-02-10', '2025-06-01', '2024-01-15']);
  assert.strictEqual(row.shares, 13);
  assert.strictEqual(row.costBasis, 2 * 400 + 11 * 553.57);
});

test('buys for tickers that are no longer held are ignored', () => {
  const rows = consolidateHoldings([synced('VOO', 1, 500, 600)],
    [{ ticker: 'CABA', shares: 3, purchasePrice: 4, purchaseDate: '2025-07-01', source: 'E*TRADE' }]);
  assert.deepStrictEqual(rows.map((r) => r.ticker), ['VOO']);
});
