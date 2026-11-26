# Todo: the dashboard's information architecture (SPEC-dashboard Amendment 3)

Plan: [dashboard-ia-plan.md](dashboard-ia-plan.md). Gate before every commit: `npm run typecheck && npm test`. Each PR is cut from freshly pulled `main`.

## PR 1: headline and exit list (fields first)

### T1: The fields in the schemas
- [x] **What:** the thesis schema (`strategy.ts`) gains `headline` (10–120 characters) and `exitIf` (1–3 strings, each up to 120). A `watch` note gains `headline` (in `watchlist.ts`, plus a nullable `watchlist_notes.headline` column through an additive migration). All are optional, so stored versions and notes stay valid.
- **Acceptance:**
  - Every stored strategy version in the test fixtures still parses.
  - Out-of-range values are refused with a field path.
  - `readWatchlist` returns `headline` (or null).
- **Verify:** `npx vitest run strategy watchlist` (in packages/core); `npm run db:generate -w @trader/core` produces an additive migration only.
- **Files:** `packages/core/src/portfolio/strategy.ts`, `packages/core/src/agent/watchlist.ts`, `packages/core/src/db/schema.ts`, `drizzle/*`, tests.
- **Depends on:** none · **Scope:** M

### T2: Required on Claude's new bets, and in the routine's instructions
- [x] **What:** `presentationErrors(next, active)` requires `headline` and `exitIf` on a new thesis or a raised weight, wired beside `bearCaseErrors` under `requireBearCase`. `update_watchlist` requires a headline on a new `watch` note. The tool descriptions, the MCP instructions and `agent/routine-prompt.md` explain both. The headline is the bet in plain words, and each exit condition is one someone could check. The next run adds them to every held thesis and open name. Short notes go into SPEC-portfolio and SPEC-agent.
- **Acceptance:**
  - A new thesis without either field is refused, with a message saying what to write.
  - A held thesis at the same weight passes without them.
  - Owner and fallback submissions are exempt.
  - The prompt asks for the backfill.
- **Verify:** `npx vitest run theses tools watchlist`; the gate.
- **Files:** `packages/core/src/portfolio/theses.ts`, `packages/core/src/portfolio/store.ts`, `packages/core/src/agent/tools.ts`, `apps/mcp/src/instructions.ts`, `agent/routine-prompt.md`.
- **Depends on:** T1 · **Scope:** M

### Checkpoint A (after PR 1 merges)
- [ ] The next two runs leave every held thesis with `headline` and `exitIf`, and every open watchlist name with a headline (`get_strategy`, `get_watchlist`). If not: Risk 3's switch.

## PR 2: the data (tables and read models; no page changes)

### T3: Spike: can the position history be rebuilt? (read-only, run first)
- [x] **What:** a throwaway script, not committed, rebuilds each trading day's positions from the fills and FIFO lots, values them at the stored official closes, adds the day's cash, and compares the result with `equity_snapshots`. It runs on production data through `trader_readonly`.
- **Acceptance:**
  - A short report: the days that match to the cent, the days that don't, and why (after-hours drift, interest, missing closes).
  - A recommendation on the reconciliation rule. If it's anything looser than "to the cent", ask Scott.
- **Verify:** the report's figures, spot-checked by hand against two days' fills.
- **Files:** a scratch script only.
- **Depends on:** none · **Scope:** S
- **Done 2026-11-26:**
  - Cash rebuilt to within cents every day (fill rounding).
  - Positions at adjusted closes drifted with later dividends, so raw closes are used.
  - At raw closes, most days matched within cents. A day with a big after-hours move was off by dollars, because each equity snapshot is Alpaca's after-close mark.
  - Scott approved the reconciling "after-close pricing" line (SPEC-dashboard § Position history, revised).

### T4: `position_snapshots`, written after the close
- [x] *(Built as the `position-history` tick job, not a `sync-broker` write, because a session's raw close is final only about 45 minutes after the bell. Cash comes from the equity snapshot, and positions are valued at raw closes. Verified on production's data, read-only: every recorded session rebuilds, with no gaps.)* **What:** a new additive table, `position_snapshots (trading_date, symbol, qty, market_value, cost_basis, close)`. `sync-broker`'s after-close phase writes one row per held symbol: qty × the session's official close (falling back to the position's price, marked). It's idempotent per date.
- **Acceptance:**
  - A second after-close sync on the same date changes nothing.
  - The rows plus cash reconcile with the day's equity under T3's rule.
  - The open phase writes nothing.
- **Verify:** `npx vitest run sync`; `npm run broker:sync -w @trader/core -- --env paper --force`, then check the rows in the paper database.
- **Files:** `packages/core/src/db/schema.ts`, `drizzle/*`, `packages/core/src/broker/sync.ts`, tests.
- **Depends on:** T3 · **Scope:** M

### T5: The backfill
- [x] *(The job's first run is the backfill, since it writes every missing completed day. `npm run positions:history -- --env production` is the read-only report. After merge: check the job's first run, then the report.)* **What:** `npm run positions:backfill -w @trader/core -- --env production [--dry-run]` rebuilds `position_snapshots` from the account's first fill, with T4's valuation. It writes only the days that reconcile, and lists the rest.
- **Acceptance:**
  - `--dry-run` writes nothing and prints the counts.
  - A rerun changes nothing.
  - A seeded account with a partial sale and a deposit rebuilds exactly.
- **Verify:** `npx vitest run backfill`; then Scott runs the dry run and the real run on production.
- **Files:** `packages/core/scripts/positions-backfill.ts`, `packages/core/src/dashboard/position-history.ts`, `packages/core/package.json`, tests.
- **Depends on:** T4 · **Scope:** M

### T6: The ranges, and money figures for any window
- [x] **What:** the ranges become `1d`, `7d`, `30d`, `60d`, `90d`, `ytd`, `1y` and `all`, in calendar days. A range the history doesn't reach is disabled, as today. `capitalSummaryOver(db, from, through)` generalizes `capitalSummary`. `performanceView` returns every range's P&L in dollars, return, VTI and gap at once, plus the chosen range's series.
- **Acceptance:**
  - `all` matches `capitalSummary` and `compareToBenchmark` exactly.
  - Each range's base is the last close on or before its start.
  - The thesis chart's ranges are unaffected.
- **Verify:** `npx vitest run ranges shadow views`.
- **Files:** `packages/core/src/dashboard/ranges.ts`, `packages/core/src/capital/shadow.ts`, `packages/core/src/dashboard/views.ts`, tests.
- **Depends on:** none · **Scope:** M

### T7: Profit and loss by position, per range
- [x] **What:** `positionsPnl(db, from, through)` computes, for each symbol, the value at the end, minus the value at the start, minus net buys over the range (sells are added back), using `position_snapshots` and the fills. A position opened or closed inside the range counts from or to zero. Before the snapshots reach the range's start, it falls back to the scorecard figures since bought, marked.
- **Acceptance:** the positions plus cash and interest sum to T6's P&L for every range on seeded data, including a mid-range buy, a full sale and a deposit.
- **Verify:** `npx vitest run positions-pnl`.
- **Files:** `packages/core/src/dashboard/positions-pnl.ts`, tests.
- **Depends on:** T5, T6 · **Scope:** M

### T8: The four Sankey builders
- [x] **What:** `sankey.ts` exports `moneySankey`, `pnlSankey`, `ideaFunnelSankey` and `signalSankey`. Each returns `SankeyData` (decimal-string values), with an optional cap that groups the smallest nodes as "Other".
- **Acceptance:** each reconciles to its total to the cent, with and without the cap. The test cases are:
  - a book with losses, which leave as their own flow;
  - a single holding;
  - an empty watchlist;
  - a thesis found directly (never watched);
  - all-open outcomes.
- **Verify:** `npx vitest run sankey`.
- **Files:** `packages/core/src/dashboard/sankey.ts`, tests.
- **Depends on:** T7 (for `pnlSankey`'s per-range input) · **Scope:** M

### T9: Today's moves and what changed today
- [x] **What:** `today.ts` computes:
  - each position's move today in dollars and percent: from the previous official close, or from the fill price for shares bought today, with shares sold today counted to their sale;
  - the portfolio's move today;
  - today's events from the audit log (trades with their thesis headline, strategy changes, event runs, stops, guardrail trips).
  
  On a closed day it uses the last session, dated.
- **Acceptance:** the positions' moves sum to the portfolio's (cash unchanged). A buy today, a sale today and a weekend are each tested.
- **Verify:** `npx vitest run today`.
- **Files:** `packages/core/src/dashboard/today.ts`, tests.
- **Depends on:** T1 · **Scope:** M

### Checkpoint B (after PR 2)
- [x] The gate passes, and the paper sync works.
- [x] The backfill ran as the job's first production run (2026-11-26), with nothing waiting and no gaps.
- [x] Every stored day reconciles (`positions:history -- --env production`).
- [x] `performanceView("all")` matches `capitalSummary` (tested), the same figures `get_overview` reports.

## PR 3: Today and Performance

### T10: The `extended-prices` job
- [x] **What:** the broker port and Alpaca adapter gain `getLatestMinuteBars(symbols)` (SIP, 16 minutes delayed, like the daily bars), and the calendar's extended session times (`session_open`, `session_close`). A new additive table, `extended_prices (trading_date, symbol, session, price, bar_at, recorded_at)`. A new tick job, `extended-prices`, runs only in the pre-market (from session open to the open) and after hours (from the close to session close), and upserts each held symbol's latest bar. It's market data only.
- **Acceptance:**
  - It skips outside those windows, including on a half day.
  - It writes no orders and no audit events.
  - Risk's, rebalance's and the index's inputs are unchanged (a test reads them before and after).
  - A symbol with no extended bar gets no row.
- **Verify:**
  - `npx vitest run extended jobs alpaca`;
  - a live check with the paper key: one pre-market and one after-hours call return bars;
  - `broker:smoke --env paper` (Risk 4);
  - the infra test pins the new job in `TICK_JOBS`.
- **Files:** `packages/core/src/broker/port.ts`, `packages/core/src/broker/alpaca.ts`, `packages/core/test/broker/fake-broker.ts`, `packages/core/src/agent/extended-prices.ts`, `packages/core/src/jobs.ts`, plus the schema and a migration.
- **Depends on:** none · **Scope:** L, so it's split as T10a (the port, the adapter and the fake) and T10b (the table and the job)

### T11: The Today page
- [x] **What:** `todayView` (T9 plus T10's extended line and `moneySankey`) is rendered at `/`:
  - today's P&L in dollars and percent;
  - VTI's move today;
  - the since-start line;
  - each position's move, biggest first;
  - the "After hours" or "Pre-market" line, marked indicative, with its time, or stale;
  - what changed today;
  - the guardrails as one status line that expands;
  - the money Sankey.

  The new components are `headline.tsx`, `sankey.tsx` and `extended-line.tsx`. The menu becomes Today · Performance · Positions · Ideas · History · Money, with the old pages kept until PR 6.
- **Acceptance:** spec success criterion 1, and the data's age shown.
- **Verify:** `npm test -w trader-dashboard`; `npm run mobile:check -w trader-dashboard`; a local `next dev` against production's read-only data.
- **Files:** `packages/core/src/dashboard/views.ts`, `apps/dashboard/src/app/(signed-in)/page.tsx`, `apps/dashboard/src/components/{headline,sankey,extended-line,nav}.tsx`.
- **Depends on:** T8, T9, T10 · **Scope:** M

### T12: The Performance page
- [x] **What:** `/performance` shows the range picker and the range's P&L, return, VTI and gap. It has the index chart (the existing `performance-chart.tsx`), the table of every range, the P&L by position for the range (T7), and `pnlSankey`.
- **Acceptance:** spec success criterion 2, and the range table agrees with the header and the summed positions.
- **Verify:** `mobile:check`; the figures against `get_overview`.
- **Files:** `apps/dashboard/src/app/(signed-in)/performance/page.tsx`, `apps/dashboard/src/components/range-table.tsx`, `views.ts`.
- **Depends on:** T6, T7, T8, T11 · **Scope:** M

### Checkpoint C (after PR 3)
- [ ] `mobile:check` passes at 393 and 1280 px.
- [ ] Scott checks Today and Performance on his phone, including an after-hours line in the evening.

## PR 4: Positions and exits

### T13: The exits model
- [x] *(The flags come from agent/held.ts's pure check, fed stored closes, filings, estimates and the calendar. The earnings-day crash flag needs SEC's releases at read time, so only the routine's get_holdings has it.)* **What:** `exitsFor(thesis, holding, flags, now)` returns:
  - the automatic exits as figures: the stop price, its distance, and the sentence "sells if it closes below $X, Y% below today"; the review date with days left; the stale date;
  - the `exitIf` list;
  - the live sell-signal flags in plain words, reusing `heldTheses`' flags.
  
  `positionsView` combines the holdings, the headline or its fallback, P&L since bought, vs VTI, and the exits.
- **Acceptance:** each automatic exit is tested at its boundary (at the stop, due today, stale tomorrow), and the fallback headline is marked.
- **Verify:** `npx vitest run exits views`.
- **Files:** `packages/core/src/dashboard/exits.ts`, `views.ts`, tests.
- **Depends on:** T1, T7 · **Scope:** M

### T14: The Positions page and the thesis page's layers
- [x] **What:** `/positions` shows one card per holding (theses first, then VTI) with the headline, figures and exits, linking to the thesis page. The thesis page gains the headline, the plain summary and the exits above its chart.
- **Acceptance:** spec success criteria 3 and 4 for held positions.
- **Verify:** `mobile:check` (on the new route and every thesis range).
- **Files:** `apps/dashboard/src/app/(signed-in)/positions/page.tsx`, `apps/dashboard/src/app/(signed-in)/theses/[id]/page.tsx`, `apps/dashboard/src/components/exits.tsx`.
- **Depends on:** T13 · **Scope:** M

## PR 5: Ideas

### T15: The Ideas page and the idea funnel
- [ ] **What:** `ideasView` lists the open watchlist, soonest revisit first: the headline (or its fallback), the trigger, the revisit date, the forecast, and a count of new filings with a tap to see them. It adds `ideaFunnelSankey` over the whole history of watchlist notes and theses. The page is `/ideas`.
- **Acceptance:** spec success criterion 5, and the funnel's counts match the notes and the scorecard.
- **Verify:** `npx vitest run views sankey`; `mobile:check`.
- **Files:** `views.ts`, `apps/dashboard/src/app/(signed-in)/ideas/page.tsx`.
- **Depends on:** T1, T8 · **Scope:** M

## PR 6: History and redirects

### T16: The History page and signal to outcome
- [ ] **What:** `historyView` is every thesis ever held, newest first: headline, how it ended, P&L, vs VTI, days held. It adds the totals by lead signal and `signalSankey`, with links to All trades, Strategy versions and Forecasts. The activity and strategy pages move to `/history/activity` and `/history/strategy` (the version pages to `/history/strategy/[version]`), and the forecasts section to `/history/forecasts`.
- **Acceptance:** everything the old Track record, Activity and Strategy pages showed is reachable from History.
- **Verify:** `mobile:check` on every History route.
- **Files:** `views.ts`, `apps/dashboard/src/app/(signed-in)/history/**`.
- **Depends on:** T8 · **Scope:** M

### T17: The redirects and the final menu
- [ ] **What:** `next.config.ts` gets permanent redirects: `/holdings` → `/positions`, `/track-record` → `/history`, `/activity` → `/history/activity`, `/strategy` and `/strategy/:v` → `/history/strategy/…`, each keeping the query string. The old page files are removed.
- **Acceptance:** every old URL lands on its new page with a 308, and `?range=` survives.
- **Verify:** `npm test -w trader-dashboard` (the redirect table); `mobile:check` visits every old URL.
- **Files:** `apps/dashboard/next.config.ts`, the old page files, `apps/dashboard/scripts/mobile-check.mjs`.
- **Depends on:** T14, T16 · **Scope:** S

## PR 7: What each figure means

### T18: The glossary, the ⓘ explanations and `/help`
- [ ] **What:** `glossary.ts` holds the plain definition of every term: flow-adjusted, vs VTI, P&L, drawdown, stop, review date, stale, lead signal, forecast, indicative, extended hours and the rest. An `info.tsx` ⓘ opens on a tap, and every figure on every page gets one. `/help` lists them all, and each page's foot links to it.
- **Acceptance:**
  - A test fails if any ⓘ names a term missing from the glossary.
  - The toggles are 44 px tap targets.
  - Spec success criterion 7 is met.
- **Verify:** `npm test -w trader-dashboard`; `mobile:check`.
- **Files:** `apps/dashboard/src/lib/glossary.ts`, `apps/dashboard/src/components/info.tsx`, `apps/dashboard/src/app/(signed-in)/help/page.tsx`, and the pages' labels.
- **Depends on:** T11, T12, T14, T15, T16 · **Scope:** M

### T19: Close-out
- [ ] **What:** the remaining close-out items:
  - the spec's Amendment 3 status becomes Built, with what was verified;
  - SPEC-dashboard's page table is updated;
  - `docs/SETUP.md` gets the backfill and the job;
  - this plan moves to `tasks/done/`.
- **Acceptance:** Checkpoint D.
- **Verify:** Scott's phone check.
- **Files:** `SPEC-dashboard.md`, `docs/SETUP.md`, `tasks/`.
- **Depends on:** T18 · **Scope:** S

### Checkpoint D (complete)
- [ ] Scott answers each of his eight questions from the phone without help.
- [ ] Every Amendment 3 success criterion is met.
