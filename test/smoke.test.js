const { test } = require('node:test');
const assert = require('node:assert');

test('CI pipeline is wired up correctly', () => {
  assert.strictEqual(1 + 1, 2);
});
