# Tasks: earnings-reaction backtest (rethinking #15)

> Plan: [earnings-backtest-plan.md](earnings-backtest-plan.md)
> **gate** = `npm run typecheck && npm test` (check each exit code directly). Focused: `npx vitest run research` (in `packages/core`). One PR from `feat/earnings-backtest`, cut from pulled `main`.

### E1: Generic backtest code
- [x] `src/research/backtest.ts`: `eventOutcome` over any `{ ticker, publicOn }` event, `Tradability`, `HORIZONS`, `bucketStats`, `breakdown`
- [x] The insider module and script use it; insider tests pass unchanged
- **Scope:** S

### E2: Earnings releases → reaction events (pure)
- [x] `earningsReleases(submissions)`: 8-Ks with item 2.02 → `{ cik, ticker, acceptedAt, filedOn }`, from both the recent array and older pages
- [x] `reactionEvent(release, bars, vti)`: the reaction day (before 9:30 ET → same session, else the next), the reaction vs VTI, and the event's public date for entry (the day after the reaction day)
- [x] `insiderBefore(event, insiderEvents, 90)`: whether an insider bought in the 90 days before
- [x] Tests: real submissions JSON trimmed (an after-close and a pre-open release), a weekend filing, a missing bar
- **Depends on:** E1 · **Scope:** M

### E3: Script
- [x] `scripts/research-earnings.ts`: SEC ticker list ∩ symbols with bars → submissions (cached, ≤ 5 req/s, SEC User-Agent format "Name email", resumable, stdin closed) → releases 2018–2026q2 → events → outcomes → report sections (reaction buckets, with/without a prior insider buy, by year, without 2020)
- [x] The insider script's User-Agent moves to SEC's documented format
- **Depends on:** E2 · **Scope:** M

## Checkpoint A
- [x] Gate green
- [x] Five releases checked against their filing pages on sec.gov (2026-11-08): NVDA ×2, META, AMD, MSFT; item 2.02 present, acceptance time matches SEC's ET stamp exactly (UTC handled right), after-close releases react the next session

### E4: Full run + report
- [ ] `docs/research/earnings-reactions-vs-vti-2026-11.md` with a hand-written summary above the generated tables
- **Scope:** S

## Checkpoint B
- [ ] Scott reads the report

### E5: Into Trader
- [ ] Routine prompt per the finding; merge → RemoteTrigger
- [ ] #15 rescoped to an earnings screen, or closed with the reason
