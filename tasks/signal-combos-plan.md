# Implementation Plan: do signals that agree beat VTI? (#140)

> **Status: Approved** (Scott, 2026-11-28). Spec: [signal-combos-spec.md](signal-combos-spec.md) (approved 2026-11-28). Tasks: [signal-combos-todo.md](signal-combos-todo.md). One PR: the study, its report and the README row. Any routine change from the result is a separate step, Scott's to direct.

## Overview

An offline event study over 2019–2026. It builds a point-in-time timeline of six signals per stock from the existing caches, then runs the spec's five tests against VTI under a 3-SE promotion rule. Most of the machinery exists:
- `momentum.ts`: month-end deciles of the 12-1 month return;
- `quality.ts`: gross profitability by April formation from the SEC frames;
- `backtest.ts`: `outcomeAfter`, `cohortStats` and `promotion`;
- `research-tables.ts`: the report tables;
- `research-common.ts`: the bars cache and fetch.

The new pieces are the timeline, the five tests' groupings and the slope test, all pure and tested.

## Architecture decisions

- **One timeline, every test reads it.** `combos.ts` holds a `SignalTimeline`: for each symbol, its event dates by kind, plus a state lookup (momentum decile by month-end, quality percentile by formation). Each test is a function from the timeline to grouped anchors, so no test can see a signal another can't.
- **Every return is recomputed from the bars** with `outcomeAfter`, at each test's own entry: the first close after the anchor (or the later signal of a pair) became public. The cached excess returns are never reused.
- **The promotion rule takes its bar as a parameter.** `promotion(x, { minStdErrors: 3 })`. The default stays 2, so every earlier report regenerates unchanged.
- **The slope test** is a least-squares slope of the monthly cohort means against the signal count (0, 1, 2, 3+), each month weighted equally. Its standard error comes from the month-to-month variation, in-sample and held out. It lives in `combos.ts`, with a test against a known series.
- **The states are recomputed, not read from the old reports.** Momentum deciles come from the cached bars over the same tradable universe as the momentum study. Quality percentiles come from the SEC frames and the raw April closes the quality study cached. Both reuse the existing pure functions.

## Dependency graph

```
T1 promotion(minStdErrors) ─┐
T2 combos.ts (pure)  ───────┤
T3 load the signals ────────┴─► T4 score the five tests and write the report ─► T5 run, spot-check, summary
     (checkpoint: counts and coverage)                                              (Checkpoint: Scott reads)
```

T1 and T2 are independent. T3 needs T2's types. T4 needs all three.

## Phases

1. **Foundation (T1–T2):** the promotion bar as a parameter, and the pure timeline, groupings and slope.
2. **Data (T3):** load the six signals and the screens, then check counts and bar coverage before scoring anything.
3. **Study (T4–T5):** score, write the report, run it, spot-check, and write the summary.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **The cached bars miss symbols** the 13F and 13D studies scored | Medium: fewer events | T3 counts coverage first. `barsFor` fetches missing symbols with the paper key, market data only, and they're cached. |
| **The raw April closes don't cover every year or symbol** quality needs | Medium: quality only for some names | T3 reports coverage by formation year. A stock without quality data counts as "not top", and the report says how many. |
| **Momentum deciles over about 12,800 symbols are slow** | Low | They're computed once per month-end over the cached bars, with progress logged, and written to `.cache/combos/` for reruns. |
| **Groups too small to judge,** especially 3+ and the pairs | Medium: no verdict | The spec's 8-month floor: reported but not judged. The headline slope uses every group. |
| **The temptation to tweak after seeing results** | High: the whole point | Every definition is fixed in the spec, and the report states the rule before the tables. A new idea becomes a new issue. |

## Checkpoints

- **After T3:** counts per signal per year, bar coverage, and quality coverage, read before any return is computed. If a signal is far thinner than its own study showed, stop and look.
- **After T5 (Checkpoint D):** Scott reads the report. If a test passes, he decides whether it becomes a routine direction.
