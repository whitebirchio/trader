# 13F best ideas vs VTI, 2018–2026

> Backtest for [#138](https://github.com/whitebirchio/trader/issues/138) Part 1, run 2026-11-20 from SEC's Form 13F Data Sets (2016q1 to the June–August 2026 window) and Alpaca's adjusted daily bars. Method: [tasks/13f-backtest-plan.md](../../tasks/13f-backtest-plan.md). The summary is hand-written from the tables below, which `npm run research:13f -w @trader/core -- --report ../../docs/research/13f-best-ideas-vs-vti-2026-11.md` regenerates.

## Bottom line

**Following concentrated, long-horizon managers' 13F filings has not beaten VTI in the stocks Trader can buy. No bucket passes the promotion rule. The managers' largest holdings trailed VTI, and the lag isn't what loses the edge.**

1. **No edge in what they buy.**
   - **New positions** (3,777 events) were flat against VTI: +0.0% ± 0.8% over 60 days by quarter, and 49% beat it.
   - **Large adds** (4,946) were flat too.
   - **Names two or more of these managers bought in the same quarter** (1,288) were −0.1%.
   - None of the three was stable from year to year: each was up 4% in 2020 and down 2–3% in 2021 and 2022.
2. **Their biggest holdings trailed VTI.**
   - A manager's **largest position** lost to VTI by 1.1% ± 0.5% over 60 days and by 3.6% over a year.
   - Their **top three** lost by 0.6% and 1.9%.
   - Both were worse in the held-out years (2024–2026).
3. **"New in top 5" (5%+ of the book) came closest and still fails.**
   - In-sample it was +2.2% ± 1.6% over 60 days (24 quarters, 175 events). That's under the 2 standard errors the rule needs.
   - Held out it was +0.8% ± 1.5%.
   - Over a year it turned negative (−0.7% overall, −6.9% held out).
   - It's a small bucket, about 30 events a year, and one year (2020, +8.1%) carries much of it.
4. **The 45-day lag costs little.** Entering at the quarter's end (which no one can do: the holdings aren't public yet) instead of after the filing would have added 0.1–0.9 points over 60 days. So the issue's worry was the wrong one: there was little to lose. The edge wasn't there at the quarter's end either.
5. **The famous names are no exception once hindsight is set aside.**
   - Berkshire's and Pershing's **largest positions** did well (+9.6% over a year). That's mostly Apple at Berkshire, which is exactly the hindsight the named list warns about.
   - Their **new positions** (−1.4% over 60 days, 77 events) and **large adds** (−4.2%, 48 events) did not beat VTI.

## What it means for Trader

- **A 13F filing is not a reason to buy on its own.** This is the same finding as for insider buying ([insider-buys-vs-vti-2026-11.md](insider-buys-vs-vti-2026-11.md)). A respected manager's purchase is a lead to research, not evidence that the market is wrong.
- **It doesn't test Claude's judgment on top of the signal.** The live 13F theses also have fundamental evidence and a stated reason the market is wrong, and that layer could still add value. But the base rate it starts from is flat to negative.
- **For the routine prompt (T6), to decide with Scott:**
  - Treat a 13F position as **supporting evidence**, not a lead signal: every thesis needs a lead signal of another kind. The alternative is to keep `13f` as a lead but size such theses at 5–10%, as insider- and earnings-led ones are.
  - Don't read a manager's largest, long-held positions as a buy signal. In this test they trailed VTI.
  - If a 13F is cited, a new position that's a large share of the manager's book is the closest thing to a signal here. It's still unproven.
- **For Part 2 (13D/13G):** the lag barely mattered for 13Fs. Part 2 asks whether a different filing (a 5% stake, often with intent to push for change) carries a different signal, not just an earlier one.

## Caveats

- **Equal-weighted against cap-weighted.** Every bucket is an average of individual stocks, and VTI is weighted by market value. Over 2018–2026 the largest companies led, so an average stock trailed VTI. Part of every negative figure here is that, not the managers. VTI is still the right yardstick, because it's what Trader holds instead.
- **Survivorship.**
  - 1,852 rule-based events are in CUSIPs that couldn't be mapped to a ticker (279 of 3,151 CUSIPs), and 211 more had no bars. These are mostly delisted or merged companies, and share classes.
  - Mergers often pay a premium, so the gap could cut either way here, unlike in the insider study.
- **The manager rule is one definition.** It was fixed before any results: 30 or fewer positions, $1B or more, 4+ prior filings, the median position held a year or more. The number of managers that pass grew from about 115 a quarter to about 200. A different definition of "concentrated, long-horizon" could select differently, but searching for one that works would be overfitting.
- **Entry** is the first close after the filing date, not a fill. Spreads and taxes aren't modelled (the promotion rule charges a 0.2% round trip).
- **Overlap.** Quarters are the unit, so the 60-day standard errors are honest. The 120- and 250-day windows overlap from one quarter to the next, so their standard errors are too small.
- **Data fixes,** counted in the tables:
  - 5,630 filings used the wrong unit for their era (dollars for thousands, or the reverse) and were corrected by their median implied share price.
  - Amendments and filings more than 120 days late weren't scored.
  - Option rows, notes and ETFs were dropped.

<!-- generated by npm run research:13f: everything below is regenerated -->

**Data:** 43 windows of SEC's Form 13F Data Sets (2016q1 to 01jun2026-31aug2026): 260,991 original holdings reports, of which 136,695 were small enough to keep (100 positions or fewer). Not scored: 12,855 amendments and 7,446 originals filed more than 120 days after their quarter. Units corrected (a filer that used the wrong unit for its era): 5,630 filings.

**Concentrated managers per quarter** (30 or fewer positions, $1B or more, 4+ prior filings, the median position held 4+ quarters, related filers collapsed): 2017 115, 2018 113, 2019 130, 2020 111, 2021 146, 2022 147, 2023 174, 2024 187, 2025 196, 2026 199. Their median filing came 45 days after the quarter's end.

**Scored** (filed 2018-01-01 on): 26,585 rule-based events and 432 named-list events. **Left out:** rule-based 2,060 untradable, 1,852 unmapped, 3,427 fund or ETF, 138 no entry, 211 no bars, 2 stale bars; named list 9 untradable, 14 unmapped, 2 fund or ETF. CUSIPs were mapped to tickers by OpenFIGI (2098) or, where it has no US listing, by SEC's fails-to-deliver data (774); 279 of 3151 stayed unmapped. "Unmapped" events are in those CUSIPs (mostly delisted, merged or renamed companies, and share classes the fails data can't name: the survivorship gap) and "stale bars" are symbols whose bars start long after the filing (the ticker belongs to a later listing).

Excess return = the stock's return minus VTI's over the same trading days, from the first close after the filing date. In-sample: filings before 2024-01-01; held out: from it. A quarter is one cohort: its events' mean counts once, so the standard error is across quarters. 120- and 250-day windows overlap from one quarter to the next, so their standard errors understate the uncertainty.

## Promotion rule

Fixed before any results: after a 0.2% round trip, the 60-day quarter-level mean beats VTI in-sample and held out, the in-sample mean is at least 2 standard errors above zero, and the in-sample 120-day mean doesn't reverse it. Only these six buckets are scored.

| Bucket | In-sample 60d (quarters) | Held-out 60d (quarters) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| New position | −0.1% ± 1.1% (24) | +0.4% ± 1.0% (11) | −0.5% | fails: in-sample 60d, in-sample 2 SE, 120d reverses |
| Large add (shares +25%) | +0.1% ± 0.8% (24) | −0.3% ± 1.1% (11) | −0.2% | fails: in-sample 60d, held-out 60d, in-sample 2 SE, 120d reverses |
| Best idea (largest position) | −1.0% ± 0.6% (24) | −1.3% ± 1.1% (11) | −1.9% | fails: in-sample 60d, held-out 60d, in-sample 2 SE, 120d reverses |
| Top 3 | −0.3% ± 0.5% (24) | −1.3% ± 0.9% (11) | −0.6% | fails: in-sample 60d, held-out 60d, in-sample 2 SE, 120d reverses |
| New in top 5 (5%+ of the book) | +2.2% ± 1.6% (24) | +0.8% ± 1.5% (11) | +1.7% | fails: in-sample 2 SE |
| Consensus (2+ managers) | −0.3% ± 1.3% (24) | +0.4% ± 1.4% (11) | −0.2% | fails: in-sample 60d, in-sample 2 SE, 120d reverses |

**No bucket passes.**

## Concentrated managers: by quarter

| Bucket | Quarters | 20d | 60d | 60d quarters beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| New position | 35 | +0.2% ± 0.5% | +0.0% ± 0.8% | 57% | −0.2% ± 1.0% | +0.1% ± 1.7% |
| Large add (shares +25%) | 35 | +0.0% ± 0.4% | −0.0% ± 0.6% | 57% | −0.6% ± 0.8% | +0.2% ± 1.5% |
| Best idea (largest position) | 35 | −0.5% ± 0.3% | −1.1% ± 0.5% | 37% | −2.0% ± 0.9% | −3.6% ± 1.4% |
| Top 3 | 35 | −0.4% ± 0.2% | −0.6% ± 0.4% | 43% | −1.0% ± 0.7% | −1.9% ± 1.2% |
| New in top 5 (5%+ of the book) | 35 | +1.6% ± 0.7% | +1.8% ± 1.2% | 51% | +1.7% ± 1.8% | −0.7% ± 2.6% |
| Consensus (2+ managers) | 35 | +0.3% ± 0.7% | −0.1% ± 1.0% | 66% | −0.6% ± 1.2% | +0.7% ± 2.4% |

## Concentrated managers: by event

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| New position | 3777 | +0.3% | +0.2% ± 0.3% | −0.4% | 49% | +0.2% | +1.1% |
| Large add (shares +25%) | 4946 | +0.0% | −0.3% ± 0.3% | −0.6% | 48% | −0.8% | −0.1% |
| Best idea (largest position) | 4104 | −0.5% | −1.1% ± 0.3% | −1.2% | 47% | −2.2% | −3.8% |
| Top 3 | 11315 | −0.4% | −0.7% ± 0.2% | −1.0% | 47% | −1.2% | −2.0% |
| New in top 5 (5%+ of the book) | 288 | +1.3% | +1.5% ± 1.1% | +0.6% | 53% | +1.0% | −0.6% |
| Consensus (2+ managers) | 1288 | +0.6% | −0.1% ± 0.6% | −0.3% | 49% | −0.3% | +2.4% |

### In-sample and held out (by event)

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| New position, in-sample | 2244 | +0.0% | −0.2% ± 0.4% | +0.1% | 50% | −0.2% | +0.6% |
| Large add (shares +25%), in-sample | 3073 | +0.1% | −0.1% ± 0.3% | +0.1% | 50% | −0.4% | +0.0% |
| Best idea (largest position), in-sample | 2508 | −0.6% | −1.0% ± 0.4% | −0.7% | 48% | −2.0% | −3.3% |
| Top 3, in-sample | 6872 | −0.3% | −0.4% ± 0.2% | −0.5% | 49% | −0.6% | −0.9% |
| New in top 5 (5%+ of the book), in-sample | 175 | +1.8% | +1.8% ± 1.4% | +1.6% | 57% | +1.4% | +1.9% |
| Consensus (2+ managers), in-sample | 741 | +0.3% | −0.1% ± 0.8% | +0.3% | 51% | +0.4% | +2.7% |
| New position, held out | 1533 | +0.7% | +0.6% ± 0.6% | −1.0% | 47% | +0.8% | +2.3% |
| Large add (shares +25%), held out | 1873 | −0.1% | −0.5% ± 0.5% | −2.0% | 45% | −1.6% | −0.4% |
| Best idea (largest position), held out | 1596 | −0.5% | −1.3% ± 0.5% | −2.2% | 44% | −2.4% | −4.9% |
| Top 3, held out | 4443 | −0.6% | −1.2% ± 0.3% | −2.3% | 44% | −2.2% | −4.7% |
| New in top 5 (5%+ of the book), held out | 113 | +0.5% | +1.0% ± 1.8% | −0.5% | 48% | +0.2% | −6.9% |
| Consensus (2+ managers), held out | 547 | +0.9% | −0.0% ± 0.9% | −0.8% | 47% | −1.4% | +1.8% |

### Year by year (60-day mean, events)

| Bucket | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| New position | +0.0% (353) | +0.6% (365) | +4.0% (423) | −2.5% (356) | −2.8% (339) | −1.0% (408) | +1.0% (476) | +0.4% (649) | +0.6% (408) |
| Large add (shares +25%) | +0.2% (399) | +0.7% (513) | +3.8% (529) | −2.6% (589) | −2.4% (557) | −0.0% (486) | +1.2% (645) | −1.6% (754) | −0.9% (474) |
| Best idea (largest position) | −2.2% (346) | −1.5% (387) | +2.1% (344) | −4.1% (448) | +0.3% (457) | −0.5% (526) | +0.9% (603) | −3.1% (621) | −1.7% (372) |
| Top 3 | −0.5% (957) | −1.0% (1051) | +2.3% (958) | −2.6% (1193) | −0.2% (1269) | +0.0% (1444) | +0.7% (1647) | −2.5% (1747) | −2.1% (1049) |
| New in top 5 (5%+ of the book) | −1.5% (26) | +1.7% (28) | +8.1% (31) | −2.9% (38) | +5.4% (19) | +2.1% (33) | −0.1% (36) | +0.6% (42) | +2.5% (35) |
| Consensus (2+ managers) | −2.2% (92) | +1.5% (136) | +3.9% (141) | −2.5% (122) | −3.9% (127) | +1.2% (123) | +2.3% (186) | −1.2% (220) | −1.2% (141) |

## What the lag costs

The same events entered at the first close after the quarter's end, which no one can trade on (the holdings aren't public yet), against entry after the filing. 60-day means, quarter level.

| Bucket | Quarter-end entry | Filing entry | Lost to the lag |
|---|---:|---:|---:|
| New position | +0.4% | +0.0% | +0.4% |
| Large add (shares +25%) | +0.1% | −0.0% | +0.1% |
| Best idea (largest position) | −1.0% | −1.1% | +0.1% |
| Top 3 | −0.5% | −0.6% | +0.1% |
| New in top 5 (5%+ of the book) | +2.2% | +1.8% | +0.4% |
| Consensus (2+ managers) | +0.8% | −0.1% | +0.9% |

## Named list (hindsight-biased: reported, never promoted)

Berkshire Hathaway and Pershing Square, every quarter, whatever the rule says.

| Bucket | Quarters | 20d | 60d | 60d quarters beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| New position | 30 | +1.6% ± 1.2% | +0.5% ± 1.7% | 53% | −1.6% ± 2.6% | +1.1% ± 5.0% |
| Large add (shares +25%) | 23 | −3.1% ± 2.1% | −3.0% ± 3.2% | 43% | −2.8% ± 3.5% | −5.8% ± 6.4% |
| Best idea (largest position) | 34 | −0.1% ± 0.8% | +2.1% ± 1.3% | 59% | +4.5% ± 1.9% | +9.6% ± 3.7% |
| Top 3 | 34 | −0.4% ± 0.4% | +0.3% ± 0.7% | 53% | +0.6% ± 0.9% | +1.6% ± 1.3% |
| New in top 5 (5%+ of the book) | 6 | −1.3% ± 2.8% | +0.5% ± 4.0% | 67% | +0.3% ± 8.1% | −10.9% ± 11.7% |

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| New position | 77 | +1.4% | −1.4% ± 1.4% | −0.6% | 48% | −2.4% | −1.1% |
| Large add (shares +25%) | 48 | −4.0% | −4.2% ± 2.4% | −1.9% | 46% | −4.5% | −4.9% |
| Best idea (largest position) | 68 | −0.1% | +2.1% ± 1.3% | +1.2% | 56% | +4.5% | +9.6% |
| Top 3 | 204 | −0.4% | +0.3% ± 0.7% | −0.3% | 49% | +0.6% | +1.6% |
| New in top 5 (5%+ of the book) | 7 | −1.4% | +1.7% ± 3.6% | +4.0% | 71% | +3.3% | −6.4% |
