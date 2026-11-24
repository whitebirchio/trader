# 13D and 13G stakes vs VTI, 2018–2026

> Backtest for [#138](https://github.com/whitebirchio/trader/issues/138) Part 2, run 2026-11-23 from EDGAR's daily indexes (January 2018 to October 2026), the filings' cover pages and Alpaca's adjusted daily bars. Method: [tasks/13f-backtest-plan.md](../../tasks/13f-backtest-plan.md). The summary is hand-written from the tables below, which `npm run research:13d -w @trader/core -- --report ../../docs/research/13d-13g-stakes-vs-vti-2026-11.md` regenerates.

## Bottom line

**An investment manager's new 5% stake has not beaten VTI in the stocks Trader can buy, whether the filing is active (13D) or passive (13G), and whether or not the manager is a concentrated one. No bucket passes the promotion rule. Most of them trailed VTI, and the 13Ds trailed it badly over 6–12 months.**

1. **A concentrated manager's 13D pops, then fades.**
   - 107 filings, about 12 a year.
   - Over 20 days it was +2.2% ± 1.4% by month (+2.4% by filing). That's under 2 standard errors, and it wasn't tested for promotion: the rule is set at 60 days.
   - Over 60 days it was flat (+0.1% ± 2.3%). Over 120 days it was −8.3% ± 3.5%, and over a year −14.9%.
   - In-sample 60 days was +0.9% ± 2.9% (43 months); held out, −1.9% ± 3.8% (18 months).
2. **Other managers' 13Ds lost.** 358 filings: −3.0% ± 1.8% over 60 days by month, −8.2% over 120, −11.8% over a year. Held out (2024–2026) it was worse, at −6.0% over 60 days.
3. **A concentrated manager's 13G was flat.** 287 filings: +0.6% ± 2.5% over 60 days, then −3.6% over 120 days and −8.4% over a year. It was the only bucket positive held out (+1.4% ± 3.3%), but it failed in-sample.
4. **Everyone else's 13G trailed VTI slightly.** This is nearly every filing (16,877: index funds, banks and large asset managers crossing 5%). It was −1.5% ± 1.0% over 60 days by month and −3.4% over a year. That's about what an average stock did against cap-weighted VTI over these years, so it's a base rate, not a signal.
5. **The breakdowns are descriptive and none of them rescues the signal:**
   - **A bigger stake didn't help.** 13Ds at 10%+ did worse than 5–10% (−3.2% vs −2.1% over 60 days). 13Gs at 10%+ were −4.8%.
   - **Buying after a fall didn't help either.** A 13G after a 20%+ drop in the prior 60 days lost 7.3% ± 0.7% over the next 60 (1,973 filings), against −1.5% without one. That's the momentum study's finding again: the weakest stocks kept losing.
   - **Passive turned active was the one bright spot, and it's tiny.** A 13D whose filer had already reported the stake on a 13G was −0.9% over 60 days but +0.3% over a year, against −14.4% for other 13Ds. There were only 41 such filings.
6. **The faster deadline didn't change much.** 13Ds came a median 9 days after the event before February 5, 2024 and 7 days after. The held-out 13Ds were no better than the in-sample ones.

## What it means for Trader

- **A 13D or 13G is not a reason to buy on its own.** This is the third filing-based signal to fail, after insider buying ([insider-buys-vs-vti-2026-11.md](insider-buys-vs-vti-2026-11.md)) and 13F holdings ([13f-best-ideas-vs-vti-2026-11.md](13f-best-ideas-vs-vti-2026-11.md)). An earlier filing didn't carry a signal that the 13F's lag had hidden.
- **The activist pop is real but short and gives back more.** A concentrated manager's 13D was up about 2% after 20 days, then down 8% after 120. A thesis that buys on a 13D and holds for the routine's usual review window (up to about 90 days) would, on average, have given up the pop. If it's cited at all, it's evidence for a short hold with a near review date, not a long one.
- **Read a fresh 13D on a name Trader holds as a risk, not a reassurance.** Across all managers, 13D targets trailed VTI by about 8 points over 120 days.
- **For the routine prompt (T10), to decide with Scott:**
  - Treat a 13D or 13G as **supporting evidence at most**, never a lead, unlike the 13F's "big new position", which can lead at 5–10%. The alternative is to treat it the same as the 13F (a lead at 5–10% with a second independent kind), but nothing here supports that.
  - Say that the activist pop fades: a 13D-led idea needs its own reason the market is wrong, and a review date within about 30 days rather than 90.
  - The passive-turned-active case is too small to act on: 41 filings.
- **For the signal-combination study ([#140](https://github.com/whitebirchio/trader/issues/140)):** the events file gives every scored 13D and 13G with its date, ticker and stake, ready to join with insider buys, 13F positions and earnings reactions.

## Caveats

- **Most activist targets are untradable.** Of 2,480 initial 13Ds by managers, 465 were scored. The rest were below risk's price or dollar-volume floor at the time, unmapped or delisted. This test is only about the stocks Trader could buy, which is the question, but it isn't a verdict on activism in small caps.
- **Small buckets.** The concentrated buckets have 107 and 287 filings. Year by year they swing between −10% and +17%, so a single year can carry a bucket.
- **Equal-weighted against cap-weighted.** As in Part 1, an average stock trailed VTI over 2018–2026 because the largest companies led. Part of every negative figure is that, not the filers.
- **Vanguard's 2026 refilings.** Vanguard moved its holdings into two new entities in 2026, which filed about 2,100 initial 13Gs on stakes Vanguard already held. They're re-registrations, not new stakes, and they sit in "13G, other manager" held out. Without them that bucket's held-out 60-day mean by filing is −1.4% instead of −0.2%. No verdict changes.
- **Who counts as concentrated.**
  - Part 1 collapsed related filers, so a 13D filed under a group's other CIK can be counted as not concentrated.
  - The rule was fixed before any results and isn't tuned here.
- **Stake size** is read from the cover. It's structured from December 2024, parsed from the text before that, and not fetched for non-concentrated 13Gs on listed companies before December 2024 (shown as "stake unknown").
- **The company side is matched by name.** A filer in the company's own group (a bank's stake in itself, say) is dropped by a heuristic on the first two words of their names (124 filings).
- **Survivorship.** 6,509 filings were in companies that couldn't be mapped to a ticker, mostly delisted or merged. Takeover targets pay a premium, so the gap could cut either way.
- **Entry** is the first close after the filing date, not a fill. Spreads and taxes aren't modelled (the promotion rule charges a 0.2% round trip). The 120- and 250-day windows overlap from month to month, so their standard errors are too small.

<!-- generated by npm run research:13d: everything below is regenerated -->

**Data:** EDGAR's daily indexes, 2018-01 to 2026-10: 269,913 Schedule 13D and 13G filings, 78,083 of them initial (amendments, not scored: 37,526 13D, 154,304 13G). **Kept** 51,248 initial filings by investment managers (a filer that also files 13Fs). **Dropped:** 26,498 no 13F filer, 205 the company on itself, 124 filer in the company's group, 8 parties unclear.

**Concentrated** means a filer was in Part 1's concentrated-manager set (30 or fewer positions, $1B or more, 4+ prior filings, low turnover) for the latest quarter whose 13Fs were due by the filing date: 731 of the kept filings. Related filers were collapsed in Part 1, so a filing under a group's other CIK can be counted as not concentrated.

**Scored:** 18,340 filings. **Left out:** 6,509 unmapped, 22,382 untradable, 1,935 no bars, 297 no entry, 1,776 fund or ETF, 9 stale bars. Companies were mapped to tickers by SEC's company_tickers.json (34,007), or by the cover's CUSIP through OpenFIGI (2,449) or SEC's fails-to-deliver data (8,283); 6,509 stayed unmapped (mostly delisted or merged companies: the survivorship gap).

Excess return = the stock's return minus VTI's over the same trading days, from the first close after the filing date. In-sample: filings before 2024-01-01; held out: from it (after the 13D deadline change, so partly a new regime). A month is one cohort: its filings' mean counts once, so the standard error is across months. 120- and 250-day windows overlap from one month to the next, so their standard errors understate the uncertainty.

## Promotion rule

Fixed before any results: after a 0.2% round trip, the 60-day month-level mean beats VTI in-sample and held out, the in-sample mean is at least 2 standard errors above zero, and the in-sample 120-day mean doesn't reverse it. Only these four buckets are scored.

| Bucket | In-sample 60d (months) | Held-out 60d (months) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| 13D, concentrated manager | +0.9% ± 2.9% (43) | −1.9% ± 3.8% (18) | −9.0% | fails: held-out 60d, in-sample 2 SE, 120d reverses |
| 13D, other manager | −1.7% ± 2.1% (67) | −6.0% ± 3.1% (31) | −8.7% | fails: in-sample 60d, held-out 60d, in-sample 2 SE, 120d reverses |
| 13G, concentrated manager | +0.1% ± 3.6% (42) | +1.4% ± 3.3% (28) | −4.8% | fails: in-sample 60d, in-sample 2 SE, 120d reverses |
| 13G, other manager | −1.4% ± 1.3% (72) | −1.7% ± 1.7% (32) | −2.5% | fails: in-sample 60d, held-out 60d, in-sample 2 SE, 120d reverses |

**No bucket passes.**

## By month

| Bucket | Months | 20d | 60d | 60d months beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| 13D, concentrated manager | 61 | +2.2% ± 1.4% | +0.1% ± 2.3% | 49% | −8.3% ± 3.5% | −14.9% ± 4.0% |
| 13D, other manager | 98 | −0.1% ± 0.9% | −3.0% ± 1.8% | 38% | −8.2% ± 2.3% | −11.8% ± 3.9% |
| 13G, concentrated manager | 70 | +0.1% ± 1.3% | +0.6% ± 2.5% | 43% | −3.6% ± 3.4% | −8.4% ± 5.8% |
| 13G, other manager | 104 | −0.7% ± 0.5% | −1.5% ± 1.0% | 39% | −1.8% ± 1.7% | −3.4% ± 2.7% |

## By filing

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| 13D, concentrated manager | 107 | +2.4% | −0.5% ± 2.1% | +1.6% | 54% | −10.6% | −16.4% |
| 13D, other manager | 358 | −0.2% | −2.7% ± 1.3% | −3.6% | 41% | −7.2% | −12.4% |
| 13G, concentrated manager | 287 | −0.7% | −1.4% ± 1.7% | −4.2% | 45% | −4.8% | −10.2% |
| 13G, other manager | 16877 | −1.1% | −2.3% ± 0.2% | −2.9% | 44% | −3.3% | −3.6% |

### In-sample and held out (by filing)

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| 13D, concentrated manager, in-sample | 74 | +2.5% | −0.7% ± 2.6% | +2.2% | 58% | −13.4% | −16.2% |
| 13D, other manager, in-sample | 269 | +0.5% | −1.8% ± 1.5% | −2.8% | 43% | −8.0% | −13.8% |
| 13G, concentrated manager, in-sample | 169 | +0.3% | −1.4% ± 2.0% | −0.7% | 48% | −4.9% | −7.8% |
| 13G, other manager, in-sample | 8920 | −1.3% | −4.2% ± 0.3% | −4.0% | 42% | −4.5% | −4.9% |
| 13D, concentrated manager, held out | 33 | +2.1% | +0.1% ± 3.6% | −3.8% | 45% | −3.7% | −17.1% |
| 13D, other manager, held out | 89 | −2.2% | −5.5% ± 2.4% | −5.6% | 37% | −4.9% | −7.1% |
| 13G, concentrated manager, held out | 118 | −2.2% | −1.3% ± 2.9% | −7.2% | 40% | −4.7% | −15.9% |
| 13G, other manager, held out | 7957 | −0.9% | −0.2% ± 0.3% | −1.6% | 46% | −1.7% | −0.5% |

### Year by year (60-day mean, filings)

| Bucket | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 13D, concentrated manager | +2.4% (15) | −9.8% (16) | +17.0% (11) | −4.9% (11) | +0.1% (12) | −7.4% (9) | −1.1% (10) | +3.0% (18) | −7.9% (5) |
| 13D, other manager | +3.1% (47) | −8.0% (47) | +6.5% (44) | −5.8% (57) | −1.2% (43) | −4.9% (31) | −2.2% (35) | −1.6% (37) | −20.9% (17) |
| 13G, concentrated manager | +9.6% (29) | −1.2% (39) | +0.2% (32) | −6.4% (24) | −9.9% (29) | −2.7% (16) | +6.2% (31) | −5.8% (49) | −1.6% (38) |
| 13G, other manager | +2.1% (1341) | −1.6% (1264) | −1.5% (1436) | −8.4% (2001) | −6.1% (1583) | −7.4% (1295) | −2.9% (2015) | +0.1% (2091) | +1.1% (3851) |

## Breakdowns (descriptive, not promoted)

Stake size from the cover page: structured from Dec 2024, read from the text cover before that (unknown where the cover wasn't fetched or couldn't be read).

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| 13D, stake 5–10% | 296 | +0.9% | −2.1% ± 1.3% | −3.7% | 44% | −7.5% | −12.5% |
| 13D, stake 10%+ | 129 | −1.0% | −3.2% ± 2.4% | −2.1% | 44% | −11.4% | −14.9% |
| 13D, stake unknown | 40 | +0.6% | +0.5% ± 3.3% | −0.1% | 50% | −1.4% | −14.2% |
| 13G, stake 5–10% | 6953 | −1.1% | +0.1% ± 0.3% | −1.2% | 47% | −1.4% | +0.5% |
| 13G, stake 10%+ | 308 | −3.9% | −4.8% ± 2.0% | −6.1% | 38% | −3.5% | −14.1% |
| 13G, stake unknown | 9903 | −1.0% | −3.9% ± 0.3% | −3.9% | 42% | −4.4% | −4.6% |

The 60 trading days before entry:

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| 13D, after a 20%+ drop | 75 | +1.1% | −4.1% ± 2.8% | −6.6% | 40% | −10.1% | −14.6% |
| 13D, no such drop | 388 | +0.2% | −1.9% ± 1.2% | −2.1% | 45% | −7.6% | −13.0% |
| 13G, after a 20%+ drop | 1973 | −2.5% | −7.3% ± 0.7% | −9.9% | 36% | −4.0% | −6.8% |
| 13G, no such drop | 14930 | −0.9% | −1.5% ± 0.2% | −2.2% | 45% | −3.0% | −3.3% |

A 13D whose filer had reported the same stake on a 13G (the cover's box):

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| 13D after the filer's 13G (passive turned active) | 41 | +2.7% | −0.9% ± 3.9% | −2.1% | 49% | −0.6% | +0.3% |
| Other 13Ds | 424 | +0.1% | −2.3% ± 1.2% | −2.5% | 44% | −8.7% | −14.4% |

## Filing lag

Days from the event that requires the filing (the cover's date) to the filing. A 13D was due within 10 days before Feb 5, 2024 and 5 business days from it. An investment manager's 13G is often due 45 days after the quarter in which it crossed, so its lag is long by design.

| Form | Filed | Filings | With an event date | Median days |
|---|---|---:|---:|---:|
| 13D | before 2024-02-05 | 1,897 | 1,697 | 9 |
| 13D | from 2024-02-05 | 583 | 556 | 7 |
| 13G | before 2024-02-05 | 30,346 | 8,860 | 37 |
| 13G | from 2024-02-05 | 18,422 | 14,258 | 35 |
