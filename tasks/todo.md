# Tasks: `broker`

> Plan: [plan.md](plan.md) · Spec: [SPEC-broker.md](../SPEC-broker.md)
> **gate** = `npm run typecheck && npm test` from the repo root. Work happens on `broker/*` branches, so every push deploys **staging** only.

## Phase 1: Core

### B1: Config vars + port and domain types
- **Acceptance:**
  - [x] `parseConfig` requires `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` and still reports names only. The tests are updated.
  - [x] `broker/port.ts`: the `BrokerAdapter` interface and types (`Account`, `AccountConfig`, `Position`, `BrokerOrder`, `Activity`, `Bar`, `Clock`, `CalendarDay`, `Asset`, `OrderRequest`). Money is a decimal string everywhere.
  - [x] `alpacaHosts(env)`: staging → paper host, production → live host. No override.
- **Verify:** `npx vitest run config broker/hosts`; gate
- **Depends on:** — · **Files:** `src/config.ts`, `src/broker/port.ts`, `src/broker/hosts.ts`, tests · **Scope:** S

### B2: `AlpacaBroker` read methods
- **Acceptance:**
  - [x] `getAccount`, `getAccountConfig`, `getClock`, `getCalendar`, `getPositions`, `getOrders(after)`, `getOrderByClientId`, `getActivities(after)` (follows `page_token`), `getAsset`, `getDailyBars(symbols, start, end)` (`feed=sip`, `adjustment=all`, end clamped to ≥15 min ago, paginated)
  - [x] Every response is Zod-parsed. A 4xx/5xx becomes a typed `BrokerHttpError` (status, Alpaca code) with no secrets in the message.
  - [x] Tests assert host-per-env, auth headers, query params, pagination and parsing against fixtures.
- **Verify:** `npx vitest run broker/alpaca`; gate
- **Depends on:** B1 · **Files:** `src/broker/alpaca.ts`, `test/broker/alpaca.test.ts`, `test/broker/fixtures/*` · **Scope:** M

### B3: `buildLots`
- **Acceptance:**
  - [x] Pure FIFO: open lots per symbol (`qty`, `costBasis`, `openedAt`) and realized closures (`qty`, `proceeds`, `costBasis`, `gain`, `openedAt`, `closedAt`) from FILL activities. **Deviation:** splits and other share-affecting corporate actions are *flagged as issues* (which blocks trading that symbol) rather than modelled, because their activity shapes vary and a wrong guess would corrupt basis. Revisit when one is actually observed.
  - [x] Tests: partial fills; several buys and a partial sell; a full close; a loss followed by a rebuy within 30 days (both closure and new lot present with dates); a split (flagged)
- **Verify:** `npx vitest run broker/lots`; gate
- **Depends on:** B1 · **Files:** `src/broker/lots.ts`, `test/broker/lots.test.ts` · **Scope:** S

### B4: Migration 0002
- **Acceptance:**
  - [x] Schema: `broker_account`, `broker_activities`, `orders`, `positions`, `equity_snapshots` per the spec, with `trading_allowed` + `blocked_reasons` on `broker_account`
  - [x] A custom migration adds a generic `reject_mutation()` trigger function and applies it to `broker_activities` (`audit_events` keeps its own, untouched). A guarded `REVOKE UPDATE, DELETE, TRUNCATE … FROM trader_app` runs when the role exists.
  - [x] Tests: a numeric round trip on a new column; UPDATE/DELETE on `broker_activities` raise; the `audit_events` trigger still raises
- **Verify:** `npx vitest run db audit`; `db:generate` clean; gate
- **Depends on:** B1 · **Files:** `src/db/schema.ts`, `drizzle/0002_*`, `drizzle/0003_*`, tests · **Scope:** M

### Checkpoint A
- [x] Gate green · `db:generate` clean · commit + push (staging deploy is still fine: B1's config requires the staging secrets, so **set them before this push**, which is the first step of B8)

### B5: `syncBroker` + `sync-broker` job
- **Acceptance:**
  - [ ] Clock and calendar gate: run while open or within 30 min after the close, otherwise `skipped: market closed`
  - [ ] Pins the account number; checks status, blocks, `max_margin_multiplier = "1"`, `no_shorting`, `fractional_trading`; upserts the account state
  - [ ] Activities insert-or-ignore from `max(at) − 3d` (full backfill on first run); orders upserted by `client_order_id` and audited on status transitions; positions replaced; one `equity_snapshots` row per trading date after the close
  - [ ] Reconciliation: open-lot qty per symbol = position qty (exact `Big` compare)
  - [ ] `trading_allowed` + `blocked_reasons` persisted; `broker.*` audit events on transitions only
  - [ ] `test/broker/fake-broker.ts` (scriptable in-memory adapter); `sync-broker` added to `JOBS` and to the engine's `*/15` schedule
- **Verify:** `npx vitest run broker/sync`; gate
- **Depends on:** B2, B3, B4 · **Files:** `src/broker/sync.ts`, `src/jobs.ts`, `test/broker/{sync.test,fake-broker}.ts`, `apps/engine/src/index.ts` · **Scope:** M

### B6: `submitOrder`
- **Acceptance:**
  - [ ] `clientOrderId(env, intentKey)`: deterministic, ≤48 chars, env-prefixed
  - [ ] Records the intent row + `order.intent` audit **before** the broker call. A known client id → `already_submitted` with no call. A rejection → `rejected` + audit. A timeout or network error → `unknown`, which `syncBroker` resolves via `getOrderByClientId`.
  - [ ] Validates notional (2 dp, ≥ $1) or qty (9 dp, > 0), not both
- **Verify:** `npx vitest run broker/orders`; gate
- **Depends on:** B4, B5 (fake broker) · **Files:** `src/broker/orders.ts`, `test/broker/orders.test.ts` · **Scope:** S

### B7: Scripts
- **Acceptance:**
  - [ ] `broker:configure -- --env <env> [--margin N]`: prints the current config and applies the safe one (or N for the SC-5 test, **staging only**)
  - [ ] `broker:capture -- --env staging`: records scrubbed fixtures
  - [ ] `broker:smoke`: refuses unless `--env staging` and the market is open; submits a $5 VTI buy through `submitOrder`, syncs until filled (≤2 min), asserts the lot = position and the audit trail, then re-submits the same intent and asserts `already_submitted`
- **Verify:** dry runs against paper (weekend: configure + capture; smoke refuses with "market closed")
- **Depends on:** B5, B6 · **Files:** `scripts/broker-{configure,capture,smoke}.ts`, `package.json` · **Scope:** S

### Checkpoint B
- [ ] Gate green · every exported function tested · Scott skims the `tradingAllowed` reasons and the transition-only auditing

## Phase 2: Staging, then production

### B8: Staging deploy + weekend verification
- **Acceptance:**
  - [ ] Staging Worker secrets `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` piped from `.env` (`STAGING_ALPACA_*`); `docs/SETUP.md` updated
  - [ ] `broker:configure -- --env staging` → safe config
  - [ ] Branch push → staging deploy; weekend ticks record `skipped: market closed`; heartbeat still healthy
  - [ ] SC-5: margin 2 → next eligible sync `tradingAllowed = false` + one `broker.config_unsafe`; restored → cleared (re-checked Monday if the market-closed gate prevents the weekend run; a `--force` sync script run is acceptable for this check)
- **Depends on:** B7 · **Files:** `docs/SETUP.md`, `scripts/set-alpaca-secret.sh` · **Scope:** S

### B9: Monday 2026-11-02 session (paper)
- **Acceptance:**
  - [ ] SC-2: during market hours staging syncs `succeeded` and the tables match the paper account
  - [ ] SC-3: `broker:smoke` passes
  - [ ] SC-4: one `equity_snapshots` row for 2026-11-02 after the close
  - [ ] Fixtures refreshed from the real fill (`broker:capture`)
- **Depends on:** B8 · **Scope:** XS (verification)

### B10: Production
- **Acceptance:**
  - [ ] *(Scott)* live key pair in `.env` (`PRODUCTION_ALPACA_*`); *(Scott)* runs `scripts/set-alpaca-secret.sh production` and `npm run broker:configure -w @trader/core -- --env production`
  - [ ] PR to `main` → production deploy; `/healthz` 200; first sync backfills; `trading_allowed = true`; **no orders placed**
  - [ ] SC-7: sync durations within free-plan CPU (from `job_runs`)
- **Depends on:** B9 · **Scope:** XS

### Checkpoint C
- [ ] All 7 spec success criteria checked · Scott reviews
