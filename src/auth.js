// Service tier: accounts and logins. Creates accounts, checks passwords, and
// starts and ends sessions; the HTTP side (cookies) is in server.js.
//
// Passwords are hashed with scrypt (built into Node) and a random salt per
// password. A session is a random 32-byte token the browser keeps in an HttpOnly
// cookie; the database only stores its SHA-256 hash. Repeated failed logins for a
// username are slowed down with a short lockout.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validateNewAccount, validateLogin } = require('./accounts');
const data = require('./data');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SESSION_DAYS = 7;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

class AuthError extends Error {
  constructor(message, status, errors = undefined) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

// "scrypt$<salt hex>$<hash hex>"
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Checked against when the username doesn't exist, so a login takes as long
// either way and response times don't reveal which usernames are taken.
const dummyHash = hashPassword('folio-no-such-user');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Starts a session for the user. Returns { token, expiresAt } for the cookie.
function startSession(userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  data.createSession(hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

// ---- Failed-login lockout (in memory; it resets when the server restarts) ----

const failures = new Map(); // lowercase username -> { count, since }

function checkLockout(username, now) {
  const entry = failures.get(username.toLowerCase());
  if (entry && now - entry.since > LOCKOUT_MS) failures.delete(username.toLowerCase());
  else if (entry && entry.count >= MAX_FAILED_LOGINS) {
    throw new AuthError('Too many failed attempts. Try again in 15 minutes.', 429);
  }
}

function recordFailure(username, now) {
  const key = username.toLowerCase();
  const entry = failures.get(key) ?? { count: 0, since: now };
  entry.count += 1;
  failures.set(key, entry);
}

function clearFailuresForTests() {
  failures.clear();
}

// ---- Use cases ----

// Creates an account and logs it in. Returns { user: { id, username }, session }.
// Throws AuthError 400 (invalid input, with errors per field) or 409 (taken).
async function register(input, now = Date.now()) {
  const { username, password, errors } = validateNewAccount(input);
  if (Object.keys(errors).length > 0) throw new AuthError('Check the highlighted fields.', 400, errors);
  const user = data.createUser(username, await hashPassword(password));
  if (!user) {
    throw new AuthError('That username is taken.', 409, { username: 'That username is taken. Pick another, or log in.' });
  }
  return { user, session: startSession(user.id, now) };
}

// Returns { user: { id, username }, session }. Throws AuthError 400 (missing
// fields), 401 (wrong username or password, deliberately not saying which) or
// 429 (too many failures for this username).
async function login(input, now = Date.now()) {
  const { username, password, errors } = validateLogin(input);
  if (Object.keys(errors).length > 0) throw new AuthError('Enter your username and password.', 400, errors);
  checkLockout(username, now);
  const found = data.findUserByUsername(username);
  const ok = await verifyPassword(password, found ? found.passwordHash : await dummyHash);
  if (!found || !ok) {
    recordFailure(username, now);
    throw new AuthError('Incorrect username or password.', 401);
  }
  failures.delete(username.toLowerCase());
  data.deleteExpiredSessions(new Date(now).toISOString());
  return { user: { id: found.id, username: found.username }, session: startSession(found.id, now) };
}

// The logged-in user { id, username } for a session token, or null.
function userForSession(token, now = Date.now()) {
  if (!token) return null;
  return data.findSessionUser(hashToken(token), new Date(now).toISOString());
}

function logout(token) {
  if (token) data.deleteSession(hashToken(token));
}

module.exports = {
  register,
  login,
  logout,
  userForSession,
  AuthError,
  SESSION_DAYS,
  clearFailuresForTests,
};
