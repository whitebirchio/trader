# Implementation Plan: `broker`

> Implements [SPEC-broker.md](../SPEC-broker.md) (approved 2026-10-31). Tasks are tracked in [todo.md](todo.md). The foundation plan is archived in [done/](done/).
> **Status: DRAFT — awaiting approval.**

## Overview

Add the Alpaca adapter, the `sync-broker` job (account checks, activities, orders, positions, equity snapshots, FIFO lots and reconciliation, `tradingAllowed`), and an idempotent `submitOrder`. Everything is built and verified on staging (paper) first. The paper fill and after-close snapshot checks wait for Monday 2026-11-02. Production gets the live keys and its account configuration **before** the merge to `main`, because merging makes Alpaca config required there.

## Dependency graph

```
B1 config + port types ──┬── B2 Alpaca adapter (reads) ──┐
                         │                                ├── B5 sync-broker job ──┐
                         ├── B3 FIFO lots (pure) ─────────┤                         ├── B7 scripts: configure + smoke
                         └── B4 migration 0002 ───────────┘── B6 submitOrder ───────┘          │
                                                                                               ▼
                                                    B8 staging: deploy + weekend checks ── B9 Monday: paper fill + snapshot
                                                                                               │
                                                                                               ▼
                                                                           B10 production: live keys → configure → merge
```

## Architecture decisions (made during planning)

- **The adapter lives in core** (`src/broker/alpaca.ts`), taking an injected `fetch` and a `TradingEnv`. It's pure HTTP with no SDK, so it needs no separate package, and the port still keeps `sync`/`orders` testable with a fake broker.
- **`tradingAllowed` is persisted** on the `broker_account` row as `trading_allowed` plus `blocked_reasons` (jsonb). Audit events fire on **transitions only** (reasons added or cleared), so a stuck condition produces one event, not 96 a day. `risk` will read this row.
- **`broker_activities` is insert-only.** It gets the same trigger pattern as `audit_events` (a generic `reject_mutation()` function, reused for both). The REVOKE for `trader_app` sits in a `DO` block guarded by `pg_roles`, so the migration still runs in PGlite, where the role doesn't exist.
- **`client_order_id`** is the caller-supplied intent key (e.g. `portfolio`'s `<plan-id>:<symbol>:<side>`), hashed to fit Alpaca's 48-character limit and prefixed with the env (`stg-`/`prd-`) so the two accounts' ids never collide in logs.
- **Sync windows:** activities are fetched from `max(at) − 3 days`, so late-posting activities (dividends, corrections) are caught. Insert-or-ignore makes the overlap free. The first sync backfills the account's whole history.
- **Equity snapshot:** the first sync after the close on a trading day writes that date's row. It's keyed by `trading_date`, so later syncs that day are no-ops.
- **Fixtures** are recorded from the paper account by `scripts/broker-capture.ts`, scrubbed of account numbers and ids. Fill and order fixtures are refreshed after Monday's smoke trade. Until then, tests use fixtures shaped from Alpaca's documented schema, marked as such.

## Task list

### Phase 1: Core (offline, PGlite + fakes)
- [ ] B1: Config vars + port and domain types
- [ ] B2: `AlpacaBroker` read methods + fixtures
- [ ] B3: `buildLots` (FIFO, realized closures, splits)
- [ ] B4: Migration 0002 (tables, insert-only activities)

### Checkpoint A
- [ ] Gate green · `db:generate` clean

- [ ] B5: `syncBroker` + `sync-broker` job + fake broker
- [ ] B6: `submitOrder` (idempotent, timeout recovery)
- [ ] B7: `broker:configure`, `broker:capture`, `broker:smoke` scripts

### Checkpoint B
- [ ] Gate green · every exported function tested · Scott skims the sync/`tradingAllowed` behaviour

### Phase 2: Staging, then production
- [ ] B8: Staging secrets + deploy + weekend verification (SC-2 skip path, SC-5)
- [ ] B9: Monday session: smoke fill, live sync, after-close snapshot (SC-2, SC-3, SC-4)
- [ ] B10: Production: live keys, configure, merge, read-only sync (SC-6, SC-7)

### Checkpoint C (complete)
- [ ] All 7 success criteria verified · Scott reviews · next: `SPEC-risk.md` / `SPEC-notifications.md`

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Merging makes Alpaca keys required in production | High (prod 503) | B10 sets the live secrets and verifies the config **before** the merge. Production returns 503 until then, but nothing trades, so the worst case is only a red health check. |
| Alpaca response shapes differ from the docs | Med | Zod-parse at the edge, with fixtures recorded from the real paper account (B7) and refreshed after a real fill (B9). |
| Lots drift from positions (splits, transfers, corrections) | Med | Reconciliation on every sync sets `tradingAllowed = false` with a reason, so a mismatch stops trading. Lots are recomputed from activities each time, so a fix to the activity data heals them. |
| Ambiguous submit (timeout) leads to a duplicate order | High | Intent row first, a fixed `client_order_id`, and recovery by lookup. The client id is never regenerated. |
| Paper fills don't behave like live fills | Low | Accepted. Paper is for code paths; the live account sees no orders until `risk` exists. |
| Free-plan CPU (10 ms) is exceeded by a sync with many activities | Low | First-sync backfill is the worst case. Durations are recorded in `job_runs`. Fallback: paginate the backfill across ticks. |
| The live account has holdings that predate the system | Unknown | The first production sync backfills all activities, so lots include them. Pre-existing positions are fine, but tell me if the $1k is already invested. |

## Open questions

- None blocking. B10 needs the live key pair and about 5 minutes of your time.
