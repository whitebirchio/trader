# Implementation Plan: earnings-reaction backtest (rethinking #15)

> Tasks are in [earnings-backtest-todo.md](earnings-backtest-todo.md).
> **Status: Approved** (Scott, 2026-11-08): ~150–300 MB of SEC company filing indexes; the insider-plus-earnings combination included.

## Why

The insider backtest (#29) showed that insider buying alone hasn't beaten VTI in the stocks Trader can buy. The routine's new direction (2026-11-08) tells Claude to **lead with fundamentals and catalysts, such as earnings surprises and guidance raises, and use insider buys as support**. That direction is a hypothesis too, so test it the same way before building a discovery screen around it (#15).

The question: **after a company reports earnings, does a big positive (or negative) market reaction keep going relative to VTI?** This is the classic post-earnings-announcement drift, and published work says it has weakened in large, liquid stocks. And does an insider buy shortly before improve the odds (the "supporting evidence" idea)?

## How the result reaches Trader

- **If reactions drift:** #15 becomes an **earnings screen**. It lists recent earnings releases with big reactions (and any insider buying alongside), scored by how events like them have done, so the routine starts each run from evidence-backed candidates. The routine prompt gets the specifics (which reactions, how long to hold).
- **If they don't:** the prompt says so, and we stop telling Claude that earnings beats are a lead signal. Then the next question is whether any public signal works in liquid stocks, or whether Trader's job is mainly not to lose to VTI.

## Data

- **Earnings dates:** SEC's per-company filing index (`data.sec.gov/submissions/CIK##########.json`). An 8-K with item **2.02** ("Results of Operations") is an earnings release, and its acceptance time says whether the market saw it before the open or after the close.
  - **Download:** one index per company in SEC's ticker list (`www.sec.gov/files/company_tickers.json`) that has Alpaca bars: about **6,000–8,000 companies × ~25 KB compressed**, plus an extra page for companies with long filing histories. That's **roughly 150–300 MB** over about 30 minutes, at ≤ 5 requests a second with SEC's documented User-Agent format.
  - **Cached** in `packages/core/.cache/edgar-submissions/` (git-ignored) and parsed as JSON data only.
- **Prices:** the Alpaca bars already cached from #29, fetching only what's missing.
- **Insider buys:** the #29 events, already cached.

## Method (same discipline as #29)

1. **Reaction day:** the first session where the market could trade on the release (the same day if it was accepted before 9:30 ET, otherwise the next session).
2. **Reaction:** the stock's return minus VTI's from the close before the reaction day to the close of it.
3. **Entry:** the close of the session **after** the reaction day, so the routine could realistically act on it, and only if risk's price and liquidity filters pass.
4. **Outcome:** excess return vs VTI over 20, 60 and 120 trading days.
5. **Buckets, fixed in advance:** reaction ≤ −10%, −10% to −5%, −5% to 0, 0 to +5%, +5% to +10%, ≥ +10%; the same with "an insider bought in the 90 days before" vs not; year by year; and without 2020.

## Code

- Factor the generic parts of `research/insider-backtest.ts` (entry, tradability, returns vs VTI, bucket statistics) into `research/backtest.ts`. The insider code keeps its parsing and grouping, and its tests keep passing unchanged.
- `research/earnings-backtest.ts`: earnings releases from submissions JSON → reaction-day events (pure, tested on real rows).
- `npm run research:earnings -w @trader/core`, writing `docs/research/earnings-reactions-vs-vti-2026-11.md`.

## Known biases (stated in the report)

- **Survivorship is worse than in #29:** SEC's ticker list holds only *current* companies, so firms that delisted or merged since 2018 are missing entirely. Read the results as an upper bound.
- No consensus estimates (they aren't free), so the market's reaction stands in for the surprise. Arguably that's better, since it includes guidance.

## Task list

- [ ] E1: Factor the generic backtest code out of the insider module (no behaviour change)
- [ ] E2: Earnings releases → reaction events (pure, real-row fixtures)
- [ ] E3: `research:earnings` script (company list → submissions → events → outcomes → report)
- **Checkpoint A:** five releases checked against their 8-Ks on sec.gov
- [ ] E4: Full run + report with a hand-written summary
- **Checkpoint B:** Scott reads it
- [ ] E5: Routine prompt per the finding; #15 rescoped (or closed) accordingly

## Resolved questions (Scott, 2026-11-08)

1. **Download:** approved (~150–300 MB of SEC company filing indexes).
2. **Insider-plus-earnings combination:** included.
