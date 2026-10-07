// Service tier: orchestrates user actions — asks Domain to decide, Data to store.

const { validateHolding, consolidateHoldings, summarizePortfolio } = require('./domain');
const data = require('./data');

// Returns { errors }. An empty errors object means the holding was saved.
function addHolding(input) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length === 0) data.saveHolding(holding);
  return { errors };
}

function getPortfolio() {
  const rows = consolidateHoldings(data.loadHoldings());
  return { rows, summary: { ...summarizePortfolio(rows), accountsConnected: 0 } };
}

module.exports = { addHolding, getPortfolio };
