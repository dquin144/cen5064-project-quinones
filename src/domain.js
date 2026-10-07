// Domain tier: rules for what makes a holding valid and how holdings roll up.
// Pure — no I/O, no framework.

const TICKER_PATTERN = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// Returns { holding, errors }. An empty errors object means the input is valid.
function validateHolding(input, today = todayISO()) {
  const ticker = String(input.ticker ?? '').trim().toUpperCase();
  const shares = Number(input.shares);
  const purchasePrice = Number(input.purchasePrice);
  const purchaseDate = String(input.purchaseDate ?? '').trim();
  const errors = {};

  if (!TICKER_PATTERN.test(ticker)) {
    errors.ticker = 'Invalid ticker symbol. Use 1–5 letters, e.g. AAPL or BRK.B.';
  }
  if (input.shares === '' || !(shares > 0)) {
    errors.shares = 'Shares must be greater than 0.';
  }
  if (input.purchasePrice === '' || !(purchasePrice > 0)) {
    errors.purchasePrice = 'Purchase price must be greater than 0.';
  }
  if (!isValidISODate(purchaseDate)) {
    errors.purchaseDate = 'Enter a valid purchase date.';
  } else if (purchaseDate > today) {
    errors.purchaseDate = 'Purchase date cannot be in the future.';
  }

  return { holding: { ticker, shares, purchasePrice, purchaseDate }, errors };
}

// Newest date first; purchases without a date (synced brokerage positions) go last.
function byDateDesc(a, b) {
  if (a.purchaseDate === b.purchaseDate) return 0;
  if (a.purchaseDate == null) return 1;
  if (b.purchaseDate == null) return -1;
  return b.purchaseDate.localeCompare(a.purchaseDate);
}

// Groups holdings into one row per ticker.
//
// holdings: what the user owns — manual purchases ({ ticker, shares, purchasePrice,
//   purchaseDate }) and synced brokerage positions (purchaseDate null, purchasePrice =
//   the brokerage's average cost, optional currentPrice and source). Shares, cost and
//   value come only from these.
// buys: past brokerage buy transactions ({ ticker, shares, purchasePrice, purchaseDate,
//   source }). They only feed the purchase history shown to the user. A synced position
//   with no recorded buys shows its average cost in the history instead.
//
// Each row's purchases are newest first (same date: most recently saved first, undated
// last), so purchases[0] is the latest purchase.
function consolidateHoldings(holdings, buys = []) {
  const byTicker = new Map();
  const group = (ticker) => {
    const key = ticker.toUpperCase();
    if (!byTicker.has(key)) byTicker.set(key, { holdings: [], buys: [] });
    return byTicker.get(key);
  };
  for (const h of holdings) group(h.ticker).holdings.push(h);
  for (const b of buys) {
    if (byTicker.has(b.ticker.toUpperCase())) group(b.ticker).buys.push(b);
  }

  return [...byTicker].map(([ticker, g]) => {
    const history = g.buys.length > 0
      ? [...g.holdings.filter((h) => h.purchaseDate !== null), ...g.buys]
      : g.holdings;
    const purchases = history.slice().reverse().sort(byDateDesc);
    const shares = g.holdings.reduce((sum, h) => sum + h.shares, 0);
    const currentPrice = g.holdings.find((h) => h.currentPrice > 0)?.currentPrice ?? null;
    return {
      ticker,
      shares,
      costBasis: g.holdings.reduce((sum, h) => sum + h.shares * h.purchasePrice, 0),
      currentPrice,
      value: currentPrice === null ? null : shares * currentPrice,
      purchases,
    };
  });
}

// Gain/loss only counts rows with a known market price; unpricedCount says how many were left out.
function summarizePortfolio(rows) {
  const priced = rows.filter((r) => r.value !== null && r.value !== undefined);
  const pricedCost = priced.reduce((sum, r) => sum + r.costBasis, 0);
  const totalValue = priced.reduce((sum, r) => sum + r.value, 0);
  const gainLoss = totalValue - pricedCost;
  return {
    totalInvested: rows.reduce((sum, r) => sum + r.costBasis, 0),
    holdingsCount: rows.length,
    totalValue,
    gainLoss,
    gainLossPercent: pricedCost > 0 ? (gainLoss / pricedCost) * 100 : null,
    unpricedCount: rows.length - priced.length,
  };
}

module.exports = { validateHolding, consolidateHoldings, summarizePortfolio };
