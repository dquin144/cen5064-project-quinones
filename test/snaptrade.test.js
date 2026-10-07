const { test } = require('node:test');
const assert = require('node:assert');
const { toPosition } = require('../src/snaptrade.js');

// Shaped like an AccountPosition from SnapTrade's getAllAccountPositions.
const sample = {
  instrument: { kind: 'stock', id: 'i-1', symbol: 'AAPL', raw_symbol: 'AAPL', description: 'Apple Inc' },
  units: '12.5',
  price: '190.10',
  cost_basis: '150.25',
  currency: 'USD',
  cash_equivalent: false,
};

test('converts a SnapTrade stock position to Folio shape', () => {
  assert.deepStrictEqual(toPosition(sample, 'acc-1'), { accountId: 'acc-1', ticker: 'AAPL', shares: 12.5, averagePrice: 150.25 });
});

test('uses the raw symbol without an exchange suffix', () => {
  const p = toPosition({ ...sample, instrument: { ...sample.instrument, symbol: 'SHOP.TO', raw_symbol: 'SHOP' }, currency: 'USD' }, 'a');
  assert.strictEqual(p.ticker, 'SHOP');
});

test('keeps ETFs and mutual funds', () => {
  assert.ok(toPosition({ ...sample, instrument: { ...sample.instrument, kind: 'etf' } }, 'a'));
  assert.ok(toPosition({ ...sample, instrument: { ...sample.instrument, kind: 'mutualfund' } }, 'a'));
});

test('skips positions Folio cannot show yet', () => {
  const skip = (changes) => assert.strictEqual(toPosition({ ...sample, ...changes }, 'a'), null, JSON.stringify(changes));
  skip({ instrument: { ...sample.instrument, kind: 'option' } });
  skip({ instrument: { ...sample.instrument, kind: 'crypto' } });
  skip({ cash_equivalent: true });
  skip({ cost_basis: null });
  skip({ units: '0' });
  skip({ units: '-5' });
  skip({ currency: 'CAD' });
  skip({ instrument: undefined });
});
