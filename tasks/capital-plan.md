# Implementation Plan: `capital`

> Implements [SPEC-capital.md](../SPEC-capital.md) (approved 2026-11-01) and ADR-015. Tasks are in [capital-todo.md](capital-todo.md).
> **Status: Approved** (Scott, 2026-11-01).

## Context

Scott wants to move money in and out of the Alpaca account freely. Today:
- **(a)** Flows are matched to equity snapshots by booking date, which Alpaca sets a day either side of the real instant. A large deposit or withdrawal can latch a false 20% drawdown halt.
- **(b)** With no cash buffer, nothing is withdrawable, and a manual sale gets bought back on the next step.

The approved design adds three things:
- an instant-timed **capital ledger**;
- **withdrawal requests**, funded by a Claude-authored strategy, with a deterministic fallback;
- **dashboard controls**.

The kill switch stays absolute, and withdrawal sells can pass the drawdown halt only up to the requested amount.

## Facts confirmed during planning (live account, read-only, 2026-11-01)

- **No withdrawable-cash field** on `GET /v2/account`. The fields are `cash`, `non_marginable_buying_power`, `transfers_blocked`, and the rest. So **settlement is computed from sell fills**: proceeds settle T+1 trading day, using Alpaca's calendar (`getCalendar`). [Certain]
- **No transfer endpoints** on the Trading API: `/v2/transfers`, `/v2/account/transfers` and `/v2/ach_relationships` all return 404. **The ACH stays manual in Alpaca**, as the spec assumed. [Certain]
- The tick runs every 15 minutes, all day (`infra/lib/engine-stack.ts`, `cron(0/15 * * * ? *)`). A new tick job therefore processes dashboard commands around the clock.
- `thesisStates` (`src/portfolio/theses.ts:46`) measures staleness from the **active version's `createdAt`**. A system-authored fallback version would silently reaffirm every thesis, so this has to change (C7).
- `trader_dashboard` gets its grants from `scripts/dashboard-role.ts` (`default_transaction_read_only = on`), not from migrations. Its one INSERT grant goes there. The write uses a read-write transaction over neon-http. [Likely: verify in C11]

## Dependency graph

```
C1 dating fix ─▶ C2 capital_flows ledger + sync ─▶ C3 index by instant ─▶ C4 deposit notice + money-weighted vs VTI
                                                        │
                       ┌────────────────────────────────┘
                       ▼
C5 withdrawals + commands + process-capital job + CLI ─▶ C6 reserved cash (targets + risk rule)
                                                        ├─▶ C7 fallback strategy + staleness fix + deadline
                                                        └─▶ C8 halted withdrawal-only mode
                                                                   │
                          C9 agent (overview, preview tax view, prompt) ◀┤
                          C10 dashboard Money page (read)             ◀┤
                          C11 dashboard writes ─ needs C10             │
                          C12 notification templates + digest       ◀──┘
                                                                   ▼
                                                           C13 docs, PR, production
```

## Architecture decisions (made during planning)

- **Two PRs.**
  - **PR 1 = Phase 1** (C1–C4): the ledger and the false-halt fix. It ships to production first, so a deposit is safe before any withdrawal work lands.
  - **PR 2 = Phases 2–4**, on a fresh branch from pulled `main` (memory: branch from fresh main).
- **Reuse, don't duplicate.**
  - `marketTimeToUtc` (`src/time.ts`) for the noon-ET fallback and the deadline.
  - `buildLots` (`src/broker/lots.ts`) for realized gain/loss and settlement dates.
  - `washSaleWindow` (`src/portfolio/planner.ts`) for the preview's wash-sale column.
  - `submitStrategy` (`src/portfolio/store.ts`) for the fallback version: a new `"system"` actor path, validated like any strategy.
  - `buildTargets`' existing `investable` seam (`src/portfolio/targets.ts:66`).
  - `recordEvent` and the outbox for every notice.
- **`capital_flows` is append-only.** It follows the `0009_portfolio_append_only.sql` pattern, so the `trader_app` REVOKE lives in a migration. The `withdrawals` table is mutable state, like `orders`. Every transition writes an audit event.
- **`Proposal` gets an optional `purpose: "withdrawal"`.** Risk trusts the tag only up to `snapshot.withdrawal.unfunded`, which `loadSnapshot` reads from the database.
- **Routine slots become a core constant** (`ROUTINE_SLOTS_ET = ["08:00", "12:00"]`), with a test that pins it to the routine cron documented in SPEC-agent. Deadline = the next slot on a trading day + 60 min.
- **Claude's decision** = the first `claude`-authored `submitStrategy` after the request. `submitStrategy` notifies capital, which moves the request `planning → funding` and emits `capital.funding_planned` with Claude's summary.

## Task list

### Phase 1: Ledger (PR 1)
- [ ] **C1: Activity dating fix.** In `toActivity`, a date-only activity gets `marketTimeToUtc(date, "12:00")`. Regression test: `marketDate(at) === date`. Files: `src/broker/alpaca.ts`, `test/broker/alpaca.test.ts`. Scope: XS.
- [ ] **C2: `capital_flows` ledger.**
  - Migration: table, append-only REVOKE, backfill from `broker_activities`.
  - `capital/ledger.ts` (pure): activities → flows, with `kind` = deposit / withdrawal / reversal.
  - `sync-broker` inserts rows idempotently and counts date-only fallbacks in its result.
  - Tests: the live shape (booked after `created_at`), the paper shape (booked before), a reversal, and idempotent re-sync.
  - Files: `src/db/schema.ts`, a drizzle migration, `src/capital/ledger.ts`, `src/broker/sync.ts`, tests. Scope: M.
- [ ] **C3: Index by instant.**
  - `buildIndex` and `liveIndex` take snapshots `{ tradingDate, equity, recordedAt }` and flows `{ at, amount }`.
  - Callers switch to `capital_flows`: `risk/gate.ts`, `portfolio/benchmark.ts`, `dashboard/views.ts`. Remove `flowsByDate` and `FLOW_TYPES` from risk.
  - Tests: a 100% deposit and a 40% withdrawal, timed same-day, overnight and over a weekend, leave the index at 1, drawdown 0 and daily change 0. `checkDrawdown` doesn't halt (PGlite). Existing latch tests still pass.
  - Scope: M.
- [ ] **C4: Deposit notice + money-weighted comparison.**
  - `capital/shadow.ts` (pure): the same flows into VTI at each flow date's close (`broker/benchmark-closes.ts`).
  - Contributed / value / same-flows VTI added to `getOverview` and the dashboard overview.
  - Audit kinds `capital.deposit_received` (digest), `capital.deposit_reversed` (urgent) and `capital.unplanned_outflow` (urgent), routed in `routing.ts`, with email templates.
  - Scope: M.

### Checkpoint A
- [ ] Gate green, `db:generate` clean, staging deploy.
- [ ] A paper `JNLC` journal in, then `broker:sync --force`, `risk:status` and `notify:run`: the ledger row appears, the deposit email arrives, drawdown is ~0, and the next `rebalance:plan` invests it.
- [ ] PR 1, then merge (production migration and backfill), then `capital:status --env production` shows the April $1,000 deposit. **Scott can deposit safely from here on.**

### Phase 2: Withdrawals in the engine (PR 2)
- [ ] **C5: Requests, commands, job, CLI.**
  - Migration: `withdrawals` (status, amount or `all`, outstanding, deadline, strategy version, timestamps) and `capital_commands` (append-only).
  - `capital/withdrawals.ts`: a pure `advance()` state machine returning status unions, plus persistence.
  - `capital/commands.ts`: validates (one open request; amount ≤ equity) → transitions → owner audit event.
  - Settlement from sell fills at T+1 trading day.
  - A `process-capital` job in `TICK_JOBS`, after `sync-broker`.
  - CLI: `capital:withdraw`, `capital:cancel`, `capital:fund-now`, `capital:status` (laptop, owner role).
  - Matching an outgoing flow: a full flow closes the request, a partial one leaves the remainder `ready`, and an outflow with no request is "unplanned".
  - Audit kinds and routing for `requested`, `ready`, `completed` and `cancelled`.
  - Scope: L. Split C5a (state machine + tests) and C5b (persistence, job, CLI) if it runs long.
- [ ] **C6: Reserved cash.**
  - `runRebalance` passes `equity − outstanding` as investable.
  - `RiskSnapshot` gains `withdrawal: { outstanding, unfunded }`.
  - A new rule: buys ≤ cash − buffer − outstanding.
  - Tests: $500 reserved on $1,000 in VTI → the plan sells about $500 and buys nothing; risk rejects a buy that would dip into the reserve.
  - Files: `rebalance.ts`, `risk/types.ts`, `risk/rules.ts`, `risk/gate.ts`. Scope: S.
- [ ] **C7: Fallback strategy, staleness fix, deadline.**
  - `capital/funding.ts` (pure): keep each thesis's dollars; weight = value ÷ (equity − amount), capped at the position cap; trim theses pro rata if they exceed the remainder.
  - The result is submitted as a `system` version.
  - `thesisStates` measures staleness from the **latest `claude`-authored version that listed the thesis** (a store query).
  - Deadline: `ROUTINE_SLOTS_ET` + 60 min. When it passes, or on `fund_now`, the fallback runs.
  - Tests: thesis dollars kept, caps, theses exceeding the remainder, a system version not resetting staleness, the deadline across a weekend or holiday.
  - Scope: M.
- [ ] **C8: Halted withdrawal-only mode.**
  - When `halted` is true and there's unfunded withdrawal money, `runRebalance` plans from the active strategy but submits only sells, in plan order, tagged `purpose: "withdrawal"`, until cumulative notional ≥ unfunded.
  - Risk lets them past `drawdownHalt` while cumulative ≤ unfunded. The kill switch, fresh-data and broker-verdict rules still reject.
  - Tests: halted + $300 unfunded → about $300 of sells and nothing else; any excess is rejected; kill switch on → nothing.
  - Scope: M.

### Checkpoint B
- [ ] Gate green and staging deploy.
- [ ] CLI end-to-end on paper: `capital:withdraw --amount 50` → `capital:fund-now` → sells fill → `capital:status` shows `settling`, then `ready` after T+1 → `capital:cancel` reinvests at the next step.
- [ ] A forced halt in a staging DB fixture sells only up to the amount.

### Phase 3: Claude and the dashboard
- [ ] **C9: Agent.**
  - `getOverview` gains a `capital` section: the open request, its deadline, flows since the last strategy, and the money-weighted comparison.
  - `previewStrategy` previews against post-withdrawal investable equity and adds, per sell: realized gain/loss, short- vs long-term (from FIFO lots) and wash-sale windows touched.
  - `submitStrategy` hook → `capital.funding_planned`.
  - A withdrawal section in `agent/routine-prompt.md`.
  - The tool-list pin is unchanged: no new write tool.
  - Files: `src/agent/tools.ts`, `src/portfolio/store.ts`, `apps/mcp` instructions, the prompt. Scope: M.
- [ ] **C10: Dashboard Money page (read).** `src/app/(signed-in)/money/page.tsx`: the ledger, contributed / value / VTI, and the open request's timeline with its deadline. Nav link. Scope: S.
- [ ] **C11: Dashboard writes.**
  - `scripts/dashboard-role.ts`: `GRANT INSERT ON capital_commands` only. The role check proves INSERT on every other table, and any UPDATE or DELETE, still fail.
  - POST route handlers for request, fund-now and cancel, each with an owner-session check, an `Origin` check and a per-form CSRF token (HMAC over the session).
  - A confirmation step that repeats the amount, and a read-write transaction.
  - Tests: CSRF and Origin rejection, a session-less POST → 401.
  - Infra assertions: still no Alpaca or SES access.
  - SPEC-dashboard's read-only boundary gets amended (ADR-015).
  - Scope: M.
- [ ] **C12: Notifications.** Templates for `funding_planned` (Claude's summary and the sells), `ready` ("withdraw $X in Alpaca"), `completed` and `cancelled`. The digest lists any open request every day until it closes. `notify:preview` fixtures. Scope: S.

### Checkpoint C
- [ ] Gate green and staging deploy.
- [ ] A dashboard withdrawal on staging: request (urgent email) → a Claude-authored strategy (run the routine manually against the staging connector) **or** *Fund now* → sells → `ready` email → cancel reinvests.

### Phase 4: Ship
- [ ] **C13: Docs and production.**
  - Living specs updated: broker, risk, portfolio, agent, dashboard, notifications.
  - `CLAUDE.md` gets an architecture line for `capital`.
  - PR 2, then merge, then the production check: the Money page is correct, then a **$10 real withdrawal** end to end. That's the only test of a live `CSW` and how its timing lines up with equity.
  - Move both task files to `tasks/done/`.

## Verification

- Every task: `npm run typecheck && npm test`. Run `npm run db:generate -w @trader/core` after schema edits.
- Operator checks on demand, not via cron:
  - `npm run broker:sync -w @trader/core -- --env staging --force`
  - `npm run rebalance:plan -w @trader/core -- --env staging --sync`
  - `npm run notify:run -w @trader/core -- --env staging`
  - `npm run capital:status -w @trader/core -- --env staging`
  - `npm run invoke -- --env staging --jobs sync-broker,process-capital`
- Dashboard: `npm run db:dashboard-role -w @trader/core` proves the single INSERT grant. Then a manual run through the Money page on trader-staging.whitebirch.io.
- Production: after PR 1, `capital:status --env production`. After PR 2, the $10 withdrawal.

## Risks

| Risk | Mitigation |
|---|---|
| A live `CSW`'s shape or timing differs from paper | The $10 production test before any real withdrawal. The ledger records unknown shapes as unplanned flows (urgent email), never guesses. |
| T+1 settlement is computed wrong and Alpaca refuses the ACH | `ready` email wording: "should be withdrawable". The request stays `ready` until the flow posts, so a refused ACH just means retry. |
| The fallback version silently reaffirms theses | Fixed in C7 by measuring staleness from Claude-authored versions, with a test. |
| The dashboard write path widens the attack surface | A single append-only INSERT, CSRF + Origin + session checks, an email on every command, no broker keys. The worst case is forced sells, never money out. |
| Neon-http read-only default blocks the INSERT | Verified first in C11. Fallback: a pooled connection with `SET TRANSACTION READ WRITE`. |
