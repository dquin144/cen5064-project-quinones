// Domain tier: rules for what makes a holding valid. Pure — no DOM, no storage.

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

// Groups saved purchases into one row per ticker. Each row's purchases are
// newest first (same date: most recently saved first), so purchases[0] is the latest.
function consolidateHoldings(holdings) {
  const byTicker = new Map();
  for (const h of holdings) {
    const ticker = h.ticker.toUpperCase();
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker).push(h);
  }
  return [...byTicker].map(([ticker, lots]) => {
    const purchases = lots.slice().reverse()
      .sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));
    return {
      ticker,
      shares: purchases.reduce((sum, p) => sum + p.shares, 0),
      costBasis: purchases.reduce((sum, p) => sum + p.shares * p.purchasePrice, 0),
      purchases,
    };
  });
}

if (typeof module !== 'undefined') module.exports = { validateHolding, consolidateHoldings };
