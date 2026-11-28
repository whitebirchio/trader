# Todo: do signals that agree beat VTI? (#140)

Plan: [signal-combos-plan.md](signal-combos-plan.md). Spec: [signal-combos-spec.md](signal-combos-spec.md). Gate before every commit: `npm run typecheck && npm test`. Branch: `feat/signal-combos`, cut from freshly pulled `main`.

### T1: The promotion bar as a parameter
- [x] *(Done 2026-11-28. The 13F and 13D caches were deleted when those studies closed, so instead of regenerating their reports, a test proves the default keeps the old "in-sample 2 SE" wording and verdicts.)* **What:** `promotion(x, { minStdErrors })`, defaulting to 2. The failure label names the bar ("in-sample 3 SE"). `promotionTable` passes it through.
- **Acceptance:** at 3, a bucket at 2.5 SE fails and one at 3.1 passes. The 13F and 13D reports regenerate byte for byte at the default.
- **Verify:** `npx vitest run backtest research-tables`.
- **Files:** `packages/core/src/research/backtest.ts`, `packages/core/scripts/research-tables.ts`, tests.
- **Depends on:** none · **Scope:** S

### T2: The timeline, the groupings and the slope (pure)
- [x] **What:** `src/research/combos.ts`:
  - `SignalTimeline` and `activeSignals(timeline, symbol, date, except)`: events within 90 days, states as of the date;
  - `firstAnchors` (one per stock per 90 days);
  - `pairEntries` (the later signal's public date);
  - `screened` (no recent big loser, no fresh earnings crash);
  - `countSlope` (the least-squares slope of monthly means against the count, with its SE).
- **Acceptance:**
  - an event at 90 days counts and one at 91 doesn't;
  - a state counts only while it holds;
  - the first anchor wins;
  - a pair enters on the later date;
  - the screens drop exactly the flagged events;
  - the slope and SE match a hand-computed series.
- **Verify:** `npx vitest run combos`.
- **Files:** `packages/core/src/research/combos.ts`, `packages/core/test/research/combos.test.ts`.
- **Depends on:** none · **Scope:** M

### T3: Load the six signals and the screens
- [x] *(2026-11-28. Counts from 2019 against each source study, which also includes 2018:
  - insider clusters: 3,365 (the study's 2+ buyers: 3,862);
  - earnings +5%: 9,994 (10,898);
  - 13F big new positions: 273 (288);
  - concentrated 13D/13G: 365 (394).

  All have cached bars. Momentum's top decile is 179–258 stocks a month. Quality ranks 761–1,115 companies an April, exactly the quality study's gross-profitability counts, and is known for 49% of anchors.)* **What:** in `scripts/research-combos.ts`, build the timeline from the caches:
  - **Insider clusters:** `buyers ≥ 2`, public on the last filing.
  - **Earnings:** reactions ≥ +5% (signals) and ≤ −10% (crashes).
  - **13F:** `newTop5`.
  - **13D/13G:** concentrated, initial filings.
  - **Momentum:** deciles at each month-end, over the tradable universe of cached bars.
  - **Quality:** gross-profitability percentiles at each April formation.

  Log counts per signal and year, bar coverage and quality coverage, then stop (`--counts-only`).
- **Acceptance:** each event signal's counts are close to its own study's (within the 2019 start and the universe), and the coverage figures are reported.
- **Verify:** `npm run research:combos -w @trader/core -- --counts-only`, read against the source reports.
- **Files:** `packages/core/scripts/research-combos.ts`, `packages/core/package.json`.
- **Depends on:** T2 · **Scope:** M

### Checkpoint: data
- [ ] Counts, bar coverage and quality coverage read. Nothing is far off its source study.

### T4: Score the five tests and write the report
- [ ] **What:** score each test's anchors with `outcomeAfter` at its own entry. Group them as the spec says. Write the report with `research-tables.ts`:
  - the rule, stated first;
  - each test's promotion table at 3 SE;
  - cohort and event tables;
  - in-sample, held out and year by year;
  - the headline slope ± SE.

  `--events` writes every scored anchor for spot checks.
- **Acceptance:**
  - every test has a verdict, or "too few months to judge";
  - the 3+ group and the pairs show their month counts;
  - the report regenerates under its marker without touching a hand-written summary.
- **Verify:** a run over 2019 only, read by hand; the gate.
- **Files:** `packages/core/scripts/research-combos.ts`.
- **Depends on:** T1, T2, T3 · **Scope:** M

### T5: The full run, the summary and the README
- [ ] **What:** run 2019–2026 and spot-check five events (one per event signal, plus a pair) against their source studies' event files and sec.gov. Write the summary above the tables (bottom line, what it means for Trader, caveats), and add a row to `docs/research/README.md`.
- **Acceptance:** spec success criteria 1–4.
- **Verify:** the spot checks; the gate.
- **Files:** `docs/research/signal-combos-vs-vti-2026-11.md`, `docs/research/README.md`, this file.
- **Depends on:** T4 · **Scope:** S

### Checkpoint D
- [ ] Scott reads the report. If a test passes, he decides whether it becomes an owner's direction. If none does, #140 closes with the finding.
