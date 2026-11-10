# Spec: `broker`

> **Status: Approved** (Scott, 2026-10-31). Module 2 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `foundation` (implemented).

## Objective

Give the system an exact, continuously reconciled view of its Alpaca account, and one safe way to place an order. `portfolio` later decides *what* to trade and `risk` decides *whether*. `broker` only knows *how*, and never trades on its own initiative.

When `broker` is done:

- A `BrokerAdapter` port in core has an Alpaca implementation. **The host comes from `TRADING_ENV`** (`staging` → `paper-api.alpaca.markets`, `production` → `api.alpaca.markets`) and is not configurable. Paper and live keys only authenticate against their own host, so a live key in staging simply fails to authenticate (ADR-005).
- A `sync-broker` job (on the existing `*/15` cron) mirrors the account into Postgres: account state, positions, orders, and every activity (fills, dividends, fees, transfers, splits). Once per trading day after the close it also writes an **equity snapshot**.
- **Tax lots** are rebuilt FIFO from fills, which matches how Alpaca reportedly computes the 1099. They're checked against broker positions on every sync. *(#89, 2026-11-10)* The rebuild is memoized per database connection (`loadLedger`): `broker_activities` is insert-only, so lots are rebuilt only when its row count or latest time has changed, not at every read. They feed wash-sale awareness (ADR-010) and the cost basis used for realized and unrealized P&L.
- `submitOrder()` places a notional (dollar-amount) or quantity market order **idempotently**. It records the intent before calling Alpaca, uses a deterministic `client_order_id`, and recovers from timeouts by looking the order up by that id. Nothing in production calls it until `portfolio` + `risk` exist.
- Every sync reports a **`tradingAllowed`** verdict that `risk` will require. It is false whenever something looks wrong: the account is blocked or not `ACTIVE`, margin or shorting is enabled, the account number changed, or lots don't reconcile with positions.
- Daily bars (`getDailyBars`) and asset eligibility (`getAsset`: tradable, fractionable) are available for `portfolio`'s quant core.

## Assumptions (correct any of these)

1. **Long-only and no margin.** Required account configuration: `max_margin_multiplier = "1"` (buying power = cash), `no_shorting = true`, `fractional_trading = true`. The engine *checks* this and fails closed. A script *applies* it (`npm run broker:configure -- --env <env>`), and you run it for production.
2. **Orders:** US equities and ETFs, `type: market`, `time_in_force: day`, regular hours only (no extended hours), sized by `notional` (2 dp) or `qty` (9 dp). No limit, stop or bracket orders in v1.
3. **Cadence:** `sync-broker` runs on the `*/15` cron. It does a full sync while the market is open and for 30 minutes after the close (Alpaca clock and calendar), and records a `skipped: market closed` the rest of the time. This adds no new cron triggers, so we stay well inside the free plan's 5 per account.
4. **Market data:** free plan. `feed=sip`, `adjustment=all` (split- and dividend-adjusted), daily timeframe, with `end` clamped to at least 15 minutes ago. Bars aren't stored. `portfolio` fetches what it needs each run (one multi-symbol call; the limit is ~200 req/min).
5. **The PDT rule is retired** (FINRA, June 2026). The capability map's "no same-day round trips (PDT)" guardrail for `risk` loses its regulatory reason. `risk` decides whether a minimum holding period still makes sense for strategy or tax reasons.
6. **Positions are a cache.** The `positions` table is replaced on every sync with Alpaca's view, for the dashboard and MCP reads. Alpaca stays the source of truth for holdings, and our fills are the source of truth for lots.

## Tech Stack

No new runtime dependencies. Alpaca is called with the Workers/Node global `fetch`, injected into the adapter so tests can substitute recorded responses. Alpaca's official SDKs are Node-centric and pull in a WebSocket stack we don't need.

## Commands

```sh
npm run typecheck && npm test                     # gate (unchanged)
npx vitest run broker                             # (in packages/core) adapter + sync + lots + orders
npm run broker:configure -w @trader/core -- --env staging      # apply/verify account config (paper)
npm run broker:smoke -w @trader/core              # STAGING ONLY: $5 notional VTI buy → sync → verify (market hours)
```

Both scripts read `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` for the named env from `.env`. `broker:smoke` refuses to run unless `--env staging`.

## Project Structure

```
packages/core/src/broker/
  port.ts          → BrokerAdapter interface + domain types (Account, Position, Order, Activity, Bar, Clock, Asset)
  alpaca.ts        → AlpacaBroker implements BrokerAdapter (host from TRADING_ENV; Zod-parsed responses)
  sync.ts          → syncBroker(): account checks, positions, orders, activities, equity snapshot, reconciliation
  lots.ts          → buildLots(fills): FIFO open lots + realized lot closures (pure)
  orders.ts        → submitOrder(): intent → submit → record; client_order_id derivation; timeout recovery
packages/core/test/broker/
  fixtures/*.json  → recorded Alpaca paper responses (secrets/account numbers scrubbed)
  fake-broker.ts   → in-memory BrokerAdapter for later modules' tests
packages/core/scripts/broker-configure.ts, broker-smoke.ts
```

### Data model (migration `0002`, additive)

| Table | Key | Purpose |
|---|---|---|
| `broker_account` | single row | Pins `account_number` from the first sync. A later mismatch sets `tradingAllowed = false` and audits `broker.account_changed`. Also holds the last account state (`status`, `cash`, `equity`, `buying_power`, `multiplier`, blocks) and `synced_at`. |
| `broker_activities` | Alpaca activity `id` | Every activity (`FILL`, `DIV*`, `FEE`, `CSD`/`CSW`, `SPLIT`, …) with `type`, `at`, `symbol`, `side`, `qty`, `price`, `net_amount`, `order_id`, `raw`. Insert-or-ignore, so re-syncs are idempotent. Never updated. |
| `orders` | `client_order_id` (unique) | Our intent plus Alpaca's state: `symbol`, `side`, `notional` or `qty`, `status`, `broker_order_id`, `filled_qty`, `filled_avg_price`, `submitted_at`, `updated_at`, `raw`, plus a nullable `strategy_ref` that `portfolio` fills. |
| `positions` | `symbol` | Cache of Alpaca positions (`qty`, `avg_entry_price`, `market_value`, `cost_basis`, `synced_at`), replaced each sync. |
| `equity_snapshots` | `trading_date` | One row per trading day after the close: `equity`, `cash`, `long_market_value`. Used by `risk` (drawdown) and `portfolio` (vs VTI). |

All money and quantity columns are `numeric` (ADR-009). The new tables get `trader_app` DML through the default privileges `foundation` set up. Following ADR-008, `broker_activities` should also be insert-only for `trader_app`, which needs one REVOKE in a migration.

### Config

| Var | Kind | Notes |
|---|---|---|
| `ALPACA_KEY_ID` | Worker secret | Per env: the paper key in staging, the live key in production |
| `ALPACA_SECRET_KEY` | Worker secret | Per env |

These become **required** in `parseConfig`. Without them the Worker returns 503 and runs nothing, as for `DATABASE_URL`. That means production needs the live keys in place before this module merges (see Open Questions).

### Audit kinds added

`order.intent`, `order.submitted`, `order.filled`, `order.partially_filled`, `order.canceled`, `order.rejected`, `broker.account_changed`, `broker.config_unsafe`, `broker.reconcile_mismatch`, `broker.sync_failed`. `notifications` will email on the order kinds and the three `broker.*` safety kinds.

## Code Style

Same as `foundation`. Adapter methods return status unions for expected outcomes and throw only for bugs and infrastructure failures:

```ts
export type SubmitResult =
  | { status: "submitted"; order: OrderRow }
  | { status: "already_submitted"; order: OrderRow }       // same client_order_id seen before
  | { status: "rejected"; order: OrderRow; reason: string } // Alpaca said no (e.g. not fractionable)
  | { status: "unknown"; order: OrderRow };                 // timeout; next sync resolves it by client_order_id
```

Each Alpaca response is Zod-parsed at the edge, so an unexpected field shape fails one sync loudly rather than corrupting a row. Decimal strings pass straight through to `numeric`, and no `number` ever holds money.

## Testing Strategy

- **Adapter:** recorded responses from the paper account (captured once, scrubbed) drive `AlpacaBroker` through an injected `fetch`. Tests assert the request shape (host per env, headers, query params) and parsing, including pagination of activities (`page_token`) and 4xx/5xx handling.
- **Lots** (pure): FIFO across partial fills, multiple buys, partial sells, a full close, a sell at a loss followed by a rebuy within 30 days (the data `portfolio` needs for wash sales), and a split activity.
- **Sync** against PGlite + fake broker: activities insert idempotently across overlapping windows; positions are replaced; an equity snapshot is written once per trading date; every `tradingAllowed = false` path (blocked, margin > 1, shorting on, account number changed, lots ≠ positions) audits once rather than every 15 minutes.
- **Orders** against PGlite + fake broker: intent recorded before the call; a second call with the same intent returns `already_submitted` and makes no broker call; a timeout gives `unknown`, and the next sync resolves it by `client_order_id`; Alpaca rejection is recorded and audited.
- **Live, staging only:** `broker:smoke` during market hours, plus watching staging's `sync-broker` runs.

## Boundaries

- **Always:** derive the Alpaca host from `TRADING_ENV`; record the order intent before calling Alpaca; Zod-parse every response; audit every order state change; keep `broker` free of trading *decisions*.
- **Ask first:** placing any order on the live account (including a smoke test); changing live account configuration; adding a second Alpaca endpoint family (options, crypto, streaming).
- **Never:** make the Alpaca host configurable; log or store API keys; retry a submission with a *new* `client_order_id` after an ambiguous failure; call `submitOrder` from a job before `risk` exists.

## Success Criteria

1. Gate green, with the test coverage listed above.
2. Staging's `sync-broker` runs every 15 minutes. During market hours it `succeeded`, and its `positions`, `orders` and `broker_activities` match the paper account exactly. Outside market hours it records `skipped: market closed`, and weekends cost nothing.
3. `broker:smoke` on a trading day: a $5 notional VTI buy goes intent → submitted → filled, the FILL activity syncs, an open lot appears whose quantity equals the Alpaca position, and `order.intent`, `order.submitted` and `order.filled` events exist. Re-running with the same intent makes no second order.
4. After the close, exactly one `equity_snapshots` row exists for that trading date in staging.
5. Making the paper account unsafe (e.g. `broker:configure` with margin 2 in staging) makes the next sync report `tradingAllowed = false` with one `broker.config_unsafe` event. Restoring it clears the condition.
6. Production: the live keys are set, `broker:configure --env production` shows the safe configuration, and `sync-broker` mirrors the live account read-only. **No order is placed in production by this module.**
7. Workers stay within free-plan CPU, with sync durations visible in `job_runs`. If they don't, that's the trigger to raise Workers Paid ($5/mo) in the `portfolio` spec.

## Open Questions

1. **Live account readiness.** Is your live Alpaca account open, approved and funded ($1k), with a **live** API key pair? The order matters, because merging this module to `main` makes production require Alpaca keys. There are two ways to handle it:
   - **(a)** Set the live keys as Worker secrets *before* merging (my recommendation, if the account is ready).
   - **(b)** If it isn't ready yet, I build and verify everything on staging (paper) and we hold the merge until it is.
2. **Paper key pair.** I'll need paper keys in `.env` (`STAGING_ALPACA_KEY_ID` / `STAGING_ALPACA_SECRET_KEY`) and set as staging Worker secrets. You can reset the paper account balance to something like $1k first, so staging resembles production.
3. **Smoke-test timing.** Today is Saturday, 2026-10-31. Everything except the live paper fill (SC-3 and SC-4) can be built and verified now. Those two wait for Monday's session.
