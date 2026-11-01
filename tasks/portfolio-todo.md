# Tasks: `portfolio`

> Plan: [portfolio-plan.md](portfolio-plan.md) · Spec: [SPEC-portfolio.md](../SPEC-portfolio.md)
> **gate** = `npm run typecheck && npm test`. Branches `portfolio/*` deploy staging only.

## Phase 1: Pure core

### P1: Strategy schema + validation
- [x] Zod schema with every bound in the spec (universe 1–100, windows, topN 1–20, weights 0 < w ≤ 20, Σ conviction ≤ 100, stop 5–50 required, ≥ 1 evidence item, no duplicate symbols or ids, `defensive` not in the universe)
- [x] `VERSION_0` constant (VTI, topN 1, no filter)
- [x] Table tests for every bound; readable error messages (they become `strategy.rejected` email text)
- **Files:** `src/portfolio/strategy.ts`, test · **Scope:** S

### P2: Systematic ranking + weighting
- [x] `rankUniverse(bars, params)`: momentum over the lookback with skip-recent, trend filter, topN, equal / inverse-vol weights summing to 1, failed slots → `defensive` or cash
- [x] Missing or short history → excluded (not ranked on partial data)
- [x] Tests: hand-computed returns, the 12-1 skip, the filter, weights, `defensive`, ties broken by symbol
- **Files:** `src/portfolio/systematic.ts`, test · **Scope:** S

### P3: Targets
- [x] **Revised at Checkpoint A (2026-11-01):** `buildTargets({states, ranking, params, skip, equity, limits})` applies risk's per-name cap, sends the overflow down the ranking and then to VTI (option 1b), with no cash anywhere (buffer $0; trend-filtered and no-rank slots → VTI). Originally `buildTargets(strategy, thesisStates, ranking, equity, cashBuffer)` → `{symbol, sleeve, weight, dollars}[]`: conviction first (active theses only), the remainder to systematic; `toDollarTargets` in `Big`, cents, sums ≤ investable
- [x] Tests: empty conviction → all systematic; 100% conviction → no systematic; stopped/stale theses excluded; exact dollar sums
- **Files:** `src/portfolio/targets.ts`, test · **Depends on:** P1, P2 · **Scope:** S

### P4: Thesis lifecycle
- [x] `thesisStates(history, lots, lastCloses, now)` → active / stopped / stale / closed, with the reason
- [x] Tests: stop hit at exactly the threshold; stale at day 30, not 29; reaffirmed resets the clock; stopped stays stopped across versions; removed → closed
- **Files:** `src/portfolio/theses.ts`, test · **Depends on:** P1 · **Scope:** S

### P5: Planner
- [x] `planTrades({targets, holdings, drift, exitReasons, sleeveOf})`: exits; drift beyond max(rel × target, min$); **sells-only if any sells are due**; buys conviction first, then largest. **Design note:** wash-sale skip+substitute happens at *selection* (`selectSystematic(ranking, params, washSaleWindow(closed, now))`), because only the ranking knows the next rank; conviction buys are never skipped
- [x] Tests for each rule, plus "already on target → no proposals"
- **Files:** `src/portfolio/planner.ts`, test · **Depends on:** P3, P4 · **Scope:** M

### Checkpoint A
- [x] Gate green · Scott reviewed a rendered sample plan → decisions: option 1b for over-cap targets; no cash buffer (idle money sits in VTI)

## Phase 2: Wiring

### P6: Risk changes
- [x] (done early, during P3) Rename sleeves to `systematic` / `conviction` (types, rules, reason text, tests, docs); `convictionCapPct: "100"` in `limits.ts`
- [x] ADR-013 "Conviction-first portfolio; idle money sits in VTI" (supersedes ADR-003's 70/30 default only); capability map objective line; CLAUDE.md wording
- **Files:** `src/risk/*`, tests, `docs/decisions/013-*.md`, README index, `CAPABILITY-MAP.md`, `CLAUDE.md` · **Scope:** M (wide but mechanical)

### P7: Migration + store
- [x] Tables `strategies`, `thesis_events`, `rebalance_plans` (all three append-only; migrations 0008–0009)
- [x] `submitStrategy(db, doc, actor)` → validate → insert the next version, or reject and audit `strategy.rejected`; `activeStrategy(db)` (falls back to `VERSION_0`)
- [x] New audit kinds routed: `strategy.activated`, `strategy.rejected`, `thesis.stopped_out`, `thesis.stale` (urgent), `rebalance.planned` (digest)
- **Files:** `src/db/schema.ts`, `drizzle/*`, `src/portfolio/store.ts`, `src/audit.ts`, `src/notifications/routing.ts`, tests · **Scope:** M

### P8: `rebalance` job
- [x] Window gate (trading day, 10:30–15:30 ET); load the active strategy, bars, positions, lots and closures; thesis states (+ events); targets; plan; `riskGate` (sleeve attribution from the plan); `submitOrder` per approved/clipped; record the plan + audit
- [x] Register `rebalance` in `JOBS` (not in `TICK_JOBS`); `EngineStack` adds the `trader-rebalance-<env>` schedule `cron(5/15 14-20 ? * MON-FRI *)` UTC with `{"jobs":["rebalance"]}`, plus an infra assertion test
- [x] Plus (decided while building): a step **skips while any of today's orders are still open**, so a step that runs before the previous fills land can't re-buy. Tests (PGlite + fake broker): version 0 from cash in 2 steps then a no-op; a strategy change sells first, then buys; a re-run places nothing; a stop-loss sells + audits; outside the window → skipped
- **Files:** `src/portfolio/rebalance.ts`, `src/jobs.ts`, `infra/lib/engine-stack.ts`, tests · **Depends on:** P5–P7 · **Scope:** M

### Checkpoint B
- [ ] Gate green · `db:generate` clean · staging deploy

## Phase 3: Operate and ship

### P9: Scripts + digest
- [x] `strategy:submit --file`, `strategy:show [--version]`, `rebalance:plan` (dry run), `rebalance:run` (one paper step now, staging only), both with `--sync`
- [x] `benchmark.ts`: index vs VTI total return since the first snapshot; the digest gains "vs VTI"; email text for the new kinds
- [x] docs: SETUP "Strategy & rebalancing" section, CLAUDE.md line
- **Depends on:** P8 · **Scope:** M

### P10: Verify and ship
- [ ] SC-2: version 0 on paper → ≈100% VTI in two `rebalance:run` steps, then a no-op
- [ ] SC-3: sample conviction strategy on paper → plan → run → fills → `strategy:show` matches
- [ ] SC-4/5: tests (stop-loss, staleness), plus a suppressed staging email
- [ ] SC-6: PR → **your explicit go-ahead** → production: version 0 converges the live $1k to ≈VTI on the first trading day
- **Depends on:** P9 · **Scope:** S

### Checkpoint C
- [ ] All 6 success criteria · Scott reviews · next: `SPEC-agent.md`
