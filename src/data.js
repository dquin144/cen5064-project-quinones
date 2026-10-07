// Data tier: all database access. SQLite via Node's built-in node:sqlite.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS holdings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker         TEXT NOT NULL,
    shares         REAL NOT NULL,
    purchase_price REAL NOT NULL,
    purchase_date  TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One SnapTrade user per Folio user. user_secret is plain text: fine for
  -- local development, should be encrypted before real deployment.
  CREATE TABLE IF NOT EXISTS brokerage_users (
    app_user_id       TEXT PRIMARY KEY,
    snaptrade_user_id TEXT NOT NULL,
    user_secret       TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Synced from SnapTrade; replaced as a whole on every sync.
  CREATE TABLE IF NOT EXISTS brokerage_accounts (
    id          TEXT PRIMARY KEY,
    app_user_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    institution TEXT,
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brokerage_positions (
    account_id    TEXT NOT NULL REFERENCES brokerage_accounts(id) ON DELETE CASCADE,
    ticker        TEXT NOT NULL,
    shares        REAL NOT NULL,
    average_price REAL NOT NULL
  );
`;

let db = null;

function getDb() {
  if (db) return db;
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'folio.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function closeDb() {
  if (db) db.close();
  db = null;
}

function loadHoldings() {
  return getDb()
    .prepare('SELECT id, ticker, shares, purchase_price, purchase_date FROM holdings ORDER BY id')
    .all()
    .map((r) => ({
      id: r.id,
      ticker: r.ticker,
      shares: r.shares,
      purchasePrice: r.purchase_price,
      purchaseDate: r.purchase_date,
    }));
}

function saveHolding(h) {
  const { lastInsertRowid } = getDb()
    .prepare('INSERT INTO holdings (ticker, shares, purchase_price, purchase_date) VALUES (?, ?, ?, ?)')
    .run(h.ticker, h.shares, h.purchasePrice, h.purchaseDate);
  return { id: Number(lastInsertRowid), ...h };
}

// ---- Brokerage (SnapTrade) ----

function getBrokerageUser(appUserId) {
  const row = getDb()
    .prepare('SELECT snaptrade_user_id, user_secret FROM brokerage_users WHERE app_user_id = ?')
    .get(appUserId);
  return row ? { userId: row.snaptrade_user_id, userSecret: row.user_secret } : null;
}

function saveBrokerageUser(appUserId, user) {
  getDb()
    .prepare('INSERT INTO brokerage_users (app_user_id, snaptrade_user_id, user_secret) VALUES (?, ?, ?)')
    .run(appUserId, user.userId, user.userSecret);
}

// Each sync is a full snapshot: drop the user's old accounts (positions cascade), insert the new ones.
function replaceBrokerageData(appUserId, accounts, positions) {
  const db = getDb();
  const insertAccount = db.prepare(
    'INSERT INTO brokerage_accounts (id, app_user_id, name, institution) VALUES (?, ?, ?, ?)');
  const insertPosition = db.prepare(
    'INSERT INTO brokerage_positions (account_id, ticker, shares, average_price) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM brokerage_accounts WHERE app_user_id = ?').run(appUserId);
    for (const a of accounts) insertAccount.run(a.id, appUserId, a.name, a.institution ?? null);
    for (const p of positions) insertPosition.run(p.accountId, p.ticker, p.shares, p.averagePrice);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function loadBrokeragePositions(appUserId) {
  return getDb()
    .prepare(`SELECT p.ticker, p.shares, p.average_price, a.name AS account_name
              FROM brokerage_positions p JOIN brokerage_accounts a ON a.id = p.account_id
              WHERE a.app_user_id = ? ORDER BY p.rowid`)
    .all(appUserId)
    .map((r) => ({ ticker: r.ticker, shares: r.shares, averagePrice: r.average_price, accountName: r.account_name }));
}

function countBrokerageAccounts(appUserId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM brokerage_accounts WHERE app_user_id = ?')
    .get(appUserId).n;
}

module.exports = {
  loadHoldings,
  saveHolding,
  getBrokerageUser,
  saveBrokerageUser,
  replaceBrokerageData,
  loadBrokeragePositions,
  countBrokerageAccounts,
  closeDb,
};
