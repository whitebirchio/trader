# Implementation Plan: the dashboard's information architecture (SPEC-dashboard Amendment 3)

> **Status: Done** (2026-11-27). Approved by Scott on 2026-11-26, as was the spec. Tasks are in [dashboard-ia-todo.md](dashboard-ia-todo.md).

## Overview

The dashboard is regrouped around the owner's eight questions:
- **Pages:** Today · Performance · Positions · Ideas · History · Money.
- **New data from the routine:** a one-line `headline` on every thesis and watchlist name, and an `exitIf` list on every thesis.
- **Four Sankey diagrams.**
- **Pre-market and after-hours prices,** from a new market-data job.
- **A daily position snapshot,** for profit and loss by position over any range.

It ships in the seven PRs the spec agreed. Each one leaves production working, and the old URLs keep working until PR 6 redirects them.

## Architecture decisions

- **Logic in core, drawing in the app.** Every figure, range and Sankey is built in `packages/core/src/dashboard/` and tested on PGlite. The pages are server components that render it, as today. The Sankey component is the one client component added.
- **New thesis fields are checked like `bearCase`.** `headline` and `exitIf` are optional in the schema, so stored versions stay valid. A new `presentationErrors` requires them on a new thesis or a raised weight, only on Claude's submissions (`requireBearCase`'s switch). The prompt has the next run add them to everything held.
  - If two runs pass without the backfill, the fallback is to require them on every thesis, as `ledgerErrors` does for the lead signal (Risk 3).
- **Positions are valued at the official close.** `position_snapshots` stores qty × the session's official close (`thesis_closes`, `benchmark_closes`), not Alpaca's live `current_price`. After 4:00 PM that price can include after-hours trades. The backfill uses the same rule, so stored and rebuilt rows agree.
- **Per-range money figures come from one window function.** `capitalSummary` (since start) becomes a special case of `capitalSummaryOver(db, from, through)`, which reuses `sameMoneyInBenchmark`. The range table, the Performance header and the per-position figures all read it, so they can't disagree.
- **Extended-hours prices are kept apart from everything that trades.**
  - They live in their own table, read only by the dashboard's views.
  - Risk, the index, rebalance, the scorecard and the capital summary never import it. A test asserts their inputs are unchanged.
  - The broker port gains one market-data method (`getLatestMinuteBars`, SIP, delayed like the daily bars) and the calendar's extended session times.
- **Sankeys use Recharts' `Sankey`,** fed `SankeyData` from core. Nodes are capped at 8 a side below 640 px, and the smallest are grouped as "Other" in core, so the reconciliation test covers the grouping too.
- **Redirects are permanent (308), in `next.config.ts`,** so home-screen bookmarks follow them.

## Dependency graph

```
PR1  thesis/watchlist fields ──► routine backfills headlines (runs on its own)
        │
PR2  tables + read models ─────────────────────────────┐
     T3 spike (backfill reconciles?) ─► T4 snapshot ─► T5 backfill
     T6 ranges + capitalSummaryOver ─► T7 P&L by position
     T8 Sankey builders   T9 today's moves + changes
        │                                              │
PR3  T10 extended-prices job ─► T11 Today ─► T12 Performance
PR4  T13 exits model ─► T14 Positions + thesis page layers
PR5  T15 Ideas (+ funnel)
PR6  T16 History (+ signal Sankey) ─► T17 redirects + final menu
PR7  T18 glossary, ⓘ, /help ─► T19 close-out
```

PRs 4 and 5 depend only on PR 2 (and PR 1's fields), so they can go in either order. Everything else is sequential.

## Phases

1. **PR 1, fields first (T1–T2):** the routine starts writing headlines and exit lists while the pages are built.
2. **PR 2, data (T3–T9):** two additive tables, the backfill, and every read model. No pages change yet.
3. **PR 3, Today and Performance (T10–T12).**
4. **PR 4, Positions and exits (T13–T14).**
5. **PR 5, Ideas (T15).**
6. **PR 6, History and redirects (T16–T17).**
7. **PR 7, explanations (T18–T19).**

## Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **The backfill can't reproduce `equity_snapshots` to the cent.** Those snapshots record Alpaca's equity in the after-close window, which can include after-hours moves and accrued interest. | High: it blocks per-range P&L by position | **T3 is a read-only spike, run first** against production through `trader_readonly`. It measures how many days reconcile and why the rest don't. If they're off by after-hours drift, compare each day's cash plus positions at the official close, and record the drift. Ask Scott before loosening "to the cent". |
| 2 | **The free feed's extended-hours coverage.** SIP minute bars, 16 minutes delayed, may be thin or missing for some symbols early in the pre-market. | Medium: blank lines | T10 checks a live call with the paper key first. "Where available" is in the spec: no row, not zero. |
| 3 | **The routine doesn't backfill headlines and exit lists.** | Medium: the fallback shows instead | Check after the first two runs following PR 1. If they're missing, require them on every thesis (a one-line switch in `presentationErrors`). |
| 4 | **`src/broker/` changes** (the snapshot write, the minute-bars method, the calendar times) | High if wrong: the sync path | CLAUDE.md's rule: `broker:sync --env paper --force` and `broker:smoke` on paper before merging PRs 2 and 3. The new method is read-only market data. |
| 5 | **The backfill writes production rows from the laptop.** | Medium | Scott runs it (owner role), with `--dry-run` first. It's idempotent per date and refuses days that don't reconcile. |
| 6 | **Sankeys at 393 px** | Low | Node cap and grouping in core; `mobile:check` screenshots; Scott's phone check at Checkpoint C. |
| 7 | **Range figures disagree between pages** | Medium: trust | One window function (decision 4) and a test that the range table, the header and the summed positions agree. |

## Verification checkpoints

- **A (after PR 1):** the next two routine runs write `headline` and `exitIf` on every held thesis and a headline on every open watchlist name (`get_strategy`, `get_watchlist`).
- **B (after PR 2):**
  - the backfill has run;
  - `position_snapshots` reconciles every day it holds;
  - the after-close write works on paper;
  - the read models match `get_overview` and `get_track_record`.
- **C (after PR 3):** `mobile:check` passes, and Scott checks Today and Performance on his phone, including an after-hours line.
- **D (after PR 7):** Scott answers his eight questions from the phone without help (spec success criterion 9).

## Open questions

None blocking. The spec settled the ranges, closed days, slicing and position history. T3's result may raise one: how close a backfilled day must be (Risk 1).
