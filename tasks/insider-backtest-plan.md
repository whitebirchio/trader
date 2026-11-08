# Implementation Plan: insider-buy backtest (#29)

> Tasks are in [insider-backtest-todo.md](insider-backtest-todo.md).
> **Status: Approved** (Scott, 2026-11-07): 2018–2026 download (~350 MB), report committed, B5 a definite step.

## Why

Every live thesis is the same bet: officers or directors buying their own stock on the open market, usually after a sell-off. The scorecard (#27) needs months of closed theses before it can say whether that pays. A backtest over past Form 4 purchases can say it now, and say *which* insider buys are worth following (cluster size, role, size of the buy, a prior drawdown), so the routine sizes theses on evidence.

## What it is, and how it reaches decisions

An **offline research tool**, not engine code. Nothing runs on a schedule, trades, or touches the database. The output is a dated markdown report in `docs/research/`. It reaches Trader's decisions in two steps:
1. **B5 (definite, after Scott reads the report):** the routine prompt, which Claude follows every run, states the findings: which insider buys have beaten VTI, by how much, over what holding period, and which haven't. That changes what Claude picks, how it sizes, and how long it holds. If the result is "no edge", the prompt says that instead, and the live concentration in insider-buy theses gets reconsidered.
2. **#15 (next):** the EDGAR discovery screen reuses this module's parsing, event grouping and bucket statistics, so each live candidate reaches Claude scored by how events like it have done historically.

## Data

- **Insider purchases:** SEC's quarterly [Insider Transactions Data Sets](https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets). These are zips of tab-separated tables taken from every Form 3/4/5 filing: `SUBMISSION` (issuer, ticker, filing date), `REPORTINGOWNER` (role: director, officer and title, 10% owner) and `NONDERIV_TRANS` (transaction code, shares, price, date).
  - **Download:** `2018q1_form345.zip` … `2026q2_form345.zip` (34 files, about 8–14 MB each, **about 350 MB in total**) from `www.sec.gov/files/…/insider-transactions-data-sets/`. Requests use a User-Agent naming you, which SEC requires, and stay well under its 10 requests/second limit.
  - **Kept** in a git-ignored cache (`packages/core/.cache/edgar/`), one directory per zip. Unzipped with the system `unzip` (no new dependency). The contents are treated as untrusted data: parsed as text, never executed.
- **Prices:** daily adjusted bars from Alpaca's market-data API (the existing `getDailyBars`, paper keys), cached on disk. VTI is the benchmark, as everywhere else.

## Method

1. **Purchases:** transaction code `P` (open-market purchase), price > 0, by a director, an officer or a 10% owner. Excluded: amendments, and trades flagged 10b5-1 where the field exists (2023 onward).
2. **Events:** purchases in one issuer are grouped into an event when they're filed within 30 days of each other. Event features: number of distinct insiders, whether the CEO or CFO bought, total dollars, and the stock's return over the 60 trading days before (a "dip" means −20% or worse).
3. **No look-ahead:** entry is the close of the first trading day **after the filing date**, when the buy became public, not the trade date.
4. **Tradable universe:** at entry the stock must pass risk's filters (price ≥ $5, 20-day average dollar volume ≥ $10M), so the results describe what Trader can actually buy.
5. **Outcome:** the stock's return minus VTI's over the same 20, 60 and 120 trading days.
6. **Report:** for each bucket (cluster size 1 / 2 / 3+, CEO or CFO vs other, dollars < $100k / $100k–$1M / > $1M, dip vs no dip, and the combination closest to the live strategy), the count, mean and median excess return, the share that beat VTI, and a standard error. Also year by year, so one crash (March 2020) can't carry the result.

## Known biases (stated in the report)

- **Survivorship:** symbols Alpaca no longer has (delisted, merged) have no bars and drop out, which likely flatters the results. The report counts how many were dropped.
- **Overlapping events** cluster in time, so they aren't independent; the year-by-year table is the check.
- The close after filing isn't a fill price, and spreads and taxes aren't modelled.

## Code layout

- `packages/core/src/research/insider-backtest.ts`: pure functions (parse rows → purchases → events → returns → bucket stats), tested like the rest of core. Shaped for #15 to reuse: parsing and grouping take rows, not files, and an event's bucket can be computed for a live event.
- `packages/core/scripts/research-insiders.ts` (`npm run research:insiders -w @trader/core`): download, cache, fetch bars, write the report.

## Task list

- [ ] B1: Purchases and events from data-set rows (pure, fixtures from a real quarter)
- [ ] B2: Forward returns vs VTI and bucket statistics (pure)
- [ ] B3: Fetch + cache script (EDGAR zips, Alpaca bars), one quarter end to end
- **Checkpoint A:** one quarter's events spot-checked against filings on sec.gov
- [ ] B4: Full run 2018–2026, report in `docs/research/`
- **Checkpoint B:** Scott reads the report
- [ ] B5: the routine prompt states the findings (whatever they are), then merge and RemoteTrigger

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Data-set columns differ across years (the 10b5-1 field is new) | Med | Parse by header name; a missing optional column means "unknown", not an error; test on an old and a new quarter |
| Survivorship flatters the result | High: it could make a weak signal look good | Count and report the dropped events; read the result as an upper bound |
| Alpaca bar requests take long | Low | Batch symbols per request, cache on disk, resumable |
| Over-fitting buckets | Med | Few predefined buckets (no search), year-by-year stability, standard errors |

## Resolved questions (Scott, 2026-11-07)

1. **Range:** 2018q1–2026q2 (about 350 MB).
2. **Report:** committed to `docs/research/`.
