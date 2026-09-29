// Data tier: persists holdings in the browser's localStorage.
// This is the only file that touches storage — swap it for a real database later.

const HOLDINGS_KEY = 'folio.holdings';

function loadHoldings() {
  try {
    const list = JSON.parse(localStorage.getItem(HOLDINGS_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveHolding(holding) {
  const saved = { id: crypto.randomUUID(), ...holding };
  localStorage.setItem(HOLDINGS_KEY, JSON.stringify([...loadHoldings(), saved]));
  return saved;
}
