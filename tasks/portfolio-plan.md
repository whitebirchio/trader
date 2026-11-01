# Implementation Plan: `portfolio`

> Implements [SPEC-portfolio.md](../SPEC-portfolio.md) (approved 2026-10-31). Tasks are in [portfolio-todo.md](portfolio-todo.md).
> **Status: DRAFT — awaiting approval.**

## Overview

Build the pure core first: the strategy schema, the thesis lifecycle, systematic ranking, targets and the planner. Each is table-tested without I/O. Then the persistence and the `rebalance` job with its operator scripts, then the changes to `risk` and `notifications`, then paper verification. Production comes last and is the **first module that places live orders**, so its merge is a deliberate step with you.

## Dependency graph

```
P1 strategy schema + validation ──┬── P3 targets (conviction-first, systematic remainder)
P2 systematic ranking + weights ──┘            │
P4 thesis lifecycle (stop / stale / closed) ───┤
                                               ▼
                                   P5 planner (drift, sells-first, wash-sale skip)
                                               │
P6 risk sleeve rename + conviction cap 100 ────┤        (independent; can go first)
                                               ▼
                         P7 migration + strategy store + submitStrategy + version 0
                                               │
                         P8 rebalance job (load → plan → riskGate → submitOrder → record)
                                               │
                         P9 scripts (strategy:submit/show, rebalance:plan/run) + notifications routing + digest vs VTI
                                               │
                         P10 paper verification → PR → production
```

## Architecture decisions (made during planning)

- **Analytics in float, money in `Big`.** `systematic.ts` ranks on `number` returns and volatilities. The moment a weight becomes dollars, it's a decimal string (ADR-009). The boundary is one function, `toDollarTargets`, and it's tested for exactness.
- **One market-data load per step.** A single `getDailyBars` call covers the universe, thesis symbols, VTI and `defensive`, over `max(lookback + skip, trendFilter, volatility) + 10` trading days, converted to calendar days with margin.
- **Thesis state is derived, plus an event log.** `theses.ts` computes each thesis's state from the strategy history, lots and prices. `thesis_events` records transitions (stopped, stale), so "stopped stays stopped" survives a restart and the emails have something to audit. Re-listing a stopped thesis id is a validation error ("use a new id").
- **Sells-first phasing comes from the planner, not from timing.** If any sells are due, the step's proposals are only sells. A later step, after `sync-broker` shows the fills, plans the buys. Each step creates its own plan row, and intent keys include the plan id, so nothing can double.
- **Sleeve attribution for `risk`** comes from the active plan: conviction symbols are `conviction`, the rest `systematic`. That replaces the "unattributed = satellite" default for symbols the strategy knows about.
- **`rebalance` has its own Scheduler schedule** (`trader-rebalance-<env>`, weekdays 14:00–21:00 UTC every 15 min, offset to :05/:20/:35/:50), so it runs 5 minutes after each shared tick's `sync-broker`. It plans on fresh data, and the next shared tick's `notify-urgent` emails its events. Being separate, a slow rebalance can't delay the shared tick.
- **Operator scripts follow the fast-verification rule:** `rebalance:plan` (dry run) and `rebalance:run` (one real paper step) call the same functions as the job, so checks never wait for the cron.

## Task list

### Phase 1: Pure core
- [ ] P1: Strategy schema + validation
- [ ] P2: Systematic ranking + weighting
- [ ] P3: Targets
- [ ] P4: Thesis lifecycle
- [ ] P5: Planner

### Checkpoint A
- [ ] Gate green · you skim a sample plan (rendered from a test fixture) for whether it trades the way you'd expect

### Phase 2: Wiring
- [ ] P6: Risk sleeve rename + conviction cap 100 + ADR-013
- [ ] P7: Migration + strategy store + version 0
- [ ] P8: `rebalance` job

### Checkpoint B
- [ ] Gate green · `db:generate` clean · staging deploy

### Phase 3: Operate and ship
- [ ] P9: Scripts + notification routing + digest "vs VTI"
- [ ] P10: Paper verification → PR → production

### Checkpoint C (complete)
- [ ] All 6 success criteria · you review · next: `SPEC-agent.md`

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| First live orders behave unexpectedly | High | Version 0 is only VTI. Every order passes `risk`. Paper runs the identical code first (SC-2, SC-3). The production merge waits for your explicit go-ahead. |
| Lambda duration/cost | Low | Minutes of headroom per run and ~$0 in the always-free tier (ADR-014). `job_runs` records durations. |
| Momentum on a tiny or illiquid universe gives noisy picks | Med | Validation bounds, and `risk` eligibility (price, volume, IPO) on every buy. The universe is Claude's job; v0 is just VTI. |
| A stop-loss gap-down sells well below the stop | Med | Accepted and documented (daily check). Resting stops would bypass `risk`. |
| Wash-sale skip substitutes into a worse pick | Low | Only systematic buys are skipped, the next rank substitutes, and every skip is logged in the plan so Claude can see the cost. |
| Sells-first leaves the account partly in cash for one tick | Low | Buys follow 15 minutes later in the same session. Accepted. |
| Strategy schema doesn't fit what `agent`/Claude needs | Med | `agent`'s spec can extend the schema in an additive version. Documents are versioned jsonb, validated at write. |

## Open questions

- None.
