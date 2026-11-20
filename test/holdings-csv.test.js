// Importing and exporting holdings as CSV: reading and writing the file (Domain),
// the all-or-nothing import (Service), and the two routes (HTTP).

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const prices = require('../src/prices.js');
const news = require('../src/news.js');
const service = require('../src/service.js');
const { createServer } = require('../server.js');
const { parseCsv, readHoldingsCsv, writeHoldingsCsv, MAX_ROWS } = require('../src/holdingsCsv.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

const USER = '1'; // the account every test here acts as

// No network in these tests: no prices and no news.
const offline = async () => { throw new Error('offline in tests'); };
prices.setFetchForTests(offline);
news.setFetchForTests(offline);

beforeEach(() => data.closeDb());

const csv = (...lines) => lines.join('\r\n');
const inputs = (text) => readHoldingsCsv(text).rows.map((r) => r.input);

// ---- Domain: reading CSV ----

test('parses quoted cells, doubled quotes, line breaks in quotes, CRLF and a BOM', () => {
  assert.deepStrictEqual(parseCsv('﻿a,"b, c","say ""hi"""\r\n"two\nlines",x,\n'), [
    ['a', 'b, c', 'say "hi"'],
    ['two\nlines', 'x', ''],
  ]);
});

test('reads Folio\'s own columns, in any order, and gives spreadsheet row numbers', () => {
  const { rows, errors } = readHoldingsCsv(csv('Purchase date,Ticker,Purchase price,Shares', '2024-01-15,aapl,150,10'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(rows, [{ row: 2, input: { ticker: 'aapl', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' } }]);
});

test('understands common column names, dollar signs, thousands commas and US dates', () => {
  assert.deepStrictEqual(inputs(csv('Symbol,Quantity,Price Per Share,Trade Date', 'VOO,"1,000","$1,412.50",3/8/2025', 'KO,2,60,12/01/24')), [
    { ticker: 'VOO', shares: '1000', purchasePrice: '1412.50', purchaseDate: '2025-03-08' },
    { ticker: 'KO', shares: '2', purchasePrice: '60', purchaseDate: '2024-12-01' },
  ]);
});

test('skips blank rows and synced holdings (they come from the brokerage)', () => {
  const { rows, skipped } = readHoldingsCsv(csv(
    'Ticker,Shares,Purchase price,Purchase date,Source',
    'AAPL,10,150,2024-01-15,Manual',
    ',,,,',
    'VTI,4,200,,E*TRADE Individual (synced)',
  ));
  assert.deepStrictEqual(rows.map((r) => [r.row, r.input.ticker]), [[2, 'AAPL']]);
  assert.strictEqual(skipped, 1);
});

test('says what is wrong with a file that has no usable header or rows', () => {
  assert.match(readHoldingsCsv('').errors[0].message, /empty/);
  assert.match(readHoldingsCsv(csv('Ticker,Shares', 'AAPL,10')).errors[0].message, /Missing: Purchase price, Purchase date/);
  assert.match(readHoldingsCsv('Ticker,Shares,Price,Date\r\n').errors[0].message, /no holdings/);
  assert.match(readHoldingsCsv(csv('Ticker,Shares,Price,Date,Source', 'VTI,4,200,,Schwab (synced)')).errors[0].message, /only has synced/);
  const tooMany = ['Ticker,Shares,Price,Date', ...Array.from({ length: MAX_ROWS + 1 }, () => 'AAPL,1,1,2024-01-15')].join('\n');
  assert.match(readHoldingsCsv(tooMany).errors[0].message, /at most 1000/);
});

// ---- Domain: writing CSV ----

test('writes manual purchases and synced holdings, sorted by ticker, ready for Excel', () => {
  const text = writeHoldingsCsv(
    [{ ticker: 'MSFT', shares: 2, purchasePrice: 400, purchaseDate: '2025-02-01' }, { ticker: 'AAPL', shares: 10, purchasePrice: 150.25, purchaseDate: '2024-01-15' }],
    [{ ticker: 'VTI', shares: 4, averagePrice: 200, accountName: 'E*TRADE Individual' }],
  );
  assert.strictEqual(text, '﻿Ticker,Shares,Purchase price,Purchase date,Source\r\n'
    + 'AAPL,10,150.25,2024-01-15,Manual\r\n'
    + 'MSFT,2,400,2025-02-01,Manual\r\n'
    + 'VTI,4,200,,E*TRADE Individual (synced)\r\n');
});

test('quotes cells that need it, and stops a spreadsheet from running a cell as a formula', () => {
  const text = writeHoldingsCsv([], [
    { ticker: 'VTI', shares: 1, averagePrice: 1, accountName: 'Joint, "Family"' },
    { ticker: 'VOO', shares: 1, averagePrice: 1, accountName: '=HYPERLINK("http://evil")' },
  ]);
  assert.match(text, /VTI,1,1,,"Joint, ""Family"" \(synced\)"/);
  assert.match(text, /VOO,1,1,,"'=HYPERLINK\(""http:\/\/evil""\) \(synced\)"/);
});

test('an export reads back as the same manual purchases', () => {
  const manual = [{ ticker: 'BRK.B', shares: 0.5, purchasePrice: 412.37, purchaseDate: '2023-06-30' }];
  const back = readHoldingsCsv(writeHoldingsCsv(manual, [{ ticker: 'VTI', shares: 4, averagePrice: 200, accountName: 'Schwab' }]));
  assert.deepStrictEqual(back.rows.map((r) => r.input), [{ ticker: 'BRK.B', shares: '0.5', purchasePrice: '412.37', purchaseDate: '2023-06-30' }]);
  assert.strictEqual(back.skipped, 1);
});

// ---- Service: importing ----

const FILE = csv('Ticker,Shares,Purchase price,Purchase date', 'AAPL,10,150,2024-01-15', 'MSFT,2,400,2025-02-01');
const tickers = async (user = USER) => (await service.getPortfolio(user)).rows.map((r) => r.ticker);

test('imports every row of a valid file', async () => {
  assert.deepStrictEqual(service.importHoldings(USER, FILE), { imported: 2, duplicates: 0, skipped: 0, errors: [] });
  assert.deepStrictEqual(await tickers(), ['AAPL', 'MSFT']);
});

test('one bad row means nothing is imported, and every problem is listed by row', async () => {
  const result = service.importHoldings(USER, csv(
    'Ticker,Shares,Purchase price,Purchase date',
    'AAPL,10,150,2024-01-15',
    'AAPL!,0,150,2024-01-15',
    'MSFT,2,400,2999-01-01',
  ));
  assert.strictEqual(result.imported, 0);
  assert.deepStrictEqual(result.errors.map((e) => [e.row, e.field]), [[3, 'ticker'], [3, 'shares'], [4, 'purchaseDate']]);
  assert.match(result.errors[0].message, /Invalid ticker symbol/);
  assert.deepStrictEqual(await tickers(), [], 'the good row was not saved either');
});

test('importing the same file twice adds nothing the second time', async () => {
  service.importHoldings(USER, FILE);
  assert.deepStrictEqual(service.importHoldings(USER, FILE), { imported: 0, duplicates: 2, skipped: 0, errors: [] });
  assert.strictEqual((await service.getPortfolio(USER)).summary.totalInvested, 10 * 150 + 2 * 400);
});

test('identical rows in one file are separate purchases; one existing purchase covers only one of them', async () => {
  const twice = csv('Ticker,Shares,Purchase price,Purchase date', 'AAPL,1,100,2024-01-15', 'AAPL,1,100,2024-01-15');
  assert.strictEqual(service.importHoldings(USER, twice).imported, 2);
  service.removeHolding(USER, (await service.getPortfolio(USER)).rows[0].holdings[0].id);
  assert.deepStrictEqual(service.importHoldings(USER, twice), { imported: 1, duplicates: 1, skipped: 0, errors: [] });
});

test('imports go into the importing account only; another account can import the same file', async () => {
  service.importHoldings(USER, FILE);
  assert.strictEqual(service.importHoldings('2', FILE).imported, 2);
  assert.deepStrictEqual(await tickers('2'), ['AAPL', 'MSFT']);
  assert.strictEqual((await service.getPortfolio(USER)).rows.length, 2);
});

test('an export of manual and synced holdings imports back into the same account as no change', async () => {
  service.importHoldings(USER, FILE);
  data.replaceBrokerageData(USER, [{ id: 'acc-1', name: 'Schwab' }], [{ accountId: 'acc-1', ticker: 'VTI', shares: 4, averagePrice: 200 }]);
  const exported = service.exportHoldings(USER);
  assert.match(exported, /VTI,4,200,,Schwab \(synced\)/);
  assert.deepStrictEqual(service.importHoldings(USER, exported), { imported: 0, duplicates: 2, skipped: 1, errors: [] });
});

test('the export shows synced holdings as the user edited them, and leaves out removed ones', () => {
  data.replaceBrokerageData(USER, [{ id: 'acc-1', name: 'Schwab' }], [
    { accountId: 'acc-1', ticker: 'VTI', shares: 4, averagePrice: 200 },
    { accountId: 'acc-1', ticker: 'VOO', shares: 1, averagePrice: 500 },
  ]);
  data.saveOverride(USER, { accountId: 'acc-1', ticker: 'VTI', action: 'edit', shares: 5, averagePrice: 210 });
  data.saveOverride(USER, { accountId: 'acc-1', ticker: 'VOO', action: 'remove' });
  const lines = service.exportHoldings(USER).trim().split('\r\n');
  assert.deepStrictEqual(lines.slice(1), ['VTI,5,210,,Schwab (synced)']);
});

test('import and export need a user', () => {
  assert.throws(() => service.importHoldings(undefined, FILE), TypeError);
  assert.throws(() => service.exportHoldings(), TypeError);
});

// ---- HTTP ----

let server;
let base;
before(async () => {
  server = createServer(loadConfig({ DB_FILE: ':memory:', PORT: '0' }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function loggedIn(username) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (path, { method = 'GET', body } = {}) => fetch(base + path, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
}

test('over HTTP: import returns the new portfolio, or 400 with the problems', async () => {
  const visit = await loggedIn('importer');
  const ok = await visit('/api/holdings/import', { method: 'POST', body: { csv: FILE } });
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.strictEqual(body.imported, 2);
  assert.deepStrictEqual(body.portfolio.rows.map((r) => r.ticker), ['AAPL', 'MSFT']);

  const bad = await visit('/api/holdings/import', { method: 'POST', body: { csv: 'Ticker\r\nAAPL' } });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).errors[0].message, /Missing/);
  assert.strictEqual((await visit('/api/holdings/import', { method: 'POST', body: {} })).status, 400);
});

test('over HTTP: a 1,000-row file fits; a much bigger body is refused', async () => {
  const visit = await loggedIn('bigfile');
  const rows = Array.from({ length: MAX_ROWS }, (_, i) => `AAPL,${i + 1},150.25,2024-01-15,Manual`);
  const big = await visit('/api/holdings/import', { method: 'POST', body: { csv: ['Ticker,Shares,Purchase price,Purchase date,Source', ...rows].join('\r\n') } });
  assert.strictEqual(big.status, 200);
  assert.strictEqual((await big.json()).imported, MAX_ROWS);
  const huge = await visit('/api/holdings/import', { method: 'POST', body: { csv: 'x'.repeat(300 * 1024) } });
  assert.strictEqual(huge.status, 413);
});

test('over HTTP: export downloads a CSV file, and needs a login', async () => {
  const visit = await loggedIn('exporter');
  await visit('/api/holdings/import', { method: 'POST', body: { csv: FILE } });
  const res = await visit('/api/holdings/export');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="folio-holdings-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.match(await res.text(), /^﻿?Ticker,Shares,Purchase price,Purchase date,Source\r\nAAPL,10,150,2024-01-15,Manual\r\n/);
  assert.strictEqual((await fetch(`${base}/api/holdings/export`)).status, 401);
});

test('the template linked from the import dialog imports as-is', async () => {
  const res = await fetch(`${base}/holdings-template.csv`);
  assert.strictEqual(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.deepStrictEqual(service.importHoldings(USER, await res.text()), { imported: 2, duplicates: 0, skipped: 0, errors: [] });
});
