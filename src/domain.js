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

// Editing a synced holding: only shares and average price (brokerages don't report
// purchase dates). Returns { values, errors } like validateHolding.
function validatePositionEdit(input) {
  const shares = Number(input.shares);
  const averagePrice = Number(input.purchasePrice);
  const errors = {};
  if (input.shares === '' || !(shares > 0)) errors.shares = 'Shares must be greater than 0.';
  if (input.purchasePrice === '' || !(averagePrice > 0)) errors.purchasePrice = 'Average price must be greater than 0.';
  return { values: { shares, averagePrice }, errors };
}

// ---- The user's changes to synced holdings vs. the brokerage's data ----
// An override is { accountId, ticker, action: 'edit' | 'remove', shares, averagePrice }.

const sameHolding = (a, b) => a.accountId === b.accountId && a.ticker === b.ticker;
const close = (a, b) => Math.abs(a - b) < 1e-6;

// The positions as the user wants to see them: edits applied (marked edited),
// removed ones left out.
function applyOverrides(positions, overrides) {
  const result = [];
  for (const p of positions) {
    const o = overrides.find((x) => sameHolding(x, p));
    if (!o) result.push(p);
    else if (o.action === 'edit') result.push({ ...p, shares: o.shares, averagePrice: o.averagePrice, edited: true });
  }
  return result;
}

// Compares the user's changes with fresh brokerage data.
// conflicts: changes the brokerage disagrees with; the user decides what to keep.
// settled: changes that no longer matter, safe to drop without asking: the holding
// is gone at the brokerage (sold, so there's nothing left to remove or edit), or
// an edit now matches the brokerage's values exactly.
function findConflicts(positions, overrides) {
  const conflicts = [];
  const settled = [];
  for (const o of overrides) {
    const p = positions.find((x) => sameHolding(x, o));
    const key = { accountId: o.accountId, ticker: o.ticker };
    if (!p || (o.action === 'edit' && close(p.shares, o.shares) && close(p.averagePrice, o.averagePrice))) {
      settled.push(key);
      continue;
    }
    conflicts.push({
      ...key,
      action: o.action,
      accountName: p.accountName,
      yours: o.action === 'edit' ? { shares: o.shares, averagePrice: o.averagePrice } : null,
      brokerage: { shares: p.shares, averagePrice: p.averagePrice },
    });
  }
  return { conflicts, settled };
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
//   source }). Here they only feed the purchase history shown to the user; a synced
//   position with no recorded buys shows its average cost in the history instead.
//   (buildValueHistory also uses them, to date synced shares.)
//
// Each row's purchases are newest first (same date: most recently saved first, undated
// last), so purchases[0] is the latest purchase. row.holdings lists the holdings the
// row is made of (manual purchases and synced positions), for editing or removing.
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
    const costBasis = g.holdings.reduce((sum, h) => sum + h.shares * h.purchasePrice, 0);
    const value = currentPrice === null ? null : shares * currentPrice;
    // Gain/loss since purchase; null when there's no market price to compare against.
    const gainLoss = value === null ? null : value - costBasis;
    return {
      ticker,
      shares,
      costBasis,
      currentPrice,
      value,
      gainLoss,
      gainLossPercent: gainLoss === null || costBasis <= 0 ? null : (gainLoss / costBasis) * 100,
      purchases,
      holdings: g.holdings.slice().reverse().sort(byDateDesc),
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

// Share of total value per ticker, largest first. Only priced rows count, since an
// unpriced holding has no value to compare. Past maxParts, the smallest are folded
// into one "Other" part so the breakdown stays readable.
function allocatePortfolio(rows, maxParts = 8) {
  const priced = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const total = priced.reduce((sum, r) => sum + r.value, 0);
  let parts = priced.map((r) => ({ label: r.ticker, value: r.value }));
  if (parts.length > maxParts) {
    const rest = parts.slice(maxParts - 1);
    parts = [
      ...parts.slice(0, maxParts - 1),
      { label: 'Other', value: rest.reduce((sum, p) => sum + p.value, 0), count: rest.length },
    ];
  }
  return parts.map((p) => ({ ...p, percent: (p.value / total) * 100 }));
}

// Below this, a share count is rounding error (0.1 + 0.2 shares and the like).
const SHARE_EPSILON = 1e-9;

// The lots the value-over-time chart counts for one row: { shares, purchasePrice,
// purchaseDate } with purchaseDate null when no date is known.
//
// A manual purchase is one lot with its own date. A synced position only has a
// share count and an average cost, so its shares are dated from that account's buy
// history: the newest buys first, since shares sold earlier are taken to be the
// oldest ones (first in, first out). Shares the history doesn't cover (bought
// before the brokerage's history starts, or moved in from another brokerage) stay
// undated. Every lot keeps the position's average cost, so the invested line still
// ends on the same total as the summary.
function chartLots(row, buys) {
  const lots = [];
  let undatedShares = 0;
  for (const h of row.holdings) {
    if (h.purchaseDate) {
      lots.push(h);
      continue;
    }
    let left = h.shares;
    const accountBuys = buys
      .filter((b) => b.accountId != null && b.accountId === h.accountId && b.ticker.toUpperCase() === row.ticker)
      .sort(byDateDesc);
    for (const b of accountBuys) {
      if (left <= SHARE_EPSILON) break;
      const shares = Math.min(left, b.shares);
      lots.push({ shares, purchasePrice: h.purchasePrice, purchaseDate: b.purchaseDate });
      left -= shares;
    }
    if (left > SHARE_EPSILON) {
      lots.push({ shares: left, purchasePrice: h.purchasePrice, purchaseDate: null });
      undatedShares += left;
    }
  }
  return { lots, undatedShares };
}

// The portfolio's market value on each trading day, next to how much money was in
// it by then. Built from what the user holds today, so it shows "what my holdings
// were worth", not a record of past sales.
//
// rows: consolidateHoldings() rows. Each purchase counts from its date on; synced
//   positions are dated from buys (see chartLots).
// history: Map<ticker, [{ date, close }]> oldest first (prices.getHistory).
// livePrices: Map<ticker, price>. When given, the last day uses the live price, so
//   the chart ends on the same total as the summary tiles.
// buys: past brokerage buys ({ accountId, ticker, shares, purchaseDate }), the same
//   list consolidateHoldings gets.
//
// A day only counts the holdings that are owned by then and have a close on or
// before it, in both value and invested, so the gap between the lines is always
// the gain on the same set of holdings. Days before anything was owned are dropped.
// Shares with no known date count on every day.
// Returns { points: [{ date, value, invested }], missing: [tickers with no history],
//   undated: [tickers with shares that have no known date] }.
function buildValueHistory(rows, history, { livePrices = new Map(), buys = [] } = {}) {
  const tracked = rows.filter((r) => history.get(r.ticker)?.length > 0);
  const missing = rows.filter((r) => !tracked.includes(r)).map((r) => r.ticker);
  const dates = [...new Set(tracked.flatMap((r) => history.get(r.ticker).map((p) => p.date)))].sort();
  const lastDate = dates.at(-1);

  // Per ticker: walk its closes alongside the dates, carrying the last close
  // forward over days it didn't trade (holidays differ between exchanges).
  const cursors = tracked.map((r) => ({ row: r, closes: history.get(r.ticker), i: -1, ...chartLots(r, buys) }));
  const undated = cursors.filter((c) => c.undatedShares > 0).map((c) => c.row.ticker);
  const cents = (n) => Math.round(n * 100) / 100;
  const points = [];
  for (const date of dates) {
    let value = 0;
    let invested = 0;
    let owned = false;
    for (const c of cursors) {
      while (c.i + 1 < c.closes.length && c.closes[c.i + 1].date <= date) c.i += 1;
      if (c.i < 0) continue; // no close yet on this date (e.g. listed later)
      let close = c.closes[c.i].close;
      if (date === lastDate && livePrices.get(c.row.ticker) > 0) close = livePrices.get(c.row.ticker);
      for (const lot of c.lots) {
        if (lot.purchaseDate && lot.purchaseDate > date) continue;
        owned = true;
        value += lot.shares * close;
        invested += lot.shares * lot.purchasePrice;
      }
    }
    if (owned) points.push({ date, value: cents(value), invested: cents(invested) });
  }
  return { points, missing, undated };
}

module.exports = {
  buildValueHistory,
  validateHolding,
  validatePositionEdit,
  applyOverrides,
  findConflicts,
  consolidateHoldings,
  summarizePortfolio,
  allocatePortfolio,
};
