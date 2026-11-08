# Tasks: earnings-reaction backtest (rethinking #15)

> Plan: [earnings-backtest-plan.md](earnings-backtest-plan.md)
> **gate** = `npm run typecheck && npm test` (check each exit code directly). Focused: `npx vitest run research` (in `packages/core`). One PR from `feat/earnings-backtest`, cut from pulled `main`.

### E1: Generic backtest code
- [ ] `src/research/backtest.ts`: `eventOutcome` over any `{ ticker, publicOn }` event, `Tradability`, `HORIZONS`, `bucketStats`, `breakdown`
- [ ] The insider module and script use it; insider tests pass unchanged
- **Scope:** S

### E2: Earnings releases → reaction events (pure)
- [ ] `earningsReleases(submissions)`: 8-Ks with item 2.02 → `{ cik, ticker, acceptedAt, filedOn }`, from both the recent array and older pages
- [ ] `reactionEvent(release, bars, vti)`: the reaction day (before 9:30 ET → same session, else the next), the reaction vs VTI, and the event's public date for entry (the day after the reaction day)
- [ ] `insiderBefore(event, insiderEvents, 90)`: whether an insider bought in the 90 days before
- [ ] Tests: real submissions JSON trimmed (an after-close and a pre-open release), a weekend filing, a missing bar
- **Depends on:** E1 · **Scope:** M

### E3: Script
- [ ] `scripts/research-earnings.ts`: SEC ticker list ∩ symbols with bars → submissions (cached, ≤ 5 req/s, SEC User-Agent format "Name email", resumable, stdin closed) → releases 2018–2026q2 → events → outcomes → report sections (reaction buckets, with/without a prior insider buy, by year, without 2020)
- [ ] The insider script's User-Agent moves to SEC's documented format
- **Depends on:** E2 · **Scope:** M

## Checkpoint A
- [ ] Gate green
- [ ] Five releases checked against their 8-Ks on sec.gov (item 2.02, acceptance time, reaction day)

### E4: Full run + report
- [ ] `docs/research/earnings-reactions-vs-vti-2026-11.md` with a hand-written summary above the generated tables
- **Scope:** S

## Checkpoint B
- [ ] Scott reads the report

### E5: Into Trader
- [ ] Routine prompt per the finding; merge → RemoteTrigger
- [ ] #15 rescoped to an earnings screen, or closed with the reason
