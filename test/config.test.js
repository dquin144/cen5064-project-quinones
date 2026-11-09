const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { getConfig, loadConfig } = require('../src/config.js');

test('getConfig always returns the same config object', () => {
  assert.strictEqual(getConfig(), getConfig());
});

test('the config cannot be changed after it is loaded', () => {
  const config = loadConfig({ FINNHUB_API_KEY: 'k' });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.snaptrade) && Object.isFrozen(config.anthropic));
  assert.throws(() => { 'use strict'; config.finnhubApiKey = 'other'; }, TypeError);
});

test('uses defaults when nothing is set', () => {
  assert.deepStrictEqual(loadConfig({}), {
    port: 3000,
    appUrl: 'http://localhost:3000',
    dbFile: path.join(__dirname, '..', 'data', 'folio.db'),
    finnhubApiKey: null,
    anthropic: { apiKey: null, model: 'claude-haiku-5-5' },
    snaptrade: { clientId: null, consumerKey: null },
  });
});

test('reads every setting from the environment', () => {
  const config = loadConfig({
    PORT: '3001',
    APP_URL: 'https://folio.example/',
    DB_FILE: ':memory:',
    FINNHUB_API_KEY: 'fh',
    SNAPTRADE_CLIENT_ID: 'id',
    SNAPTRADE_CONSUMER_KEY: 'key',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_MODEL: 'claude-sonnet-5-5',
  });
  assert.strictEqual(config.port, 3001);
  assert.strictEqual(config.appUrl, 'https://folio.example'); // trailing slash dropped
  assert.strictEqual(config.dbFile, ':memory:');
  assert.strictEqual(config.finnhubApiKey, 'fh');
  assert.deepStrictEqual(config.snaptrade, { clientId: 'id', consumerKey: 'key' });
  assert.deepStrictEqual(config.anthropic, { apiKey: 'sk-test', model: 'claude-sonnet-5-5' });
});
