# Creational pattern map — Folio

| Pattern | Home in Folio? |
|---|---|
| Factory Method | No genuine fit: no shared flow where a subclass picks the one product. The price sources (Yahoo, Finnhub) are all tried in turn, which is the Open/Closed provider list (#16), not a creator choosing one. |
| Abstract Factory | No genuine fit: there are no families of products that must match. Folio has one brokerage aggregator (SnapTrade) and one price client. |
| Builder | No genuine fit: the biggest object, the portfolio view, is built in one place (`getPortfolio`), and JS object literals already name every field, so there's no telescoping constructor to fix. |
| Prototype | No genuine fit: nothing is a configured template that gets copied and tweaked. Spread copies like `{ ...p, shares }` in `applyOverrides` are just immutable updates. |
| **Singleton** | **Best fit: the app config.** Settings (`PORT`, `APP_URL`, `DB_FILE`, Finnhub and SnapTrade keys) were read from `process.env` in 4 files, each time they were needed, and tests changed behavior by editing the global `process.env`. Now `src/config.js` loads them once into one frozen object, and `server.js` injects it. |

**Implemented:** Singleton (config, injected). See PR "pattern: Singleton".
