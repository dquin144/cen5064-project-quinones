# Folio — AI Portfolio Analyzer

[![CI](https://github.com/dquin144/cen5064-project-quinones/actions/workflows/ci.yml/badge.svg)](https://github.com/dquin144/cen5064-project-quinones/actions/workflows/ci.yml)

**Student:** David Quinones (@dquin144) · **Course:** CEN 5064 Software Design, Fall 2026 · **Partner:** Alejandro Santana (@ASantana0924)

## Purpose & scope

**What:** Folio is a web app that shows individual investors what they own,
what it's worth, and how they're doing, and (by the end of the semester)
analyzes the portfolio's diversification and risk and surfaces news and
recommendations tied to their holdings.

**For whom:** beginner and intermediate individual investors who hold stocks
and ETFs at one or more brokerages and want a simple, plain-language view of
their portfolio without building spreadsheets.

**Core use cases**

| # | Use case | Status |
|---|----------|--------|
| UC1 | **Build and maintain a portfolio by hand:** add a holding (ticker, shares, purchase price, purchase date), edit or remove it; invalid input is rejected | ✅ Working |
| UC2 | **Import holdings from a brokerage:** connect a brokerage read-only (E*TRADE, Robinhood, Schwab, Fidelity, …), sync and disconnect | ✅ Working |
| UC3 | **See how the portfolio is doing:** total value, gain/loss, allocation, diversification and concentration scores | 🟡 Value and gain/loss working; allocation and scores planned |
| UC4 | **Get news and recommendations for my holdings:** rule-based insights and news matched to what the user owns | ⏳ Planned |

**In scope:** a single-user web app run locally; US stocks, ETFs and mutual
funds priced in USD; read-only brokerage access; rule-based analysis computed
from the user's own data.

**Out of scope:** placing trades or moving money, options and crypto, tax
reporting, multi-currency portfolios, and personalized financial advice
(insights are informational only).

**Scope change, acknowledged:** brokerage import (UC2) was only a
"potentially" in the original proposal. It was pulled into the first half
because it is the most useful way to fill a portfolio, and it is isolated in
one Data-tier file ([ADR-003](docs/adr/adr-003.md)). To keep the semester
achievable, UC4's recommendations start as transparent rules (for example,
"one holding is over 25% of your portfolio") rather than machine learning.

## How to run

> **Requires Node 22.13 or later** (Node 24 recommended). Check with `node -v`.
> On older versions the tests and server fail with an error mentioning
> `node:sqlite` or `--env-file-if-exists`; install a current Node from https://nodejs.org.

From the repo root after cloning:

1. **Install dependencies:** `npm install`
2. **Run the tests:** `npm test`
3. **Start the app:** `npm start` (stop it with Ctrl+C)
4. **Open the portfolio page:** http://localhost:3000/portfolio.html, or open
   http://localhost:3000 and click "Get started" or "Log in" (login isn't
   implemented yet, so both go straight to the portfolio).

No `.env` file or API key is needed for this. Holdings are saved in a local
SQLite database at `data/folio.db`, created automatically on first run.
Live Server doesn't work for the portfolio page, because it needs the Node server.

**Try the core use case (UC1):** click **Add holding** and enter
`AAPL, 10, 150, 2024-01-15`: it appears in the table, and it's still there after
a refresh or a server restart. Enter the ticker `AAPL!` and the Domain tier
rejects it with "Invalid ticker symbol". Click **Edit** on the row to edit or
remove the purchase.

### Optional: connect a brokerage (SnapTrade)

Everything above works without this. To enable "Connect brokerage" you need
your own free SnapTrade API key:

1. Create a **Commercial** account (not Personal) at https://dashboard.snaptrade.com,
   verify your email, and turn on two-factor authentication.
2. On the **API Keys** page, create a **test** key. Copy the **Client ID** and
   **Consumer Key** right away and keep the Consumer Key private.
3. Copy `.env.example` to `.env` and paste the two values into
   `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY`. `.env` is gitignored —
   never commit real keys.
4. Restart `npm start`, click **Connect brokerage**, and sign in to your
   brokerage on the page that opens. You'll be sent back to Folio and your
   holdings sync automatically. **Sync accounts** refreshes them;
   **Disconnect** revokes SnapTrade's access and removes synced holdings.

Access is read-only. The free tier allows one connected user. Stocks, ETFs and
mutual funds in USD are imported; options, crypto and cash are skipped for now.

## Architecture

### N-tier architecture

Four tiers, each with its own files:

| Tier | Files | Responsibilities in Folio |
|------|-------|---------------------------|
| **Presentation** | `public/index.html`, `public/portfolio.html` | Landing page; portfolio dashboard (summary tiles, holdings table, purchase history); dialogs to add, edit and remove holdings, connect a brokerage, and resolve sync conflicts. Sends input to the server as JSON and renders the result. **No business rules and no storage access.** |
| **Service** | `server.js` (HTTP entry), `src/service.js` | Orchestrates each use case: add/edit/remove a holding, build the portfolio view, connect/sync/disconnect a brokerage, resolve sync conflicts. Asks the Domain to decide and the Data tier to load and save. `server.js` only parses requests and maps results and errors to HTTP status codes. |
| **Domain** | `src/domain.js` | The rules, as pure functions: what makes a holding valid (ticker format, shares and price > 0, date not in the future); merging purchases into one row per ticker; value, total value and gain/loss; applying the user's changes to synced holdings and detecting conflicts with fresh brokerage data. No I/O. *Planned:* allocation, diversification score, rule-based insights, matching news to holdings. |
| **Data** | `src/data.js`, `src/snaptrade.js` | `data.js`: all SQLite access (holdings, brokerage accounts, positions, buy history, the user's changes to synced holdings). `snaptrade.js`: the only code that reads the SnapTrade keys or calls SnapTrade; converts its data into Folio's shape. *Planned:* `prices.js` and `news.js`, clients for a market data and news API (e.g. Finnhub). |

**Dependency rule:** dependencies point one way: Presentation → Service →
Domain, and Service → Data. The Domain depends on nothing (it imports no other
module), the Data tier never calls up into Service or Domain, and the
Presentation tier reaches the server only over HTTP. In code this is visible
in the `require` calls: `server.js` imports only `service.js`; `service.js`
imports `domain.js`, `data.js` and `snaptrade.js`; `domain.js` imports nothing.

### C4 — Context

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 40, 'rankSpacing': 60, 'curve': 'basis'}}}%%
flowchart LR
    user(["Individual Investor<br/><small>(Person)</small>"])
    folio["Folio<br/><small>(Software System)</small><br/>tracks holdings, shows value<br/>and gain/loss"]
    snaptrade["SnapTrade<br/><small>(External System)</small><br/>brokerage aggregator API"]
    brokerages["Brokerages<br/><small>(External Systems)</small><br/>E*TRADE, Robinhood, Schwab, …"]
    market["Market Data & News API<br/><small>(External System, planned)</small><br/>e.g. Finnhub: live prices,<br/>company news"]

    user -->|adds and edits holdings,<br/>views portfolio| folio
    user -->|signs in to connect<br/>an account read-only| brokerages
    folio -->|registers user, gets connection link,<br/>reads accounts, positions and buys| snaptrade
    snaptrade -->|reads account data| brokerages
    folio -.->|planned: fetches prices<br/>and news for holdings| market

    classDef planned stroke-dasharray: 5 5,fill:#f6f6f6,color:#666
    class market planned
```

*Solid = built. Dashed = planned for the second half (not implemented yet).*

### C4 — Container

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 35, 'rankSpacing': 55, 'curve': 'basis'}}}%%
flowchart TB
    user(["Individual Investor"])

    subgraph folio [Folio]
        direction TB
        ui["Web UI — Presentation<br/><small>HTML/JS in the browser</small><br/>public/index.html, public/portfolio.html"]
        subgraph server [Node.js server]
            direction TB
            http["HTTP entry — Service<br/><small>server.js</small><br/>JSON API + static files"]
            service["Application Service — Service<br/><small>src/service.js</small><br/>orchestrates each use case"]
            domain["Domain Logic — Domain<br/><small>src/domain.js</small><br/>validation, merging, gain/loss,<br/>sync conflicts<br/><i>planned: allocation, diversification<br/>score, rule-based insights</i>"]
            data["Data Access — Data<br/><small>src/data.js, src/snaptrade.js</small><br/>SQL queries, SnapTrade client"]
            dataPlanned["Market Data & News clients — Data<br/><small>src/prices.js, src/news.js (planned)</small><br/>cached quotes, company news"]
        end
        db[("Database — Data<br/><small>SQLite file data/folio.db</small>")]
    end

    snaptrade["SnapTrade API<br/><small>(External System)</small>"]
    market["Market Data & News API<br/><small>(External System, planned)</small><br/>e.g. Finnhub"]

    user -->|uses, in a browser| ui
    ui -->|JSON over HTTP| http
    http --> service
    service --> domain
    service --> data
    data -->|SQL| db
    data -->|HTTPS| snaptrade
    service -.-> dataPlanned
    dataPlanned -.->|HTTPS| market

    classDef planned stroke-dasharray: 5 5,fill:#f6f6f6,color:#666
    class dataPlanned,market planned
```

*Solid = built. Dashed (and italic text) = planned for the second half (not implemented yet).*

### UML — Class diagram

The core domain concepts. In code they are plain JavaScript objects, and the
rules are pure functions in `src/domain.js` (shown as static operations).
*Planned (not shown until built):* a `RiskScore` computed from the
portfolio rows, with a diversification score and a concentration warning.

```mermaid
classDiagram
    direction LR
    class Holding {
        <<manual purchase>>
        +id: Integer
        +ticker: String
        +shares: Number
        +purchasePrice: Number
        +purchaseDate: Date
        +validateHolding(input)$
    }
    class BrokerageAccount {
        +id: String
        +name: String
        +institution: String
        +syncedAt: DateTime
    }
    class BrokeragePosition {
        <<synced>>
        +id: Integer
        +ticker: String
        +shares: Number
        +averagePrice: Number
        +price: Number
    }
    class PositionOverride {
        <<user change>>
        +ticker: String
        +action: edit or remove
        +shares: Number
        +averagePrice: Number
        +applyOverrides(positions, overrides)$
        +findConflicts(positions, overrides)$
    }
    class PortfolioRow {
        +ticker: String
        +shares: Number
        +costBasis: Number
        +currentPrice: Number
        +value: Number
        +consolidateHoldings(holdings, buys)$
        +summarizePortfolio(rows)$
    }

    BrokerageAccount "1" --> "0..*" BrokeragePosition : holds
    PositionOverride "0..1" ..> "1" BrokeragePosition : changes
    PortfolioRow "1" o-- "0..*" Holding : merges by ticker
    PortfolioRow "1" o-- "0..*" BrokeragePosition : merges by ticker
```

### UML — Sequence diagram (UC1: add a holding)

Each message goes one way down the tiers; replies come back the same path.

```mermaid
%%{init: {'sequence': {'messageMargin': 35, 'mirrorActors': false, 'boxMargin': 10}}}%%
sequenceDiagram
    actor U as User
    participant UI as Web UI<br/>(portfolio.html)
    participant H as HTTP entry<br/>(server.js)
    participant S as Service<br/>(service.js)
    participant Dom as Domain<br/>(domain.js)
    participant D as Data<br/>(data.js)
    participant DB as SQLite

    U->>UI: fill in form, click "Add holding"
    UI->>H: POST /api/holdings {ticker, shares, purchasePrice, purchaseDate}
    H->>S: addHolding(input)
    S->>Dom: validateHolding(input)
    Dom-->>S: {holding, errors}
    alt input is invalid (e.g. ticker "AAPL!")
        S-->>H: {errors}
        H-->>UI: 400 {errors}
        UI-->>U: error shown under each field, nothing saved
    else input is valid
        S->>D: saveHolding(holding)
        D->>DB: INSERT INTO holdings
        DB-->>D: new id
        D-->>S: saved holding
        S-->>H: no errors
        H->>S: getPortfolio()
        S->>D: load holdings, positions, user changes, buys
        D-->>S: rows
        S->>Dom: applyOverrides, consolidateHoldings, summarizePortfolio
        Dom-->>S: portfolio rows + summary
        S-->>H: portfolio
        H-->>UI: 201 portfolio
        UI-->>U: table and summary tiles update
    end
```

## Plan for the second half

A rough plan; the order and scope may shift as the project develops.

| Weeks | Focus | Use case |
|-------|-------|----------|
| 8 | Midterm: merge open work, docs current | — |
| 9–10 | Live prices, allocation breakdown, per-holding gain/loss | UC3 |
| 11–12 | Portfolio scores (diversification, concentration) and news for holdings | UC3, UC4 |
| 13–14 | Recommendations/insights, login, buffer for anything that slipped | UC4 |
| 15–16 | Polish, final docs, final deliverable | — |

**Risks and mitigations**

| Risk | Mitigation |
|------|------------|
| The grader's machine has Node older than 22.13, so `node:sqlite` is missing and the app won't start | Requirement at the top of "How to run" with the exact error; `engines` field in `package.json`; CI runs on Node 24 |
| Market data API limits or outages (Finnhub free tier: 60 calls/min) | Cache quotes for a few minutes; fall back to the last brokerage price, labeled with its date |
| SnapTrade free tier: one connected user, data up to a day old, API changes | All SnapTrade code in one file; tests use a fake client; manual entry works with no keys |
| `node:sqlite` is still experimental and could change | All SQL lives in `src/data.js`, so moving to `better-sqlite3` or PostgreSQL touches one file ([ADR-002](docs/adr/adr-002.md)) |
| Scope creep from the "AI" features (UC4) | Core metrics come first; recommendations start rule-based; news is cut if behind |
| Stored secrets: the SnapTrade user secret is plain text in the local database | Fine for local development only; encrypted alongside login, before anything is deployed |
| Partner review delays block dependent PRs | Small PRs, stacked branches, and merge commits (not squash) so stacked PRs merge cleanly |

## Architecture Decision Records

Decisions live in [`docs/adr/`](docs/adr/).

| # | Decision | Status |
|---|----------|--------|
| [001](docs/adr/adr-001.md) | Use JavaScript/Node across all tiers | accepted |
| [002](docs/adr/adr-002.md) | Use SQLite via built-in `node:sqlite` for the Data tier | accepted |
| [003](docs/adr/adr-003.md) | Use SnapTrade to connect brokerage accounts | accepted |
| [004](docs/adr/adr-004.md) | Keep user edits to synced holdings separate; let the user decide on sync | accepted |

## Weekly log

- **Week 1 (Aug 24):** Repo created; project proposal written in the README.
- **Week 2 (Aug 31):** Tier table for this system (Session 2 studio).
- **Week 3 (Sep 7):** No commits: Labor Day recess week.
- **Week 4 (Sep 14):** C4 Context and Container diagrams and UML class diagram (Session 3 studio).
- **Week 5 (Sep 21):** Node project, CI workflow (first runs failed, fixed the same day), smoke test, ADR-001, static landing page.
- **Week 6 (Sep 28):** First working slice: manual stock entry with Domain validation (issue #1), merged via PR with an AI critique.
- **Week 7 (Oct 5):** Node server and SQLite (ADR-002); brokerage-style dashboard; SnapTrade brokerage connection with value, gain/loss and purchase history (ADR-003); edit and remove holdings with sync-conflict handling (ADR-004); docs brought up to date for the midterm.
