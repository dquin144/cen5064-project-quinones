const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config.js');
const data = require('../src/data.js');
const service = require('../src/service.js');
const auth = require('../src/auth.js');
const { validateNewAccount, validateLogin } = require('../src/accounts.js');

data.configure(loadConfig({ DB_FILE: ':memory:' }));

beforeEach(() => {
  data.closeDb();
  auth.clearFailuresForTests();
});

const holding = { ticker: 'AAPL', shares: '10', purchasePrice: '150', purchaseDate: '2024-01-15' };

// ---- Account rules ----

test('new accounts need a 3-32 character username and an 8+ character password', () => {
  assert.deepStrictEqual(validateNewAccount({ username: '  dave_q ', password: 'longenough' }).errors, {});
  assert.strictEqual(validateNewAccount({ username: '  dave_q ', password: 'longenough' }).username, 'dave_q');
  assert.ok(validateNewAccount({ username: 'ab', password: 'longenough' }).errors.username);
  assert.ok(validateNewAccount({ username: 'has space', password: 'longenough' }).errors.username);
  assert.ok(validateNewAccount({ username: 'dave', password: 'short' }).errors.password);
  assert.ok(validateNewAccount({ username: 'password1', password: 'PASSWORD1' }).errors.password);
  assert.ok(validateNewAccount({ username: 'dave', password: 'x'.repeat(201) }).errors.password);
});

test('the login form only checks that both fields are filled in', () => {
  assert.deepStrictEqual(validateLogin({ username: 'ab', password: 'short' }).errors, {});
  assert.deepStrictEqual(Object.keys(validateLogin({}).errors).sort(), ['password', 'username']);
});

// ---- Registering and logging in ----

test('registering creates an account and a session that identifies it', async () => {
  const { user, session } = await auth.register({ username: 'dave', password: 'correct horse' });
  assert.strictEqual(user.username, 'dave');
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(auth.userForSession(session.token), { id: user.id, username: 'dave' });
});

test('passwords are stored salted and hashed, never as given', async () => {
  await auth.register({ username: 'dave', password: 'correct horse' });
  await auth.register({ username: 'anna', password: 'correct horse' });
  const [dave, anna] = ['dave', 'anna'].map((u) => data.findUserByUsername(u).passwordHash);
  assert.match(dave, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(!dave.includes('correct horse'));
  assert.notStrictEqual(dave, anna); // same password, different salt
});

test('usernames are unique in any case', async () => {
  await auth.register({ username: 'Dave', password: 'correct horse' });
  await assert.rejects(auth.register({ username: 'dave', password: 'another one' }),
    (err) => err instanceof auth.AuthError && err.status === 409 && Boolean(err.errors.username));
});

test('invalid sign-ups are rejected with an error per field', async () => {
  await assert.rejects(auth.register({ username: 'x', password: 'y' }),
    (err) => err.status === 400 && Boolean(err.errors.username && err.errors.password));
});

test('logging in works with the right password, in any username case', async () => {
  const { user } = await auth.register({ username: 'Dave', password: 'correct horse' });
  const { user: found, session } = await auth.login({ username: 'dave', password: 'correct horse' });
  assert.deepStrictEqual(found, { id: user.id, username: 'Dave' });
  assert.strictEqual(auth.userForSession(session.token).id, user.id);
});

test('a wrong password and an unknown username get the same answer', async () => {
  await auth.register({ username: 'dave', password: 'correct horse' });
  const wrong = await auth.login({ username: 'dave', password: 'wrong horse' }).catch((e) => e);
  const unknown = await auth.login({ username: 'nobody', password: 'wrong horse' }).catch((e) => e);
  assert.deepStrictEqual([wrong.status, wrong.message], [401, 'Incorrect username or password.']);
  assert.deepStrictEqual([unknown.status, unknown.message], [wrong.status, wrong.message]);
});

test('five failed logins lock the username for 15 minutes, even with the right password', async () => {
  await auth.register({ username: 'dave', password: 'correct horse' });
  const now = Date.parse('2026-11-07T12:00:00Z');
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(auth.login({ username: 'dave', password: 'nope nope' }, now));
  }
  await assert.rejects(auth.login({ username: 'dave', password: 'correct horse' }, now), (err) => err.status === 429);
  const later = now + 16 * 60 * 1000;
  assert.ok((await auth.login({ username: 'dave', password: 'correct horse' }, later)).session);
});

test('logging out ends the session; expired sessions stop working', async () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const { session } = await auth.register({ username: 'dave', password: 'correct horse' }, now);
  assert.ok(auth.userForSession(session.token, now + 6 * 86400000)); // within 7 days
  assert.strictEqual(auth.userForSession(session.token, now + 8 * 86400000), null);
  auth.logout(session.token);
  assert.strictEqual(auth.userForSession(session.token, now), null);
  assert.strictEqual(auth.userForSession('not-a-token'), null);
  assert.strictEqual(auth.userForSession(null), null);
});

test('the session token itself is not stored, only its hash', async () => {
  const { session } = await auth.register({ username: 'dave', password: 'correct horse' });
  // Looking the session up by the raw token finds nothing: only its hash is stored.
  assert.strictEqual(data.findSessionUser(session.token, new Date().toISOString()), null);
});

// ---- Each account has its own portfolio ----

test('holdings belong to the account that added them', async () => {
  const dave = String((await auth.register({ username: 'dave', password: 'correct horse' })).user.id);
  const anna = String((await auth.register({ username: 'anna', password: 'correct horse' })).user.id);
  service.addHolding(holding, dave);
  service.addHolding({ ...holding, ticker: 'MSFT' }, anna);
  assert.deepStrictEqual(service.getPortfolio(dave).rows.map((r) => r.ticker), ['AAPL']);
  assert.deepStrictEqual(service.getPortfolio(anna).rows.map((r) => r.ticker), ['MSFT']);

  // Anna can't edit or remove Dave's holding, even knowing its id.
  const daveHoldingId = service.getPortfolio(dave).rows[0].holdings[0].id;
  assert.throws(() => service.removeHolding(daveHoldingId, anna), service.NotFoundError);
  assert.throws(() => service.updateHolding(daveHoldingId, holding, anna), service.NotFoundError);
  assert.strictEqual(service.getPortfolio(dave).rows.length, 1);
});

test('the first account takes over the holdings and brokerage data saved before login existed', async () => {
  service.addHolding(holding); // saved as 'local', like before this change
  data.saveBrokerageUser('local', { userId: 'snap-1', userSecret: 's' });
  data.replaceBrokerageData('local', [{ id: 'acct-1', name: 'Robinhood' }], [{ accountId: 'acct-1', ticker: 'VTI', shares: 2, averagePrice: 200 }]);

  const first = String((await auth.register({ username: 'dave', password: 'correct horse' })).user.id);
  const second = String((await auth.register({ username: 'anna', password: 'correct horse' })).user.id);

  assert.deepStrictEqual(service.getPortfolio(first).rows.map((r) => r.ticker).sort(), ['AAPL', 'VTI']);
  assert.deepStrictEqual(data.getBrokerageUser(first), { userId: 'snap-1', userSecret: 's' });
  assert.deepStrictEqual(service.getPortfolio(second).rows, []);
  assert.deepStrictEqual(service.getPortfolio('local').rows, []);
});
