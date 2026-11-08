# Implementation Plan: momentum and quality backtests (#49)

> Tasks are in [momentum-quality-todo.md](momentum-quality-todo.md).
> **Status: Approved** (Scott, 2026-11-08): the ~10 MB of SEC XBRL frames, and the promotion rule as written (fixed before any results).

## Why

The owner chose to stay aggressive with a higher evidence bar (2026-11-08) and to keep looking for signals that pay. Insider buying (#29) and earnings reactions (#48) didn't beat VTI in stocks Trader can buy. This tests the two families with the strongest published records: **price momentum** and **quality/value**. It uses the same tradable universe and VTI benchmark, and adds one new safeguard: a **held-out period**.

## The safeguard: decide in-sample, confirm out of sample

The more signals we test, the likelier one looks good by chance. So:
- **In-sample, 2018–2023:** look at results and decide which variant, if any, is worth promoting.
- **Held out, 2024 to mid-2026:** computed by the same code, but read only to confirm or reject that choice. No variant is added or tuned after seeing it.
- **Promotion rule:** a variant becomes a lead signal in the routine prompt only if its top bucket beats VTI on the held-out years **after an assumed 0.2% round-trip cost**, and the in-sample result points the same way.

## Momentum (no new data)

- **Formation:** at each month-end from mid-2018, among stocks that pass risk's price and liquidity filters and have 12 months of bars.
- **Signal:** the 12-1 month return (the return from 12 months ago to 1 month ago, skipping the latest month, as published).
- **Buckets:** deciles by signal. Variants:
  - plain 12-1;
  - 12-1 among stocks above their 200-day average (a trend filter);
  - 6-1 (a shorter horizon).
- **Outcome:** each stock's return minus VTI's over the next 20 and 60 trading days (about 1 and 3 months), from the first close after formation.
- **Statistics, done honestly:** stocks in the same month move together, so each decile's mean is taken **per month first**. The statistics are over that monthly series (mean, standard error, the share of months it beat VTI). It isn't pooled across stock-months, which would overstate confidence.
- **Data:** the Alpaca bars already cached by #29 and #48 (about 7,000 symbols since mid-2017).

## Quality / value (a small new download)

- **Data:** SEC's XBRL **frames** API (`data.sec.gov/api/xbrl/frames/…`): one file per concept per year, covering every filer. The concepts:
  - gross profit, or revenue minus cost of revenue;
  - net income;
  - total assets and stockholders' equity (year-end);
  - shares outstanding.

  That's about 6 concepts × 9 years, **roughly 10 MB in total**, cached in `packages/core/.cache/edgar-frames/`.
- **Formation:** each year at the end of April, using the prior calendar year's figures. Frames carry no filing date, so the April lag is conservative: most calendar-year 10-Ks are filed by March.
- **Metrics (deciles):**
  - gross profitability (gross profit ÷ assets, Novy-Marx);
  - earnings yield (net income ÷ market value);
  - book-to-market (equity ÷ market value);
  - a quality-plus-value combination (the average of the profitability and earnings-yield ranks).
- **Outcome:** return minus VTI over 1, 3, 6 and 12 months from the first close after formation.
- **Weakness:** annual formation gives only 5 in-sample and 2–3 held-out cohorts, and stocks within a cohort move together. The report will say so plainly.

## Code

- `research/momentum.ts` (pure): formation dates, signals, deciles, per-month decile series, statistics. Tested on synthetic bars.
- `research/quality.ts` (pure): frames rows → per-company yearly metrics (fiscal years mapped as SEC does), cohorts, deciles. Tested on trimmed real frames.
- Scripts `research:momentum` and `research:quality` reuse `research-common.ts` (bars, tables, report writer).
- Reports: `docs/research/momentum-vs-vti-2026-11.md` and `docs/research/quality-value-vs-vti-2026-11.md`.

## Known biases (stated in each report)

- **Survivorship:** the universe is the symbols with cached bars, mostly current companies plus #29's insider names. Missing delistings flatter low-momentum and low-quality buckets the most, which probably *understates* the spreads but overstates every bucket against VTI.
- Frames map each company's fiscal year to the nearest calendar year, and have no filing date (hence the April lag).
- Equal-weighted buckets, monthly rebalancing, and no taxes. Costs enter only through the promotion rule.

## How the result reaches Trader

- **If something passes the promotion rule:** the routine prompt gets it as a named lead signal, with how to use it and how long to hold. It could later feed an automated screen, or the dormant systematic sleeve: the momentum machinery is already built (SPEC-portfolio), just idle by the owner's choice. Either would be its own decision.
- **If nothing passes:** the reports say so. That's the third independent result pointing the same way, and worth weighing when deciding how much of the account stays in single-stock bets.

## Task list

- [ ] M1: Momentum core (pure, tested)
- [ ] M2: `research:momentum` + report
- **Checkpoint A:** three formations recomputed by hand from cached bars
- [ ] Q1: Frames fetch + parse (needs the download OK); quality core (pure, tested)
- [ ] Q2: `research:quality` + report
- **Checkpoint B:** five companies' metrics checked against their 10-Ks
- **Checkpoint C:** Scott reads both reports; decide what (if anything) reaches the prompt

## Resolved questions (Scott, 2026-11-08)

1. **Download:** the ~10 MB of SEC XBRL frames.
2. **Promotion rule:** as written, fixed before any results were seen.
