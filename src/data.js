// Data tier: all database access. SQLite via Node's built-in node:sqlite.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  -- user_id is the owning account's id as text ('local' for holdings saved
  -- before accounts existed), the same value brokerage tables call app_user_id.
  CREATE TABLE IF NOT EXISTS holdings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker         TEXT NOT NULL,
    shares         REAL NOT NULL,
    purchase_price REAL NOT NULL,
    purchase_date  TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    user_id        TEXT NOT NULL DEFAULT 'local'
  );

  -- Accounts. password_hash is a salted scrypt hash (see auth.js), never the password.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Logged-in sessions. Only a SHA-256 hash of each session token is stored, so
  -- reading the database doesn't let anyone use a session.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    average_price REAL NOT NULL,
    price         REAL
  );

  -- The user's own edits and removals of synced holdings, kept separate from
  -- the brokerage's data so a sync never silently overwrites them. Keyed by
  -- account and ticker (position rows are replaced on every sync), so there's
  -- deliberately no foreign key to brokerage_accounts.
  CREATE TABLE IF NOT EXISTS brokerage_overrides (
    app_user_id   TEXT NOT NULL,
    account_id    TEXT NOT NULL,
    ticker        TEXT NOT NULL,
    action        TEXT NOT NULL CHECK (action IN ('edit', 'remove')),
    shares        REAL,
    average_price REAL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (app_user_id, account_id, ticker)
  );

  -- Past buy transactions, used only for the purchase history display.
  CREATE TABLE IF NOT EXISTS brokerage_buys (
    account_id TEXT NOT NULL REFERENCES brokerage_accounts(id) ON DELETE CASCADE,
    ticker     TEXT NOT NULL,
    shares     REAL NOT NULL,
    price      REAL NOT NULL,
    trade_date TEXT NOT NULL
  );
`;

// Columns added after a table was first created. CREATE TABLE IF NOT EXISTS
// won't add them to an existing database, so add any that are missing.
const ADDED_COLUMNS = [
  { table: 'brokerage_positions', column: 'price', type: 'REAL' },
  { table: 'holdings', column: 'user_id', type: "TEXT NOT NULL DEFAULT 'local'" },
];

function migrate(db) {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

let db = null;
let dbFile = null;

// Called once at startup (server.js) or by a test, before any database access.
function configure(config) {
  dbFile = config.dbFile;
}

function getDb() {
  if (db) return db;
  if (!dbFile) throw new Error('data.configure() must be called before using the database.');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function closeDb() {
  if (db) db.close();
  db = null;
}

// Holdings belong to one user; userId defaults to 'local' (see service.js).

function loadHoldings(userId = 'local') {
  return getDb()
    .prepare('SELECT id, ticker, shares, purchase_price, purchase_date FROM holdings WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map((r) => ({
      id: r.id,
      ticker: r.ticker,
      shares: r.shares,
      purchasePrice: r.purchase_price,
      purchaseDate: r.purchase_date,
    }));
}

function saveHolding(h, userId = 'local') {
  const { lastInsertRowid } = getDb()
    .prepare('INSERT INTO holdings (ticker, shares, purchase_price, purchase_date, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(h.ticker, h.shares, h.purchasePrice, h.purchaseDate, userId);
  return { id: Number(lastInsertRowid), ...h };
}

// Returns true if this user had a holding with that id and it was changed.
function updateHolding(id, h, userId = 'local') {
  const { changes } = getDb()
    .prepare('UPDATE holdings SET ticker = ?, shares = ?, purchase_price = ?, purchase_date = ? WHERE id = ? AND user_id = ?')
    .run(h.ticker, h.shares, h.purchasePrice, h.purchaseDate, id, userId);
  return changes > 0;
}

// Returns true if this user had a holding with that id and it was removed.
function deleteHolding(id, userId = 'local') {
  return getDb().prepare('DELETE FROM holdings WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
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

// Each sync is a full snapshot: drop the user's old accounts (positions and buys
// cascade), insert the new ones.
function replaceBrokerageData(appUserId, accounts, positions, buys = []) {
  const db = getDb();
  const insertAccount = db.prepare(
    'INSERT INTO brokerage_accounts (id, app_user_id, name, institution) VALUES (?, ?, ?, ?)');
  const insertPosition = db.prepare(
    'INSERT INTO brokerage_positions (account_id, ticker, shares, average_price, price) VALUES (?, ?, ?, ?, ?)');
  const insertBuy = db.prepare(
    'INSERT INTO brokerage_buys (account_id, ticker, shares, price, trade_date) VALUES (?, ?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM brokerage_accounts WHERE app_user_id = ?').run(appUserId);
    for (const a of accounts) insertAccount.run(a.id, appUserId, a.name, a.institution ?? null);
    for (const p of positions) insertPosition.run(p.accountId, p.ticker, p.shares, p.averagePrice, p.price ?? null);
    for (const b of buys) insertBuy.run(b.accountId, b.ticker, b.shares, b.price, b.date);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function loadBrokeragePositions(appUserId) {
  return getDb()
    .prepare(`SELECT p.rowid AS id, p.account_id, p.ticker, p.shares, p.average_price, p.price,
                     a.name AS account_name
              FROM brokerage_positions p JOIN brokerage_accounts a ON a.id = p.account_id
              WHERE a.app_user_id = ? ORDER BY p.rowid`)
    .all(appUserId)
    .map(toPosition);
}

// One synced position by id, only if it's in this user's accounts; else null.
function getBrokeragePosition(appUserId, id) {
  const row = getDb()
    .prepare(`SELECT p.rowid AS id, p.account_id, p.ticker, p.shares, p.average_price, p.price,
                     a.name AS account_name
              FROM brokerage_positions p JOIN brokerage_accounts a ON a.id = p.account_id
              WHERE p.rowid = ? AND a.app_user_id = ?`)
    .get(id, appUserId);
  return row ? toPosition(row) : null;
}

function toPosition(r) {
  return {
    id: r.id,
    accountId: r.account_id,
    ticker: r.ticker,
    shares: r.shares,
    averagePrice: r.average_price,
    price: r.price,
    accountName: r.account_name,
  };
}

// ---- The user's edits and removals of synced holdings ----

function loadOverrides(appUserId) {
  return getDb()
    .prepare(`SELECT account_id, ticker, action, shares, average_price
              FROM brokerage_overrides WHERE app_user_id = ? ORDER BY created_at, ticker`)
    .all(appUserId)
    .map((r) => ({
      accountId: r.account_id,
      ticker: r.ticker,
      action: r.action,
      shares: r.shares,
      averagePrice: r.average_price,
    }));
}

// Adds or replaces the override for one account + ticker.
function saveOverride(appUserId, o) {
  getDb()
    .prepare(`INSERT INTO brokerage_overrides (app_user_id, account_id, ticker, action, shares, average_price)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (app_user_id, account_id, ticker) DO UPDATE SET
                action = excluded.action, shares = excluded.shares,
                average_price = excluded.average_price, created_at = datetime('now')`)
    .run(appUserId, o.accountId, o.ticker, o.action, o.shares ?? null, o.averagePrice ?? null);
}

// Deletes the overrides for the given { accountId, ticker } keys, or all of them.
function deleteOverrides(appUserId, keys = null) {
  const db = getDb();
  if (keys === null) {
    db.prepare('DELETE FROM brokerage_overrides WHERE app_user_id = ?').run(appUserId);
    return;
  }
  const del = db.prepare('DELETE FROM brokerage_overrides WHERE app_user_id = ? AND account_id = ? AND ticker = ?');
  for (const k of keys) del.run(appUserId, k.accountId, k.ticker);
}

function loadBrokerageBuys(appUserId) {
  return getDb()
    .prepare(`SELECT b.ticker, b.shares, b.price, b.trade_date, a.name AS account_name
              FROM brokerage_buys b JOIN brokerage_accounts a ON a.id = b.account_id
              WHERE a.app_user_id = ? ORDER BY b.rowid`)
    .all(appUserId)
    .map((r) => ({ ticker: r.ticker, shares: r.shares, price: r.price, date: r.trade_date, accountName: r.account_name }));
}

function countBrokerageAccounts(appUserId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM brokerage_accounts WHERE app_user_id = ?')
    .get(appUserId).n;
}

// ---- Accounts and sessions ----

const toUser = (r) => (r ? { id: r.id, username: r.username, passwordHash: r.password_hash } : null);

// Creates an account and returns it, or null if the username is taken (any case).
// The first account ever created also takes over the data saved before accounts
// existed (owned by 'local'), so upgrading Folio doesn't lose anyone's portfolio.
function createUser(username, passwordHash) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    const { changes, lastInsertRowid } = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?) ON CONFLICT (username) DO NOTHING')
      .run(username, passwordHash);
    const id = Number(lastInsertRowid);
    if (changes > 0 && first) claimLocalData(db, String(id));
    db.exec('COMMIT');
    return changes > 0 ? { id, username } : null;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function claimLocalData(db, userId) {
  db.prepare("UPDATE holdings SET user_id = ? WHERE user_id = 'local'").run(userId);
  for (const table of ['brokerage_users', 'brokerage_accounts', 'brokerage_overrides']) {
    db.prepare(`UPDATE ${table} SET app_user_id = ? WHERE app_user_id = 'local'`).run(userId);
  }
}

// { id, username, passwordHash } or null. Usernames match in any case.
function findUserByUsername(username) {
  return toUser(getDb().prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username));
}

function createSession(tokenHash, userId, expiresAt) {
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash, userId, expiresAt);
}

// The session's user { id, username } if the session exists and hasn't expired.
function findSessionUser(tokenHash, now) {
  const row = getDb()
    .prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > ?`)
    .get(tokenHash, now);
  return row ? { id: row.id, username: row.username } : null;
}

function deleteSession(tokenHash) {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function deleteExpiredSessions(now) {
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

module.exports = {
  configure,
  loadHoldings,
  saveHolding,
  updateHolding,
  deleteHolding,
  getBrokerageUser,
  saveBrokerageUser,
  replaceBrokerageData,
  loadBrokeragePositions,
  getBrokeragePosition,
  loadOverrides,
  saveOverride,
  deleteOverrides,
  loadBrokerageBuys,
  countBrokerageAccounts,
  createUser,
  findUserByUsername,
  createSession,
  findSessionUser,
  deleteSession,
  deleteExpiredSessions,
  closeDb,
};
