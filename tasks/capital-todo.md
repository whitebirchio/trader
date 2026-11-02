# Tasks: `capital`

> Plan: [capital-plan.md](capital-plan.md) · Spec: [SPEC-capital.md](../SPEC-capital.md) · ADR-015
> **gate** = `npm run typecheck && npm test`. Feature branches deploy to staging only. **PR 1** = Phase 1 (from `feat/capital`). **PR 2** = Phases 2–4 (a fresh branch from pulled `main`).

## Phase 1: Ledger (PR 1)

### C1: Activity dating fix
- [x] `toActivity`: a date-only non-trade activity gets `marketTimeToUtc(date, "12:00")`
- [x] Regression test: a `CSD` with only `date` → `marketDate(at) === date` (fails before the fix)
- **Files:** `src/broker/alpaca.ts`, `test/broker/alpaca.test.ts` · **Scope:** XS

### C2: `capital_flows` ledger
- [ ] Schema + migration: `capital_flows` (`activity_id` PK, `at`, signed `amount`, `kind`, `withdrawal_id` null), `trader_app` append-only REVOKE, backfill from `broker_activities`
- [ ] `capital/ledger.ts` (pure): activities → flows, with kind deposit / withdrawal / reversal
- [ ] `sync-broker` inserts flows idempotently and reports the date-only fallback count
- [ ] Tests: live shape (booked after `created_at`), paper shape (booked before), reversal, overlapping re-sync
- **Files:** `src/db/schema.ts`, `drizzle/*`, `src/capital/ledger.ts`, `src/broker/sync.ts`, tests · **Depends on:** C1 · **Scope:** M

### C3: Index by instant
- [ ] `buildIndex` / `liveIndex` take snapshots with `recordedAt` and flows `{ at, amount }`; a flow counts at the first snapshot recorded after it
- [ ] `risk/gate.ts`, `portfolio/benchmark.ts` and `dashboard/views.ts` read `capital_flows`; remove `flowsByDate` / `FLOW_TYPES`
- [ ] Tests: a 100% deposit and a 40% withdrawal, same-day / overnight / weekend → index 1, drawdown 0, daily change 0; `checkDrawdown` doesn't halt (PGlite); existing latch tests pass
- **Depends on:** C2 · **Scope:** M

### C4: Deposit notice + money-weighted comparison
- [ ] `capital/shadow.ts` (pure): the same flows into VTI at each flow date's close
- [ ] Contributed / value / same-flows VTI in `getOverview` and on the dashboard overview
- [ ] Audit kinds + routing + templates: `capital.deposit_received` (digest), `capital.deposit_reversed` (urgent), `capital.unplanned_outflow` (urgent)
- **Depends on:** C3 · **Scope:** M

### Checkpoint A
- [ ] Gate green · `db:generate` clean · staging deploy
- [ ] Paper `JNLC` in → `broker:sync --force`, `risk:status`, `notify:run`: ledger row, email, drawdown ~0, `rebalance:plan` invests it
- [ ] PR 1 → merge → `capital:status --env production` shows the April $1,000 deposit

## Phase 2: Withdrawals in the engine (PR 2)

### C5: Requests, commands, job, CLI
- [ ] Migration: `withdrawals`, `capital_commands` (append-only)
- [ ] `capital/withdrawals.ts`: pure `advance()` (status unions) + persistence
- [ ] `capital/commands.ts`: validate (one open; ≤ equity; `all`) → transition → owner audit
- [ ] Settlement from sell fills, T+1 trading day (Alpaca calendar)
- [ ] `process-capital` in `TICK_JOBS` after `sync-broker`
- [ ] Outflow matching: full → withdrawn; partial → remainder stays `ready`; none open → unplanned
- [ ] CLI: `capital:withdraw`, `capital:cancel`, `capital:fund-now`, `capital:status`
- [ ] Audit kinds + routing: requested, ready, completed, cancelled
- **Depends on:** C2 · **Scope:** L (split C5a pure / C5b wiring if needed)

### C6: Reserved cash
- [ ] `runRebalance`: investable = equity − outstanding
- [ ] `RiskSnapshot.withdrawal { outstanding, unfunded }`; rule: buys ≤ cash − buffer − outstanding
- [ ] Tests: $500 reserved on $1,000 VTI → sells ~$500, no buys; a buy into the reserve is rejected
- **Depends on:** C5 · **Scope:** S

### C7: Fallback strategy, staleness fix, deadline
- [ ] `capital/funding.ts` (pure): keep thesis dollars, re-weight, cap, pro-rata trim if needed → `system` version through `submitStrategy`
- [ ] `thesisStates`: staleness from the latest `claude`-authored version listing the thesis
- [ ] `ROUTINE_SLOTS_ET` constant (pinned by a test); deadline = next slot + 60 min; deadline or `fund_now` → fallback
- [ ] Tests: dollars kept, caps, theses > remainder, system version doesn't reset staleness, deadline over a weekend or holiday
- **Depends on:** C5 · **Scope:** M

### C8: Halted withdrawal-only mode
- [ ] Halted + unfunded > 0 → only sells, plan order, `purpose: "withdrawal"`, until cumulative ≥ unfunded
- [ ] Risk: withdrawal sells pass `drawdownHalt` while cumulative ≤ unfunded; kill switch, fresh-data and broker verdict still reject
- [ ] Tests: $300 unfunded → ~$300 of sells only; excess rejected; kill switch → nothing
- **Depends on:** C6 · **Scope:** M

### Checkpoint B
- [ ] Gate green · staging deploy
- [ ] Paper: `capital:withdraw --amount 50` → `fund-now` → fills → `settling` → `ready` (T+1) → `cancel` reinvests
- [ ] A forced-halt fixture sells only up to the amount

## Phase 3: Claude and the dashboard

### C9: Agent
- [ ] `getOverview.capital`: open request + deadline, flows since the last strategy, money-weighted vs VTI
- [ ] `previewStrategy`: post-withdrawal investable; per-sell realized gain/loss, ST/LT, wash-sale windows
- [ ] `submitStrategy` (claude, after a request) → `planning → funding` + `capital.funding_planned`
- [ ] Routine prompt withdrawal section; tool-list pin unchanged
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
