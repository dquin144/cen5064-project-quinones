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
`;

let db = null;

function getDb() {
  if (db) return db;
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'folio.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
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

module.exports = { loadHoldings, saveHolding, closeDb };
