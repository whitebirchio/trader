# Tasks: `portfolio`

> Plan: [portfolio-plan.md](portfolio-plan.md) · Spec: [SPEC-portfolio.md](../SPEC-portfolio.md)
> **gate** = `npm run typecheck && npm test`. Branches `portfolio/*` deploy staging only.

## Phase 1: Pure core

### P1: Strategy schema + validation
- [ ] Zod schema with every bound in the spec (universe 1–100, windows, topN 1–20, weights 0 < w ≤ 20, Σ conviction ≤ 100, stop 5–50 required, ≥ 1 evidence item, no duplicate symbols or ids, `defensive` not in the universe)
- [ ] `VERSION_0` constant (VTI, topN 1, no filter)
- [ ] Table tests for every bound; readable error messages (they become `strategy.rejected` email text)
- **Files:** `src/portfolio/strategy.ts`, test · **Scope:** S

### P2: Systematic ranking + weighting
- [ ] `rankUniverse(bars, params)`: momentum over the lookback with skip-recent, trend filter, topN, equal / inverse-vol weights summing to 1, failed slots → `defensive` or cash
- [ ] Missing or short history → excluded (not ranked on partial data)
- [ ] Tests: hand-computed returns, the 12-1 skip, the filter, weights, `defensive`, ties broken by symbol
- **Files:** `src/portfolio/systematic.ts`, test · **Scope:** S

### P3: Targets
- [ ] `buildTargets(strategy, thesisStates, ranking, equity, cashBuffer)` → `{symbol, sleeve, weight, dollars}[]`: conviction first (active theses only), the remainder to systematic; `toDollarTargets` in `Big`, cents, sums ≤ investable
- [ ] Tests: empty conviction → all systematic; 100% conviction → no systematic; stopped/stale theses excluded; exact dollar sums
- **Files:** `src/portfolio/targets.ts`, test · **Depends on:** P1, P2 · **Scope:** S

### P4: Thesis lifecycle
- [ ] `thesisStates(history, lots, lastCloses, now)` → active / stopped / stale / closed, with the reason
- [ ] Tests: stop hit at exactly the threshold; stale at day 30, not 29; reaffirmed resets the clock; stopped stays stopped across versions; removed → closed
- **Files:** `src/portfolio/theses.ts`, test · **Depends on:** P1 · **Scope:** S

### P5: Planner
- [ ] `planTrades(targets, holdings, lots, closedLots, now, drift)` → proposals with reasons: exits; drift beyond max(rel × target, min$); **sells-only if any sells are due**; systematic buys of a symbol with a loss sale in the last 30 days skipped and substituted from the ranking; conviction buys never skipped
- [ ] Tests for each rule, plus "already on target → no proposals"
- **Files:** `src/portfolio/planner.ts`, test · **Depends on:** P3, P4 · **Scope:** M

### Checkpoint A
- [ ] Gate green · Scott skims a rendered sample plan

## Phase 2: Wiring

### P6: Risk changes
- [ ] Rename sleeves to `systematic` / `conviction` (types, rules, reason text, tests, docs); `convictionCapPct: "100"` in `limits.ts`
- [ ] ADR-013 "Conviction-first portfolio" (supersedes ADR-003's 70/30 default only); capability map objective line; CLAUDE.md wording
- **Files:** `src/risk/*`, tests, `docs/decisions/013-*.md`, README index, `CAPABILITY-MAP.md`, `CLAUDE.md` · **Scope:** M (wide but mechanical)

### P7: Migration + store
- [ ] Tables `strategies`, `thesis_events` (both append-only), `rebalance_plans`
- [ ] `submitStrategy(db, doc, actor)` → validate → insert the next version, or reject and audit `strategy.rejected`; `activeStrategy(db)` (falls back to `VERSION_0`)
- [ ] New audit kinds routed: `strategy.activated`, `strategy.rejected`, `thesis.stopped_out`, `thesis.stale` (urgent), `rebalance.planned` (digest)
- **Files:** `src/db/schema.ts`, `drizzle/*`, `src/portfolio/store.ts`, `src/audit.ts`, `src/notifications/routing.ts`, tests · **Scope:** M

### P8: `rebalance` job
- [ ] Window gate (trading day, 10:30–15:30 ET); load the active strategy, bars, positions, lots and closures; thesis states (+ events); targets; plan; `riskGate` (sleeve attribution from the plan); `submitOrder` per approved/clipped; record the plan + audit
- [ ] Register `rebalance` in `JOBS` (not in `TICK_JOBS`); `EngineStack` adds the `trader-rebalance-<env>` schedule `cron(5/15 14-20 ? * MON-FRI *)` UTC with `{"jobs":["rebalance"]}`, plus an infra assertion test
- [ ] Tests (PGlite + fake broker): version 0 from cash in 2 steps then a no-op; a strategy change sells first, then buys; a re-run places nothing; a stop-loss sells + audits; outside the window → skipped
- **Files:** `src/portfolio/rebalance.ts`, `src/jobs.ts`, `infra/lib/engine-stack.ts`, tests · **Depends on:** P5–P7 · **Scope:** M

### Checkpoint B
- [ ] Gate green · `db:generate` clean · staging deploy

## Phase 3: Operate and ship

### P9: Scripts + digest
- [ ] `strategy:submit --file`, `strategy:show [--version]`, `rebalance:plan` (dry run), `rebalance:run` (one paper step now)
- [ ] `benchmark.ts`: index vs VTI total return since the first snapshot; the digest gains "vs VTI"; email text for the new kinds
- [ ] docs: SETUP "Strategy & rebalancing" section, CLAUDE.md line
- **Depends on:** P8 · **Scope:** M

### P10: Verify and ship
- [ ] SC-2: version 0 on paper → ≈100% VTI in two `rebalance:run` steps, then a no-op
- [ ] SC-3: sample conviction strategy on paper → plan → run → fills → `strategy:show` matches
- [ ] SC-4/5: tests (stop-loss, staleness), plus a suppressed staging email
- [ ] SC-6: PR → **your explicit go-ahead** → production: version 0 converges the live $1k to ≈VTI on the first trading day
- **Depends on:** P9 · **Scope:** S

### Checkpoint C
- [ ] All 6 success criteria · Scott reviews · next: `SPEC-agent.md`
