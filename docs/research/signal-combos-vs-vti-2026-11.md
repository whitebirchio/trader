# Do signals that agree beat VTI? (signal combinations), 2019–2026

> Backtest for [#140](https://github.com/whitebirchio/trader/issues/140), run 2026-11-28 offline from the earlier studies' caches. Spec and plan: [tasks/signal-combos-spec.md](../../tasks/signal-combos-spec.md), [tasks/signal-combos-plan.md](../../tasks/signal-combos-plan.md). Every definition, test and bar was fixed before any result was seen. The summary is hand-written from the tables below, which `npm run research:combos -w @trader/core -- --report ../../docs/research/signal-combos-vs-vti-2026-11.md` regenerates.

## Bottom line

**No combination of signals beats VTI by the bar fixed in advance. None of the five tests passes.** Signals agreeing on a stock is also rare. There are hints that agreement helps and that a signal on its own hurts, but none comes close to the 3-standard-error bar, and some fade held out.

1. **The signal count (the headline) fails.**
   - **The slope:** it leans the right way, at +0.85 points of 60-day excess per additional agreeing signal in-sample and +2.78 held out. But that's 0.6 and 1.4 standard errors, against the 3 needed.
   - **Stocks with 2 or more other signals:** +1.5% ± 4.1% in-sample and +2.4% ± 5.2% held out, from only 83 events over eight years. 3 or more happened twice.
   - **A signal with nothing else agreeing trailed VTI** in both periods: −1.6% ± 0.9% in-sample, −2.7% ± 0.9% held out. With one other signal, stocks were about even (+0.2% and +1.5%).
2. **Two informed buyers fails.**
   - **The pair:** an insider cluster plus a 13F big new position or concentrated 13D/13G within 90 days.
   - **In-sample:** +9.7% over 60 days, but ± 11.0% over 22 months. It was carried by 2020: +58.4% on 11 events.
   - **Held out:** flat, at +0.1% ± 4.0%.
   - **Size:** 58 such events over eight years, too few and too noisy to lead anything.
3. **Insiders buying strength fails, though it beat insiders buying dips.**

   | Insider clusters | In-sample (60 days) | Held out |
   |---|---:|---:|
   | After strength (a positive earnings reaction, or above the 200-day average) | +1.5% ± 3.0% | +0.7% |
   | After a 20%+ drop | −5.5% ± 2.3% | −2.2% |
   | Neither | −1.9% | −3.2% |

   This confirms the insider study (#29): don't buy the dip on insider buying.
4. **Informed buying plus quality fails.**
   - **Top 30% by gross profitability:** +1.4% ± 2.5% in-sample, −0.7% held out.
   - **Known bottom 70%:** about flat.
   - **Events with no quality data:** mostly smaller companies, and the worst group (−2.3% and −2.9%).
5. **The warning screens help a little and pass nothing.**
   - **What changed:** dropping recent big losers and fresh earnings crashes nudged insider clusters (held out −1.4% → −0.3%) and 13F big new positions (−1.4% → −0.3%) up. It made earnings reactions and 13D/13G no better.
   - **The 13F big new position** is the strongest single signal in-sample (+4.9% screened), as in its own study. It still fails held out.

## What it means for Trader

- **No signal or combination earns a place as a lead at full size.** The routine's evidence rules stay as they are: two independent kinds of evidence, with insider, earnings and 13F/13D signals not trusted alone. The 2026-11-27 sizing direction (bigger bets on theses) stands on Scott's choice of risk, not on a tested edge. This study doesn't change that.
- **For the routine's judgment, not as a rule:**
  - **Agreement is weakly better than one signal alone,** and a signal with nothing behind it trailed VTI in both periods. That fits the two-kinds-of-evidence rule, but the effect is too small and too uncertain to size on.
  - **Insider buying after a 20%+ drop** was the worst group again: a third study saying the same.
- **Whether anything changes is Scott's call.** Nothing here supports a new owner's direction.

## Caveats

- **Few agreeing events.** Agreement among these signals is rare: 83 stocks with 2+ other signals, and 58 insider-plus-fund pairs, over eight years. The tests had little power to find a modest effect even if one exists. A null result here means "not shown", not "shown to be zero".
- **The universe is what Trader can buy today.** Risk's price and dollar-volume filters drop most small caps, where insider and activist signals are often studied. Companies that delisted are missing from the bars (survivorship), so read every figure as a best case.
- **Quality is known for about half the events.** Smaller companies often lack the SEC figures. Test 4 compares only known groups and reports the rest separately; in the signal count, missing quality means the signal isn't active.
- **Equal-weighted against cap-weighted.** As in the earlier studies, an average stock trailed VTI over these years because the largest companies led. Part of every negative figure is that.
- **Overlap.** Months are the cohorts, so the 60-day standard errors are honest. The 120- and 250-day windows overlap from month to month, so their standard errors are too small.
- **Checked:** six events spot-checked, each matching its source study's event file and an independent recomputation from the bars (entry date and 60-day excess to four decimals): an insider cluster, an earnings reaction, a 13F big new position, a concentrated 13D, and an insider-plus-fund pair. The 13D was also checked against its header on sec.gov.

<!-- generated by npm run research:combos: everything below is regenerated -->

**Data:** the earlier studies' caches, offline. Anchors from 2019-01-01 to 2026-10-31. **In-sample:** events before 2024-01-01; **held out:** from it. A month is one cohort: its events' mean counts once, so the standard error is across months.

**Promotion rule (fixed before any result, tasks/signal-combos-spec.md):** after a 0.2% round trip, the 60-day month-level excess over VTI is above zero in-sample at **3 standard errors or more** and above zero held out, and the in-sample 120-day mean doesn't reverse it. A group with fewer than 8 in-sample months is reported but not judged. The headline also needs the dose-response slope positive at 3 SE in-sample and positive held out.

## Verdicts

| Test | Judged group | Verdict |
|---|---|---|
| 1. Signal count | slope across the count, and the 2+ group | fails (slope fails; 2+ group: fails: in-sample 3 SE) |
| 2. Two informed buyers | insider cluster + 13F or 13D/13G | fails: held-out 60d, in-sample 3 SE |
| 3. Insiders buying strength | insider clusters after strength | fails: in-sample 3 SE, 120d reverses |
| 4. Informed buyer plus quality | top 30% by gross profitability | fails: held-out 60d, in-sample 3 SE, 120d reverses |
| 5. Insider cluster, screened | without recent big losers and fresh earnings crashes | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| 5. 13F big new position, screened | without recent big losers and fresh earnings crashes | fails: held-out 60d, in-sample 3 SE |
| 5. Positive earnings reaction, screened | without recent big losers and fresh earnings crashes | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| 5. Concentrated 13D/13G, screened | without recent big losers and fresh earnings crashes | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |

## 1. Signal count (the headline)

Each event signal is an anchor, counted by how many *other* signals were active on the stock then: events in the prior 90 days, momentum and quality as of their latest formation. One anchor per stock per 90 days.

**The dose-response slope** (each month's slope of group means against the count, averaged; SE across months):
- In-sample: +0.85% per additional signal ± 1.38% (60 months, 0.6 SE)
- Held out: +2.78% per additional signal ± 1.94% (32 months, 1.4 SE)

| Bucket | In-sample 60d (months) | Held-out 60d (months) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| 0 other signals | −1.6% ± 0.9% (60) | −2.7% ± 0.9% (32) | −2.6% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| 1 other signal | +0.2% ± 1.9% (60) | +1.5% ± 1.5% (32) | −1.1% | fails: in-sample 3 SE, 120d reverses |
| 2 other signals | +0.3% ± 4.0% (30) | +2.4% ± 5.2% (17) | −2.2% | fails: in-sample 3 SE, 120d reverses |
| 3+ other signals | +43.2% ± 32.2% (2) | – ± – (0) | +77.4% | fails: held-out 60d, in-sample 3 SE |
| 2+ other signals (judged) | +1.5% ± 4.1% (30) | +2.4% ± 5.2% (17) | +1.3% | fails: in-sample 3 SE |

By month:

| Bucket | Months | 20d | 60d | 60d months beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| 0 other signals | 92 | −0.3% ± 0.3% | −2.0% ± 0.6% | 32% | −2.9% ± 1.0% | −4.1% ± 1.6% |
| 1 other signal | 92 | −0.4% ± 0.6% | +0.7% ± 1.3% | 41% | +0.3% ± 2.0% | −1.6% ± 3.3% |
| 2 other signals | 47 | +1.0% ± 1.8% | +1.1% ± 3.1% | 47% | −2.5% ± 3.7% | −0.1% ± 9.1% |
| 3+ other signals | 2 | +6.8% ± 7.1% | +43.2% ± 32.2% | 100% | +77.4% ± 70.1% | +114.0% ± 101.0% |
| 2+ other signals (judged) | 47 | +1.0% ± 1.8% | +1.8% ± 3.2% | 49% | −0.3% ± 3.7% | +2.9% ± 8.9% |

By event:

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0 other signals | 9835 | −0.4% | −1.4% ± 0.2% | −2.5% | 44% | −2.6% | −3.0% |
| 1 other signal | 1876 | −0.4% | +0.6% ± 0.8% | −3.2% | 43% | −1.1% | +1.4% |
| 2 other signals | 81 | +1.1% | −0.8% ± 2.9% | −2.4% | 42% | −5.0% | −1.7% |
| 3+ other signals | 2 | +6.8% | +43.2% ± 32.2% | +43.2% | 100% | +77.4% | +114.0% |
| 2+ other signals (judged) | 83 | +1.2% | +0.3% ± 3.0% | −2.2% | 43% | −3.0% | +1.3% |

Year by year (60-day mean, events):

| Bucket | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 other signals | −2.9% (1062) | +5.6% (1174) | −6.2% (1112) | +0.0% (1318) | −3.4% (1249) | −2.5% (1387) | −0.6% (1577) | −1.9% (956) |
| 1 other signal | −1.4% (205) | +24.3% (205) | −11.0% (218) | −3.6% (239) | −3.5% (228) | +2.9% (284) | +0.0% (318) | −1.7% (179) |
| 2 other signals | +1.3% (9) | −2.5% (12) | −7.4% (10) | +2.5% (7) | +3.4% (7) | −1.8% (14) | +2.3% (20) | −15.8% (2) |
| 3+ other signals | – | +75.4% (1) | – | – | +11.1% (1) | – | – | – |
| 2+ other signals (judged) | +1.3% (9) | +3.5% (13) | −7.4% (10) | +2.5% (7) | +4.4% (8) | −1.8% (14) | +2.3% (20) | −15.8% (2) |

## 2. Two informed buyers

An insider cluster and a 13F big new position or a concentrated 13D/13G on the same stock within 90 days, entered when the second became public: 59 pairs before tradability. Compared with each signal on its own (all its events, paired or not).

| Bucket | In-sample 60d (months) | Held-out 60d (months) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| Insider cluster + 13F or 13D/13G (judged) | +9.7% ± 11.0% (22) | +0.1% ± 4.0% (16) | +16.9% | fails: held-out 60d, in-sample 3 SE |
| Insider cluster, all events | −1.9% ± 1.2% (60) | −1.4% ± 1.3% (30) | −4.6% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| 13F big new position, all events | +4.5% ± 2.0% (26) | −1.4% ± 1.7% (18) | +2.8% | fails: held-out 60d, in-sample 3 SE |
| Concentrated 13D/13G, all events | −2.0% ± 2.7% (47) | −0.7% ± 2.7% (31) | −9.1% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |

By month:

| Bucket | Months | 20d | 60d | 60d months beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| Insider cluster + 13F or 13D/13G (judged) | 38 | +1.0% ± 2.3% | +5.6% ± 6.5% | 39% | +8.4% ± 12.0% | +10.9% ± 16.8% |
| Insider cluster, all events | 90 | −0.7% ± 0.4% | −1.7% ± 0.9% | 34% | −4.4% ± 1.5% | −4.8% ± 3.0% |
| 13F big new position, all events | 44 | +1.1% ± 0.9% | +2.1% ± 1.4% | 57% | +1.8% ± 2.1% | −2.7% ± 3.3% |
| Concentrated 13D/13G, all events | 78 | +0.6% ± 1.2% | −1.5% ± 1.9% | 41% | −6.8% ± 2.9% | −15.1% ± 3.9% |

By event:

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| Insider cluster + 13F or 13D/13G (judged) | 58 | +1.5% | +8.1% ± 7.8% | −4.3% | 41% | +12.9% | +16.1% |
| Insider cluster, all events | 2905 | −0.8% | −0.7% ± 0.5% | −2.5% | 44% | −2.7% | +0.5% |
| 13F big new position, all events | 250 | +1.3% | +1.8% ± 1.2% | +0.7% | 53% | +1.4% | −1.7% |
| Concentrated 13D/13G, all events | 330 | −0.4% | −2.5% ± 1.5% | −4.1% | 44% | −7.6% | −14.1% |

Year by year (60-day mean, events):

| Bucket | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Insider cluster + 13F or 13D/13G (judged) | −11.5% (9) | +58.4% (11) | −21.5% (3) | −7.9% (5) | −2.1% (8) | +11.2% (7) | −1.9% (8) | −1.5% (7) |
| Insider cluster, all events | −2.9% (378) | +10.3% (510) | −7.0% (369) | −0.1% (400) | −5.1% (330) | −2.5% (275) | −1.0% (405) | −3.5% (238) |
| 13F big new position, all events | +1.8% (27) | +8.6% (30) | −3.2% (37) | +5.4% (19) | +2.3% (32) | −1.1% (34) | −0.1% (38) | +3.5% (33) |
| Concentrated 13D/13G, all events | −4.0% (53) | +6.1% (39) | −6.2% (33) | −7.6% (39) | −4.4% (25) | +2.1% (38) | −3.3% (64) | −2.7% (39) |

## 3. Insiders buying strength, not dips

Insider clusters split by what came just before: a 20%+ drop in the prior 60 sessions (the dip), else a positive earnings reaction within 90 days or a close above the 200-day average (strength), else neither. The groups don't overlap.

| Bucket | In-sample 60d (months) | Held-out 60d (months) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| After strength (judged) | +1.5% ± 3.0% (60) | +0.7% ± 2.1% (30) | +0.1% | fails: in-sample 3 SE, 120d reverses |
| After a 20%+ drop (the dip) | −5.5% ± 2.3% (54) | −2.2% ± 2.5% (28) | −8.4% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| Neither | −1.9% ± 1.7% (60) | −3.2% ± 1.6% (30) | −5.2% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |

By month:

| Bucket | Months | 20d | 60d | 60d months beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| After strength (judged) | 90 | −1.2% ± 0.8% | +1.2% ± 2.1% | 48% | +0.4% ± 2.3% | +0.4% ± 4.4% |
| After a 20%+ drop (the dip) | 82 | −1.7% ± 1.0% | −4.3% ± 1.8% | 39% | −9.1% ± 2.9% | −13.1% ± 5.7% |
| Neither | 90 | −0.6% ± 0.5% | −2.3% ± 1.3% | 37% | −5.8% ± 1.7% | −7.7% ± 3.1% |

By event:

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| After strength (judged) | 882 | −0.6% | −0.7% ± 1.0% | −2.3% | 44% | −0.5% | −4.2% |
| After a 20%+ drop (the dip) | 987 | −1.3% | +1.0% ± 1.0% | −1.9% | 47% | −2.6% | +13.1% |
| Neither | 1036 | −0.5% | −2.3% ± 0.7% | −3.3% | 42% | −4.5% | −7.7% |

Year by year (60-day mean, events):

| Bucket | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| After strength (judged) | −3.2% (105) | +5.7% (103) | −3.9% (163) | +1.6% (96) | −3.7% (84) | −1.5% (125) | +5.8% (124) | −7.3% (82) |
| After a 20%+ drop (the dip) | −1.2% (107) | +15.1% (277) | −16.0% (85) | −1.1% (140) | −6.2% (114) | −1.5% (58) | −6.4% (133) | +0.9% (73) |
| Neither | −3.8% (166) | +3.7% (130) | −4.8% (121) | −0.3% (164) | −5.2% (132) | −4.4% (92) | −1.8% (148) | −3.7% (83) |

## 4. Informed buyer plus quality

An insider cluster, 13F big new position or concentrated 13D/13G, by the stock's gross-profitability percentile at the latest April formation. The comparison is with stocks known to be in the bottom 70%; events with no quality data (smaller companies without the SEC figures, and January–April 2019) are their own row.

| Bucket | In-sample 60d (months) | Held-out 60d (months) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| Top 30% by gross profitability (judged) | +1.4% ± 2.5% (45) | −0.7% ± 2.8% (32) | −0.4% | fails: held-out 60d, in-sample 3 SE, 120d reverses |
| Bottom 70% | −0.0% ± 1.7% (55) | −1.1% ± 1.2% (31) | −0.1% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| No quality data | −2.3% ± 1.2% (60) | −2.9% ± 1.4% (32) | −5.5% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |

By month:

| Bucket | Months | 20d | 60d | 60d months beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| Top 30% by gross profitability (judged) | 77 | −1.3% ± 0.9% | +0.5% ± 1.8% | 45% | −2.6% ± 2.4% | −7.3% ± 5.1% |
| Bottom 70% | 86 | +0.4% ± 0.5% | −0.4% ± 1.2% | 48% | −1.3% ± 2.2% | −0.1% ± 3.3% |
| No quality data | 92 | −0.9% ± 0.5% | −2.5% ± 0.9% | 30% | −5.2% ± 1.4% | −6.7% ± 2.9% |

By event:

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| Top 30% by gross profitability (judged) | 318 | −0.6% | +1.5% ± 1.5% | +0.8% | 51% | −0.4% | +2.0% |
| Bottom 70% | 882 | +0.2% | +0.2% ± 0.8% | −1.7% | 46% | −0.8% | +2.7% |
| No quality data | 2225 | −1.0% | −1.7% ± 0.6% | −2.9% | 43% | −4.4% | −3.2% |

Year by year (60-day mean, events):

| Bucket | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Top 30% by gross profitability (judged) | +0.9% (28) | +24.9% (35) | −7.6% (25) | +1.7% (47) | −4.0% (39) | +0.5% (36) | −1.5% (68) | −1.8% (40) |
| Bottom 70% | +0.7% (92) | +10.2% (124) | −1.1% (92) | +1.9% (114) | −6.0% (106) | −1.2% (106) | −2.6% (150) | −1.7% (98) |
| No quality data | −4.0% (330) | +7.2% (410) | −8.2% (318) | −1.7% (291) | −4.0% (234) | −3.1% (199) | −0.3% (279) | −4.1% (164) |

## 5. Every signal with the warning screens applied

Each event signal again, without recent big losers (a 12-1 month return of −30% or worse) and fresh earnings crashes (−10% or worse vs VTI within the last 10 sessions), next to the unscreened version.

| Bucket | In-sample 60d (months) | Held-out 60d (months) | In-sample 120d | Verdict |
|---|---:|---:|---:|---|
| Insider cluster, screened (judged) | −1.4% ± 1.4% (60) | −0.3% ± 1.5% (30) | −3.7% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| Insider cluster, all | −1.9% ± 1.2% (60) | −1.4% ± 1.3% (30) | −4.6% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| 13F big new position, screened (judged) | +4.9% ± 2.0% (25) | −0.3% ± 1.9% (18) | +5.4% | fails: held-out 60d, in-sample 3 SE |
| 13F big new position, all | +4.5% ± 2.0% (26) | −1.4% ± 1.7% (18) | +2.8% | fails: held-out 60d, in-sample 3 SE |
| Positive earnings reaction, screened (judged) | −1.3% ± 1.0% (60) | −1.4% ± 0.8% (30) | −2.3% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| Positive earnings reaction, all | −0.8% ± 1.1% (60) | −2.1% ± 0.8% (31) | −1.6% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| Concentrated 13D/13G, screened (judged) | −1.0% ± 2.8% (41) | −1.7% ± 2.5% (29) | −7.5% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |
| Concentrated 13D/13G, all | −2.0% ± 2.7% (47) | −0.7% ± 2.7% (31) | −9.1% | fails: in-sample 60d, held-out 60d, in-sample 3 SE, 120d reverses |

By month:

| Bucket | Months | 20d | 60d | 60d months beat VTI | 120d | 250d |
|---|---:|---:|---:|---:|---:|---:|
| Insider cluster, screened (judged) | 90 | −0.5% ± 0.5% | −1.0% ± 1.0% | 41% | −3.1% ± 1.5% | −4.5% ± 2.6% |
| Insider cluster, all | 90 | −0.7% ± 0.4% | −1.7% ± 0.9% | 34% | −4.4% ± 1.5% | −4.8% ± 3.0% |
| 13F big new position, screened (judged) | 43 | +0.8% ± 0.9% | +2.7% ± 1.5% | 63% | +4.2% ± 2.1% | −1.1% ± 3.0% |
| 13F big new position, all | 44 | +1.1% ± 0.9% | +2.1% ± 1.4% | 57% | +1.8% ± 2.1% | −2.7% ± 3.3% |
| Positive earnings reaction, screened (judged) | 90 | −0.5% ± 0.3% | −1.3% ± 0.7% | 33% | −2.2% ± 0.9% | −2.3% ± 2.0% |
| Positive earnings reaction, all | 91 | −0.4% ± 0.4% | −1.3% ± 0.8% | 37% | −2.0% ± 1.0% | −0.8% ± 2.5% |
| Concentrated 13D/13G, screened (judged) | 70 | +0.3% ± 1.1% | −1.3% ± 1.9% | 46% | −6.9% ± 2.5% | −16.7% ± 4.2% |
| Concentrated 13D/13G, all | 78 | +0.6% ± 1.2% | −1.5% ± 1.9% | 41% | −6.8% ± 2.9% | −15.1% ± 3.9% |

By event:

| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| Insider cluster, screened (judged) | 2134 | −0.6% | +0.1% ± 0.6% | −2.1% | 44% | −1.6% | +2.2% |
| Insider cluster, all | 2905 | −0.8% | −0.7% ± 0.5% | −2.5% | 44% | −2.7% | +0.5% |
| 13F big new position, screened (judged) | 218 | +1.2% | +2.8% ± 1.3% | +0.9% | 55% | +3.3% | −1.3% |
| 13F big new position, all | 250 | +1.3% | +1.8% ± 1.2% | +0.7% | 53% | +1.4% | −1.7% |
| Positive earnings reaction, screened (judged) | 7579 | −0.4% | −1.1% ± 0.3% | −2.6% | 43% | −2.0% | −2.7% |
| Positive earnings reaction, all | 9124 | −0.3% | −1.0% ± 0.3% | −2.6% | 44% | −2.0% | −2.2% |
| Concentrated 13D/13G, screened (judged) | 246 | −0.1% | −1.7% ± 1.7% | −3.8% | 44% | −6.6% | −12.7% |
| Concentrated 13D/13G, all | 330 | −0.4% | −2.5% ± 1.5% | −4.1% | 44% | −7.6% | −14.1% |

Year by year (60-day mean, events):

| Bucket | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Insider cluster, screened (judged) | −1.1% (272) | +9.7% (407) | −6.4% (318) | +0.2% (258) | −3.9% (233) | −0.3% (199) | +0.6% (278) | −3.5% (169) |
| Insider cluster, all | −2.9% (378) | +10.3% (510) | −7.0% (369) | −0.1% (400) | −5.1% (330) | −2.5% (275) | −1.0% (405) | −3.5% (238) |
| 13F big new position, screened (judged) | +0.7% (22) | +7.9% (28) | −0.9% (35) | +7.0% (14) | +3.5% (27) | +1.2% (30) | +1.1% (33) | +4.9% (29) |
| 13F big new position, all | +1.8% (27) | +8.6% (30) | −3.2% (37) | +5.4% (19) | +2.3% (32) | −1.1% (34) | −0.1% (38) | +3.5% (33) |
| Positive earnings reaction, screened (judged) | −2.3% (766) | +6.4% (720) | −7.0% (929) | +0.4% (808) | −2.9% (973) | −0.7% (1275) | +0.1% (1307) | −1.9% (801) |
| Positive earnings reaction, all | −2.5% (902) | +8.4% (930) | −7.3% (967) | −0.4% (1222) | −3.0% (1198) | −1.4% (1436) | +0.1% (1545) | −1.6% (924) |
| Concentrated 13D/13G, screened (judged) | −1.2% (36) | +4.9% (34) | −7.1% (29) | −8.0% (27) | +1.0% (16) | +3.3% (28) | −2.7% (48) | −3.5% (28) |
| Concentrated 13D/13G, all | −4.0% (53) | +6.1% (39) | −6.2% (33) | −7.6% (39) | −4.4% (25) | +2.1% (38) | −3.3% (64) | −2.7% (39) |
