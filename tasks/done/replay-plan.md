# Plan: historical replay (#57)

> **Status: Built** (2026-11-10, #90; approved by Scott 2026-11-08 with the decisions below). Write-up: [docs/research/insider-replay-2026-11.md](../../docs/research/insider-replay-2026-11.md). Tasks: `tasks/done/replay-todo.md`.

## Overview
A local research tool that runs Trader's **real** decision code, day by day, over past market data: `syncBroker` → `runRebalance` → `riskGate` → `submitOrder`, with a simulated broker and clock in place of Alpaca and the wall clock. Given a timeline of strategy documents, it reports what Trader would have done and how it would have performed against VTI, with every guardrail applied. It answers the question the research backtests can't: **does an idea survive Trader's actual rules** (caps, stops, staleness, review dates, no day trades, sells first, drift bands, the drawdown halt), and how does a rule change compare with today's rules on the same history.

It changes no production behaviour. It runs on a laptop against a throwaway PGlite database, never Neon, and it has no path to a real order.

## What the code tells us (read 2026-11-08)
- **Everything external goes through `BrokerAdapter`** (`src/broker/port.ts`). The decision path uses `getAccount`, `getAccountConfig`, `getClock`, `getCalendar`, `getPositions`, `getOrders`, `getOrderByClientId`, `submitOrder`, `getActivities`, `getAsset` and `getDailyBars`. A `SimBroker` implementing the port can drive the real code unchanged. `test/broker/fake-broker.ts` is the starting point.
- **Time is an argument:** `runRebalance(db, broker, env, now)` and `syncBroker(db, broker, env, now, opts)` take `now`, and `submitOrder` writes `createdAt: now`.
- **The active strategy is the highest version number** (`activeStrategy`), not the one in force at `now`. The driver therefore inserts each version when the simulated clock reaches its `created_at`, exactly as the routine did live.
- **Wall-clock seams exist.** `audit_events.at` and about 20 columns default to `now()`. Most are bookkeeping, but any read of them on the decision path would leak real time into a simulation. Task 2 audits them, with a test that fails if a replayed decision depends on wall-clock time.
- **Research data is cached** (`scripts/research-common.ts`, `.cache/`), but only as closes and volumes (`DailyBar`). The replay needs full bars (open, high, low, close, volume) as decimal strings, plus the calendar and asset facts, so it gets its own cache beside the research one.

## Architecture decisions
- **High fidelity: run the real jobs end to end.** Call `syncBroker` and `runRebalance` against PGlite with the real migrations, not a re-implementation of the pipeline. Slower, but it can't drift from what production does, and every future rule is replayable for free. *(Open question 2.)*
- **A variant is a transform, not a code hook.** A variant is `(strategy document) → document` plus optional `limits` overrides: "every stop at 20%", "cap theses at 10%", later "add `trailingStopPct: 15`" once #35 adds the field. Baseline and variant run on identical inputs, and the report diffs them.
- **Simulated session:**
  - 09:45 ET: sync, then a rebalance step (sells).
  - 10:00 ET: sync, then a rebalance step (buys).
  - 12:30 and 12:45 ET: the same pair again, for the routine's midday version (added in T5).
  - 16:15 ET: after-close sync (snapshot, VTI and thesis closes, drawdown check).
  
  During the session, `getDailyBars` serves today's bar as a partial bar: open = close = today's open. That avoids lookahead: decisions and stops see yesterday's close and today's open. Fills are at today's open ± a slippage assumption, and the full bar appears only after the close. *(Open question 1.)*
- **Versions authored after 12:45 ET** take effect the next session. T5 added the midday steps once T4 showed that a midday version otherwise trades a day late. A midday order fills at the open, the only intraday price daily bars hold; Task 6 measures what that costs.
- **Deposits and withdrawals in the history are replayed as transfers** at their dates, so the flow-adjusted index compares like for like.
- **Halts depend on the mode.** A drawdown halt or kill switch **freezes** a replay of Trader's own history, as it would live. A multi-year rule-based replay **resumes automatically** the next session, because a concentrated book would likely halt in March 2020 and freeze every variant identically from then on. Every report lists every halt date either way, and either default can be overridden.
- **Reports reuse the dashboard's readers on the replay database** (`performanceSeries`, `loadScorecard`, `rebalance_plans`, `risk_decisions`, lots), plus turnover, realized short-term gains and wash-sale hits.
- **Privacy:** replays of production history (mode 1) read production's strategy versions and transfers read-only, through the ops helper. Their reports stay in git-ignored `.cache/replay/`, since they contain live figures. Only rule-based replays (mode 2) are written up in `docs/research/`.
- **Code lives in core:** `packages/core/src/replay/` (`sim-broker.ts`, `driver.ts`, `variants.ts`, `report.ts`), with tests in `test/replay/` and the CLI in `scripts/replay.ts` (`npm run replay -w @trader/core`). No new dependencies.

## Dependency graph
```
SimBroker + sim clock (T1)
  └── driver: PGlite + versions on a timeline + session steps (T2)   ← risk: real code under a sim clock
        ├── market-data cache: full bars, calendar, assets (T3)
        │     └── mode 1: production timeline + transfers (T4)
        │           ├── report (T5)
        │           │     └── fidelity check vs actual production (T6)
        │           └── variants + baseline/variant diff (T7)
        └── mode 2: rule-based timelines from research signals (T8)  ← after review
```

## Task list
See `tasks/done/replay-todo.md` for acceptance criteria and verification.

### Phase 1: the real code runs under a simulated clock
- [ ] T1: `SimBroker` and sim clock
- [ ] T2: Driver on synthetic data, end to end (plus the wall-clock audit)

### Checkpoint A
Gate green; a synthetic replay buys a thesis, stops out on a drop the next session, never trades same-day, and reports equity vs VTI.

### Phase 2: replay Trader's own history (mode 1)
- [ ] T3: Market-data cache (full bars, calendar, assets)
- [ ] T4: Production timeline: strategy versions and transfers
- [ ] T5: Report and `npm run replay`
- [ ] T6: Fidelity check: the baseline replay vs what production actually did

### Checkpoint B (Scott reviews)
The fidelity write-up. Is the replay close enough to reality to trust its comparisons?

### Phase 3: rule variants
- [ ] T7: Variants and the baseline-vs-variant report

### Checkpoint C
A variant that exists today (for example, stops at 20% vs as written) runs over Trader's history with a readable diff. That proves the machinery; Trader's own history is too short to judge rules on.

### Phase 4: rule-based strategies (mode 2)
- [ ] T8: A rule-based timeline from the insider data, replayed 2019–2026, written up in `docs/research/`

### Checkpoint D
Today's-rule variants (stop width, caps, review horizon) compared over 2019–2026. Next: build #35's trailing stop and profit target in production code (off by default), each with a replay variant, and judge them on the multi-year replay before switching either on.

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Wall-clock time leaks into a decision (a `now()` column read on the decision path) | High: silently wrong replays | T2 audits every `defaultNow()` column and the reads of each; a test runs a replay "in 2024" and asserts every order, fill and snapshot carries simulated time; where a seam is needed, pass `now` through (small, tested, production-neutral) |
| PGlite is too slow for multi-year replays (about 3 steps × 250 sessions a year, each running sync and rebalance) | Medium | Measure in T2. Mode 1 is a few weeks of history today; for mode 2, cut steps to one a day when no strategy changed, or snapshot the database between runs |
| Daily bars hide intraday moves: a stop breached intraday and recovered never fires, and fills at the open aren't Trader's real fills | Medium | Say so in every report; T6 measures the gap against production's actual fills |
| Asset facts are today's, not historical (fractionable, delisted), so delisted names look ineligible | Medium for mode 2 | Report symbols with no asset or bars; mode 2 takes candidates from the filings as they were |
| Production's history is short (about two weeks by the time this is built) | Low | Mode 1 grows in value with time; mode 2 covers years |
| Replay results get read as proof of an edge | Medium | Every report says what it is: evidence for comparing rules, not a promise; small samples are flagged |

## Decisions (Scott, 2026-11-08)
1. **Fill model:** the session's **open plus 0.10% slippage** each way. Decisions see yesterday's close and today's open, never a later price. Slippage is a flag: rerun at 0% and 0.25% whenever a conclusion looks sensitive to it.
2. **Fidelity:** the **real jobs end to end on PGlite** (`syncBroker`, `runRebalance`), not a re-implementation.
3. **Variants:** rules that exist today first (stop width, weight caps, review-date horizon). Then #35's trailing stop and profit target, built in production code switched off and **judged on the multi-year replay**: Trader's own history is too short to judge a rule.
4. **Mode 2 is planned, not optional:** **2019–2026** from the research caches, insider clusters first.
5. **Halts:** freeze on Trader's own history; auto-resume on multi-year replays; every halt reported either way.
