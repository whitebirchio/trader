# How long to hold an insider-led thesis before reviewing it, replayed 2019–2026

> Replay for the exits plan, run 2026-11-10 evening. It uses the same rule, data and method as [insider-replay-2026-11.md](insider-replay-2026-11.md), against the baseline from [thesis-exits-replay-2026-11.md](thesis-exits-replay-2026-11.md), which already has ADR-017's halt rules. The full diffs are in [review-window-replay-2026-11/](review-window-replay-2026-11/). The figures are a simulated $100,000 account, not Trader's.

## Bottom line

**A review six to nine weeks after the first buy did best. 30 days was too short, and 90 days too long.** By Scott's decision the same evening, the routine's window for insider-led theses moved from "about six weeks" to "about six to eight weeks".

| Review after | Return | vs baseline, points | vs VTI, points | Theses | Thesis mean vs VTI | Beat VTI | Purchases, % of average equity |
|---|---:|---:|---:|---:|---:|---:|---:|
| 30 days | +150.7% | +11.0 | −67.7 | 386 | −0.6% | 44% | 4,021% |
| 42 days | +191.1% | +51.5 | −27.2 | 309 | +0.2% | 48% | 3,202% |
| 60 days | **+214.9%** | **+75.2** | **−3.5** | 256 | +0.2% | 45% | 2,474% |
| 90 days (baseline) | +139.7% | | −78.7 | 199 | −2.2% | 37% | 2,042% |

VTI returned +218.4% over the same period.

## What it shows

- **A shorter review helps, up to a point.** Whatever rebound follows insider buying comes in the first weeks, as the backtest found, so a 90-day hold gives it back. That held with today's halt rules: this note's 42-day run (+51 points) agrees with the 45-day run before ADR-017 (+57).
- **30 days is too short.** It closes theses before the rebound finishes, and it doubles turnover, so more of the account is spent buying and selling. It gained only 11 points.
- **42 and 60 days look the same per thesis.** Both average +0.2% against VTI (±1%). Most of the gap between their account totals (51 against 75 points) is compounding and path, not a clearer edge. Sixty days also traded less: 2,474% of average equity against 3,202%, so fewer short-term gains and wash sales.
- **Nothing here beat VTI.** Even the best window only roughly matched it. This is the base rate Claude's research starts from, not a strategy.

## How far to trust it

The caveats in [insider-replay-2026-11.md](insider-replay-2026-11.md) all apply:
- it's a mechanical rule, not Claude's judgment;
- survivorship;
- daily bars only.

Each window was replayed once, on one history. The per-thesis means differ by less than their standard errors, so read the table as "six to nine weeks beats both ends", not as a precise optimum. The live routine also re-judges every thesis every run, so its review date is a backstop: the latest a thesis can be held without fresh evidence.

## Reproduce

```sh
npm run replay -w @trader/core -- --rules insiders --from 2019-01-02 --to 2026-11-06 \
  --variant review-days=60 --baseline-report .cache/replay/reports/rules-insiders-2019-01-02-2026-11-06-10bps.json
```

Each run takes about 10 minutes since #89 (it took about three hours before).
