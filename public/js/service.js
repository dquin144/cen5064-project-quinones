// Service tier: orchestrates user actions — asks Domain to decide, Data to store.

// Returns { errors }. An empty errors object means the holding was saved.
function addHolding(input) {
  const { holding, errors } = validateHolding(input);
  if (Object.keys(errors).length === 0) saveHolding(holding);
  return { errors };
}

function getPortfolio() {
  return consolidateHoldings(loadHoldings());
}
