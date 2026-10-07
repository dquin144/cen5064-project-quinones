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
  assert.deepStrictEqual(toPosition(sample, 'acc-1'), { accountId: 'acc-1', ticker: 'AAPL', shares: 12.5, averagePrice: 150.25, price: 190.1 });
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

test('price is null when SnapTrade has no market price', () => {
  assert.strictEqual(toPosition({ ...sample, price: null }, 'a').price, null);
});

const { toBuy } = require('../src/snaptrade.js');
const activity = {
  type: 'BUY',
  symbol: { symbol: 'VOO', raw_symbol: 'VOO' },
  units: 5,
  price: 520.25,
  trade_date: '2025-06-01T16:30:00Z',
  currency: { code: 'USD' },
};

test('converts a SnapTrade BUY activity to a dated purchase', () => {
  assert.deepStrictEqual(toBuy(activity, 'acc-1'), { accountId: 'acc-1', ticker: 'VOO', shares: 5, price: 520.25, date: '2025-06-01' });
});

test('dividend reinvestments count as purchases', () => {
  assert.ok(toBuy({ ...activity, type: 'REI' }, 'a'));
});

test('skips activities that are not usable purchases', () => {
  const skip = (changes) => assert.strictEqual(toBuy({ ...activity, ...changes }, 'a'), null, JSON.stringify(changes));
  skip({ type: 'SELL' });
  skip({ type: 'DIVIDEND' });
  skip({ symbol: null });
  skip({ units: 0 });
  skip({ price: 0 });
  skip({ trade_date: null, settlement_date: undefined });
  skip({ currency: { code: 'CAD' } });
});
