// Domain tier: reading and writing holdings as CSV, for import and export.
// Pure — no I/O, no other modules. Checking that each holding is valid is
// domain.validateHolding's job; the Service runs it on every row read here.
//
// The format Folio writes, and reads back:
//   Ticker,Shares,Purchase price,Purchase date,Source
//   AAPL,10,150,2024-01-15,Manual
//   VTI,4,200,,E*TRADE Individual (synced)
// Reading is more forgiving, so files from a spreadsheet or another app work:
// columns can be in any order and go by common names (Symbol, Quantity, Price,
// Date, ...), prices can have "$" and thousands commas, and dates can be
// YYYY-MM-DD or US style (1/15/2024). Rows for synced holdings are skipped: those
// come from the brokerage, not from the file.

const MAX_ROWS = 1000;
const SYNCED_SUFFIX = ' (synced)';
const HEADER = ['Ticker', 'Shares', 'Purchase price', 'Purchase date', 'Source'];

// Column names Folio understands, compared without case, spaces or punctuation.
const COLUMNS = {
  ticker: ['ticker', 'symbol', 'tickersymbol', 'stock'],
  shares: ['shares', 'quantity', 'qty', 'units', 'numberofshares'],
  purchasePrice: ['purchaseprice', 'price', 'pricepershare', 'costpershare', 'averagecost', 'avgcost', 'buyprice'],
  purchaseDate: ['purchasedate', 'date', 'tradedate', 'buydate', 'dateacquired', 'acquired'],
  source: ['source'],
};
const LABELS = { ticker: 'Ticker', shares: 'Shares', purchasePrice: 'Purchase price', purchaseDate: 'Purchase date' };

const normalizeName = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

// CSV text -> rows of cells. Handles quoted cells (with commas, quotes written as
// "", and line breaks inside), CRLF or LF line endings, and a leading BOM.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// "$1,234.50" -> "1234.50". Anything else is left for validateHolding to judge.
const plainNumber = (s) => s.replace(/[$,\s]/g, '');

// "1/15/2024" or "01/15/24" -> "2024-01-15"; "2024/1/5" -> "2024-01-05". Other
// text is returned trimmed, for validateHolding to reject.
function isoDate(s) {
  const text = s.trim();
  const pad = (n) => String(n).padStart(2, '0');
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${pad(m[1])}-${pad(m[2])}`;
  }
  m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return text;
}

// Reads holdings from CSV text. Returns
//   { rows: [{ row, input: { ticker, shares, purchasePrice, purchaseDate } }],
//     skipped, errors: [{ row, message }] }
// row is the spreadsheet row number (the header is row 1). input is still text,
// ready for validateHolding. skipped counts synced-holding rows. errors are about
// the file as a whole (no header, missing columns, too many rows); when there are
// any, rows is empty.
function readHoldingsCsv(text) {
  const table = parseCsv(text);
  const isBlank = (cells) => cells.every((c) => c.trim() === '');
  const headerIndex = table.findIndex((cells) => !isBlank(cells));
  if (headerIndex === -1) return { rows: [], skipped: 0, errors: [{ row: 1, message: 'The file is empty.' }] };

  const names = table[headerIndex].map(normalizeName);
  const column = Object.fromEntries(Object.entries(COLUMNS).map(([field, aliases]) => [
    field, names.findIndex((n) => aliases.includes(n)),
  ]));
  const missing = Object.keys(LABELS).filter((field) => column[field] === -1);
  if (missing.length > 0) {
    return {
      rows: [],
      skipped: 0,
      errors: [{
        row: headerIndex + 1,
        message: `The first row needs column names. Missing: ${missing.map((f) => LABELS[f]).join(', ')}.`,
      }],
    };
  }

  const rows = [];
  let skipped = 0;
  const cellAt = (cells, field) => (column[field] === -1 ? '' : String(cells[column[field]] ?? '').trim());
  for (let i = headerIndex + 1; i < table.length; i += 1) {
    const cells = table[i];
    if (isBlank(cells)) continue;
    if (cellAt(cells, 'source').endsWith(SYNCED_SUFFIX)) {
      skipped += 1;
      continue;
    }
    rows.push({
      row: i + 1,
      input: {
        ticker: cellAt(cells, 'ticker'),
        shares: plainNumber(cellAt(cells, 'shares')),
        purchasePrice: plainNumber(cellAt(cells, 'purchasePrice')),
        purchaseDate: isoDate(cellAt(cells, 'purchaseDate')),
      },
    });
  }
  if (rows.length > MAX_ROWS) {
    return { rows: [], skipped, errors: [{ row: 1, message: `A file can have at most ${MAX_ROWS} holdings; this one has ${rows.length}.` }] };
  }
  if (rows.length === 0) {
    const message = skipped > 0
      ? 'The file only has synced holdings, which come from your brokerage. Nothing to import.'
      : 'The file has column names but no holdings.';
    return { rows: [], skipped, errors: [{ row: headerIndex + 2, message }] };
  }
  return { rows, skipped, errors: [] };
}

// One CSV cell. Quoted when it has a comma, quote or line break. A cell that
// starts like a formula (=, +, -, @) gets a leading apostrophe, so a spreadsheet
// shows it as text instead of running it (an account name comes from the brokerage).
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The CSV Folio exports: every manual purchase, then every synced holding (with
// the user's changes applied), sorted by ticker. Synced holdings have no purchase
// date and are marked "(synced)" in Source, so importing the file skips them.
// manual: [{ ticker, shares, purchasePrice, purchaseDate }]
// synced: [{ ticker, shares, averagePrice, accountName }]
// Starts with a BOM and uses CRLF line endings, so Excel opens it correctly.
function writeHoldingsCsv(manual, synced) {
  const byTicker = (a, b) => a[0].localeCompare(b[0]) || String(b[3]).localeCompare(String(a[3]));
  const lines = [
    ...manual.map((h) => [h.ticker, h.shares, h.purchasePrice, h.purchaseDate, 'Manual']),
    ...synced.map((p) => [p.ticker, p.shares, p.averagePrice, '', `${p.accountName || 'Brokerage'}${SYNCED_SUFFIX}`]),
  ].sort(byTicker);
  return '﻿' + [HEADER, ...lines].map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseCsv, readHoldingsCsv, writeHoldingsCsv, MAX_ROWS };
