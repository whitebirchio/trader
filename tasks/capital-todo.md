# Tasks: `capital`

> Plan: [capital-plan.md](capital-plan.md) · Spec: [SPEC-capital.md](../SPEC-capital.md) · ADR-015
> **gate** = `npm run typecheck && npm test`. Feature branches deploy to staging only. **PR 1** = Phase 1 (from `feat/capital`). **PR 2** = Phases 2–4 (a fresh branch from pulled `main`).

## Phase 1: Ledger (PR 1)

### C1: Activity dating fix
- [x] `toActivity`: a date-only non-trade activity gets `marketTimeToUtc(date, "12:00")`
- [x] Regression test: a `CSD` with only `date` → `marketDate(at) === date` (fails before the fix)
- **Files:** `src/broker/alpaca.ts`, `test/broker/alpaca.test.ts` · **Scope:** XS

### C2: `capital_flows` ledger
- [x] Schema + migrations `0011_capital_flows` / `0012_capital_flows_append_only`: `capital_flows` (`activity_id` PK → broker_activities, `at`, signed `amount`, `kind`, `timed_by`, `status`), trigger + `trader_app` REVOKE. *No `withdrawal_id` (the table is append-only; C5 links from `withdrawals`). Backfill = the first `recordCapitalFlows` run.*
- [x] `capital/ledger.ts` (pure): activities → flows, with kind deposit / withdrawal / reversal
- [x] The `sync-broker` job (and `broker:sync`) records flows idempotently before `checkDrawdown`, and reports `capital: { added, timedByBookingDate }`
- [x] Tests: live shape (booked after `created_at`), paper shape (booked before), reversal, overlapping re-sync, job wiring, append-only
- **Files:** `src/db/schema.ts`, `drizzle/*`, `src/capital/ledger.ts`, `src/broker/sync.ts`, tests · **Depends on:** C1 · **Scope:** M

### C3: Index by instant
- [x] `buildIndex` / `liveIndex` take snapshots with `recordedAt` and flows `{ at, amount }`; a flow counts at the first snapshot recorded after it. Live flows count only up to when the equity was read (`broker_account.synced_at`); daily change is measured against the latest snapshot before today; `canceled` transfers are left out
- [x] `risk/gate.ts` (`loadIndexInputs`, `currentIndex(db, account, now)`), `portfolio/benchmark.ts` and `dashboard/views.ts` read `capital_flows`; `flowsByDate` / `FLOW_TYPES` removed
- [x] Tests: a 100% deposit and a 40% withdrawal, same-day / overnight / weekend → index 1, drawdown 0, daily change 0; `checkDrawdown` doesn't halt after a 100% deposit that lands after a snapshot (fails on the old code); canceled ignored; existing latch tests pass
- **Depends on:** C2 · **Scope:** M

### C4: Deposit notice + money-weighted comparison
- [x] `capital/shadow.ts`: `sameFlowsInBenchmark` (pure; last close on or before each flow's market date) + `capitalSummary(db, equity)` from the ledger and `benchmark_closes` (DB only)
- [x] Contributed / value / same-flows VTI in `getOverview` (`capital`), the dashboard overview ("Your money" card) and the daily digest
- [x] Audit kinds + routing + templates, recorded with each new flow in one transaction: `capital.deposit_received` (digest, "Money in and out" section), `capital.transfer_reversed` (urgent; either direction), `capital.transfer_canceled` (urgent), `capital.unplanned_outflow` (urgent). Flows older than 7 days are recorded silently, so the first run's backfill sends nothing
- **Depends on:** C3 · **Scope:** M

### Checkpoint A
- [x] Gate green · `db:generate` clean · staging deploy
- [x] Paper `JNLC` in → `broker:sync --force`, `risk:status`: the backfilled $100k journal recorded silently (older than 7 days), drawdown 0, `get_overview.capital` live. *A fresh paper deposit needs funds added by hand in Alpaca's paper dashboard; covered by tests.*
- [x] PR 1 (#20) → merge → production migrated and deployed; a forced sync recorded the April $1,000 deposit silently; `get_overview.capital` = contributed $1000, value $1000, same flows in VTI $1065.74; drawdown 0, no halt

## Phase 2: Withdrawals in the engine (PR 2)

### C5: Requests, commands, job, CLI
- [x] Migration: `withdrawals` (one open: a partial unique index), `capital_commands` + `capital_command_results` (append-only)
- [x] `capital/withdrawals.ts`: pure `advance()` (status unions) + persistence in `capital/commands.ts`
- [x] `capital/commands.ts`: validate (one open; ≤ equity; `all`) → transition → owner audit; a rejected command is recorded and emailed
- [x] Settlement from sell fills, T+1 trading day (Alpaca calendar; the next trading day's close)
- [x] `process-capital` in `TICK_JOBS` after `sync-broker` (skips without a broker call when idle)
- [x] Outflow matching: full → withdrawn; partial → remainder stays open; none open → unplanned (the ledger stays quiet for outflows during an open request)
- [x] CLI: `capital:withdraw`, `capital:cancel`, `capital:fund-now` (queue, then process at once), `capital:status`
- [x] Audit kinds + routing + email copy: requested, fund_now, cancelled, command_rejected, funding_planned, settling, ready, partial, completed
- *Pulled forward from C7:* `ROUTINE_CRON_UTC` (pinned to SPEC-agent's cron) and `fundingDeadline`; `fund_now` sets the deadline to now. `all` skips planning (nothing is investable whatever the plan).
- **Depends on:** C2 · **Scope:** L (split C5a pure / C5b wiring if needed)

### C6: Reserved cash
- [x] `runRebalance`: investable = equity − outstanding (so `preview_strategy` previews against it too)
- [x] `RiskSnapshot.withdrawal { outstanding, unfunded }` (`risk/reserve.ts`, below portfolio and capital); rule: buys ≤ cash − buffer − outstanding
- [x] While unfunded > 0 the planner sells anything over target back to it, ignoring the drift band (down to $1), so a small withdrawal can't stall inside the band
- [x] Tests: $500 reserved on $1,000 VTI → sells ~$500, then on target with $500 idle; a $20 top-up sells inside the band; a buy into the reserve is clipped or rejected
- **Depends on:** C5 · **Scope:** S

### C7: Fallback strategy, staleness fix, deadline
- [x] `capital/funding.ts`: `fallbackStrategy` (pure) keeps thesis dollars (planned dollars for one not bought yet), re-weights, caps at 20%, trims pro rata if needed, drops stopped theses → a `system` version through `submitStrategy` (the active document resubmitted unchanged if that were ever rejected)
- [x] Staleness from `ActiveStrategy.reaffirmedAt`: the latest version Claude *or the owner* wrote (a system version only copies the theses it replaces); used by the rebalance, `get_strategy` and the dashboard
- [x] Deadline (done in C5) or `fund_now` → `processCapital` runs the fallback, then the request moves to funding on the same tick
- [x] Tests: dollars kept, caps, theses > remainder, stopped dropped, a system version doesn't reset staleness, deadline and fund_now end to end
- **Depends on:** C5 · **Scope:** M

### C8: Halted withdrawal-only mode
- [x] Halted + unfunded > 0 → `withdrawalSells`: only the plan's sells, plan order, `purpose: "withdrawal"`, the last sized to the remainder (qty rounded up)
- [x] Risk: withdrawal sells pass the halt while cumulative < unfunded, clipped to unfunded + $1 (the round-up); kill switch, fresh-data and broker verdict still reject; nothing owed → still rejected
- [x] Tests: $300 unfunded → $300 of VTI sold, then nothing; excess rejected or clipped; kill switch → nothing
- [x] Found on the way: sells rounded down left cash a hair short, so a request could sit in `funding` forever. Raising sells now round up, and a request is funded / settled / withdrawn within `CASH_TOLERANCE` ($1, Alpaca's minimum order); the ready email names what's actually withdrawable
- **Depends on:** C6 · **Scope:** M

### Checkpoint B
- [ ] Gate green · staging deploy
- [ ] Paper: `capital:withdraw --amount 50` → `fund-now` → fills → `settling` → `ready` (T+1) → `cancel` reinvests
- [ ] A forced-halt fixture sells only up to the amount

## Phase 3: Claude and the dashboard

### C9: Agent
- [x] `getOverview.capital` (`capital/overview.ts`, DB-only so the Money page can reuse it): money-weighted summary, transfers since the theses were last reaffirmed, the open request with `outstanding`, `unfunded`, `investableEquity` and `planBy`
- [x] `previewStrategy`: post-withdrawal investable (C6) and a `tax` block per sell: realized gain, short- vs long-term (FIFO, `estimateSale`), and the wash-sale window a loss opens
- [x] Claude's strategy after a request → `planning → funding` on the next tick (process-capital, ≤ 15 min; portfolio can't call capital), and `capital.funding_planned` carries the plan's summary into the email
- [x] Routine prompt section 3a, MCP instructions item 8, `get_rules.withdrawals`, tool descriptions; tool-list pin unchanged (no new write tool)
- **Depends on:** C7 · **Scope:** M

### C10: Dashboard Money page (read)
- [ ] `money/page.tsx`: ledger, contributed / value / VTI, request timeline + deadline; nav link
- **Depends on:** C4, C5 · **Scope:** S

### C11: Dashboard writes
- [ ] `dashboard-role.ts`: `GRANT INSERT ON capital_commands` only; the role check proves everything else is still denied
- [ ] POST handlers (request, fund-now, cancel): owner session + `Origin` + CSRF token; a confirmation step; a read-write transaction (verify neon-http first)
- [ ] Tests: CSRF / Origin rejection, session-less → 401; infra: still no Alpaca or SES
- [ ] SPEC-dashboard read-only boundary amended (ADR-015)
- **Depends on:** C10 · **Scope:** M

### C12: Notifications
- [ ] Templates: `funding_planned` (summary + sells), `ready`, `completed`, `cancelled`; digest lists the open request; `notify:preview` fixtures
- **Depends on:** C5, C9 · **Scope:** S

### Checkpoint C
- [ ] Gate green · staging deploy
- [ ] Dashboard withdrawal on staging: request → Claude (routine run manually on staging) or *Fund now* → sells → `ready` email → cancel reinvests

## Phase 4: Ship

### C13: Docs and production
- [ ] Living specs: broker, risk, portfolio, agent, dashboard, notifications; `CLAUDE.md` architecture line
- [ ] PR 2 → merge → Money page correct → **$10 real withdrawal** end to end
- [ ] Move `capital-plan.md` / `capital-todo.md` to `tasks/done/`
