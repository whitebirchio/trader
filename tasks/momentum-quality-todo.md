# Tasks: momentum and quality backtests (#49)

> Plan: [momentum-quality-plan.md](momentum-quality-plan.md)
> **gate** = `npm run typecheck && npm test` (check each exit code directly). Focused: `npx vitest run research` (in `packages/core`). Branch `feat/momentum-quality`.

### M1: Momentum core (pure)
- [x] Month-end formation dates from VTI's sessions; per-symbol signal (12-1, 6-1) at each, with the 200-day trend flag; tradable at formation (risk's filters)
- [x] Deciles per formation; each stock's excess vs VTI over 21 and 63 trading days from the next close
- [x] Per-month decile means → series statistics (mean, SE over months, share of months beating VTI), split in-sample (≤ 2023) / held out (≥ 2024)
- [x] Tests on synthetic bars (hand-computed signals, decile edges, the month-first statistics, the split)

### M2: Script + report
- [ ] `research:momentum` from the cached bars; report with decile tables per variant, top-minus-bottom, top vs VTI, by year, in-sample vs held out; hand-written summary

## Checkpoint A
- [ ] Gate green; three (symbol, formation) signals recomputed by hand from cached bars

### Q1: Quality core (needs the frames download approved)
- [ ] Fetch + cache frames (annual durations `CY{yyyy}`, year-end instants `CY{yyyy}Q4I`) for the concepts in the plan
- [ ] Pure: frames rows → per-CIK yearly metrics; market value at formation from shares × price; deciles per April cohort; outcomes at 21/63/126/252 days
- [ ] Tests on trimmed real frames

### Q2: Script + report
- [ ] `research:quality`; report per metric and the combination, in-sample vs held out; hand-written summary

## Checkpoint B
- [ ] Gate green; five companies' figures checked against their 10-Ks on sec.gov

## Checkpoint C
- [ ] Scott reads both reports; any prompt change is its own decision
