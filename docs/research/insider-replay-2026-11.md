# The insider rule through Trader's own rules, 2019–2026

> Replay for [#57](https://github.com/whitebirchio/trader/issues/57) T8, run 2026-11-10. It extends the backtest in [insider-buys-vs-vti-2026-11.md](insider-buys-vs-vti-2026-11.md) from "did the signal beat VTI?" to "would Trader, running that signal under its real rules, have beaten VTI?". Method: [tasks/replay-plan.md](../../tasks/replay-plan.md). The full reports are in [insider-replay-2026-11/](insider-replay-2026-11/). The figures are a simulated $100,000 account, not Trader's.

## Bottom line

**Run as a mechanical rule under Trader's rules, the live strategy's insider pattern turned $100,000 into about $230,000 from 2019 to November 2026, while VTI turned it into about $318,000: +130.1% against +218.4%.**

1. **The theses lost money outright.** The 199 theses lost $7,391 in total, where the same dollars in VTI would have made $29,960. Only 36% of them beat VTI. Over 7.85 years the loss compounded, because money lost to a thesis was money that VTI didn't triple.
2. **The stop-loss closed half of them.** 102 of 199 theses (51%) closed through the 15% stop, after a median 33 days, at an average −17.5% (the stop is checked at the open, so a gap goes through it). The rest mostly did well: theses that reached their review date beat VTI by about 12 points on average, and about three in four of them beat it.
3. **The rule hit the drawdown halt 53 times:** five sessions in March 2020 and 48 from June to November 2022. With 40% of the account in recent fallers, it fell more than 30% below its peak in 2022, when VTI's worst fall was about 25%.
4. **A shorter review was the only change that came close to VTI.** Reviewing each thesis after 45 days instead of 90 lifted the result by 57 points, to +187.3%. Its 308 theses averaged +0.1% against VTI (±1.0%): no edge, but no longer a loss. Halving the thesis weight to 2.5% halved the gap. Stops at 10% were no better than 15%, and 25% was worse.

## Against the backtest

The backtest found the live pattern (2+ officers or directors buying after a 20%+ drop) at **+1.5% against VTI over 60 trading days, or −2.1% without 2020**, with half the events beating VTI. The replay's theses averaged **−2.6% ± 1.4% (−3.3% without 2020), with a median of −7.6%, and 36% beat VTI**, over an average of 60 days held. Four of Trader's rules account for the difference:

- **Caps: the rule couldn't hold 2020.** At most 8 theses at 5% each, chosen weekly by most buyers and dollars, left room for 20 theses in 2020. The backtest scored 301 live-pattern events that year, at +12.4% each, and they were its whole positive result. Without 2020 the two are close (−2.1% backtest, −3.3% replay), and the rest of the gap is the next three rules.
- **Stops: they closed what the backtest let recover.** The backtest held every event for a fixed 60 or 120 days. The replay sold half its theses at −15% or worse. Wider stops didn't help, though (see the variants): a stock that fell 15% after insiders bought kept falling on average, as the backtest's worse 120-day results suggested.
- **Staleness and the review date.** The rule resubmits every week, so nothing went stale (0 stale unwinds). Each thesis was unwound at its 90-day review date unless a stop came first. A stopped thesis's id can't be reused, so its slot stayed in VTI until the review date freed it.
- **Costs and timing.**
  - Each thesis was bought at the open of the week after its signal, not at the first close after the filing, so some of the rebound was already gone.
  - 10 bps of slippage on $6.57M traded came to about $6,600.
  - Purchases came to 1,951% of average equity: the account bought its whole value about 20 times over in under 8 years.
  - It realized $116,971 of short-term gains and $8,407 long-term, and triggered 545 wash sales (362 in theses, 183 in VTI). Taxes aren't modelled, so in a taxable account the result would be worse.

**Halving the cap shows the theses are the whole gap.** Halving the thesis weight halved the gap to VTI (88 points to 42). Extrapolated to no theses at all, the gap is about zero, so the machinery itself (fills at the open, cash waiting between a sell and the buy it funds, slippage) costs little.

## Every variant

Each variant reran the same seven years with one change to the rule. Only one variant beat the baseline by more than noise:

| Variant | Return | vs VTI, points | vs baseline | Theses | Thesis mean vs VTI | Beat VTI | Stops fired | Halts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Baseline** (5%, 15% stop, 90-day review) | +130.1% | −88.3 | | 199 | −2.6% | 36% | 102 | 53 |
| Stops at 10% | +132.1% | −86.3 | +2.0 | 199 | −2.7% | 28% | 128 | 9 |
| Stops at 25% | +95.7% | −122.7 | −34.4 | 191 | −3.5% | 41% | 62 | 345 |
| Review after 45 days | +187.3% | −31.1 | +57.2 | 308 | +0.1% | 45% | 95 | 12 |
| Weights capped at 2.5% | +176.3% | −42.1 | +46.2 | 199 | −2.2% | 37% | 101 | 6 |

- **Stops at 10%:** more stops (128) and a lower beat rate (28%), but losses cut earlier, so the thesis average barely moved (−2.7%). The small gain likely comes from avoiding most of 2022's halts (9 against 53).
- **Stops at 25%:** fewer stops, and the beat rate rose to 41%, but the losers fell further (theses −3.5% on average). The account then sat more than 30% below its peak from May 2022 to December 2023, and the halt froze trading on 345 sessions. The 34-point loss is partly that freeze, so this variant is the least reliable of the four.
- **Review after 45 days:** theses were held 37 days on average instead of 60, and slots were freed sooner, so the rule took 308 theses instead of 199. Per thesis it matched VTI (+0.1% ± 1.0%) and beat it 45% of the time. That agrees with the backtest: what rebound there is comes early.
- **Weights capped at 2.5%:** the same theses with nearly the same per-thesis result (−2.2%), on half the money, so half the damage. It also ran a calmer account (6 halts) and held VTI long enough to realize mostly long-term gains ($136,827 long-term, against $8,715 short-term).

## Every halt

A halt latches when flow-adjusted equity is 30% or more below its peak. The replay resumes it at the next session, as the owner would. As in production, resuming doesn't reset the peak, so an account still 30% down halts again at the next sync. While halted, risk refuses every order, stop-loss and review sells included: 544 orders were refused for the halt in the baseline.

**Baseline (53), by session:**

| Month | Sessions halted | Deepest |
|---|---|---:|
| 2020-03 | 18, 19, 20, 23, 24 | 33.7% |
| 2022-06 | 13, 14, 16, 17, 21, 22, 30 | 31.6% |
| 2022-07 | 1, 5, 11, 12, 13, 14, 15 | 31.3% |
| 2022-09 | 21, 22, 23, 26, 27, 28, 29, 30 | 34.0% |
| 2022-10 | 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 17, 18, 19, 20, 21, 24, 25, 26, 27, 28 | 36.0% |
| 2022-11 | 2, 3, 4, 7, 8, 9 | 32.6% |

**Variants, sessions halted by month:**

- **Stops at 10% (9):** 2020-03: 5, 2022-09: 1, 2022-10: 3.
- **Stops at 25% (345):**
  - 2020: March 9, April 3.
  - 2022: May 15, June 18, July 20, August 3, September 19, October 21, November 21, December 21.
  - 2023: January 20, February 14, March 23, April 19, May 22, June 19, July 2, August 10, September 19, October 22, November 21, December 4.
- **Review after 45 days (12):** 2020-03: 5, 2022-06: 7.
- **Weights capped at 2.5% (6):** 2020-03: 5, 2022-10: 1.

## What it means for Trader

- **It supports the 2026-11-08 directions.** A mechanical insider-dip rule loses to VTI under Trader's own rules, so insider buying should stay supporting evidence rather than a reason to buy, and theses led by it should stay small.
- **For Scott to decide:**
  - **A shorter review for insider-led theses.** The "about three months" review in get_rules could become about six weeks. That's the one change here that removed the loss. It's still not an edge, so it argues for keeping these theses small more than for holding more of them.
  - **Halts and protective sells.** A halt refuses stop-loss and review sells too, so a thesis that crosses its stop while the account is halted is held until a session runs unhalted. Allowing risk-reducing sells during a halt would mean changing risk's owner-set limits, so it's your call, and it's only worth considering if the live account could ever be 30% down.

## How far to trust it

- **It doesn't test Claude.** The theses are a mechanical rule: every week, the most-bought matches, up to 8. Claude's research, sizing and exits are what Trader actually runs, and this says only that the raw signal starts behind.
- **Survivorship, as in the backtest.** The rule draws on the backtest's scored events, which already leave out the 4,802 events with no Alpaca price history (and one more signal symbol here had none). Failures are overrepresented among them, so read every figure as a best case.
- **Delisted companies are assumed tradable.** 200 symbols that Alpaca no longer lists, or lists as inactive, were treated as active, tradable and fractionable while they had prices. An earlier run that read today's records refused 43 of the rule's theses for all seven years and left their money in cash: +115.6% instead of +130.1%. The figures above are from the corrected run.
- **Some theses were never held.** 12 of the rule's 211 theses never got a fill. PLT was Plantronics when insiders bought and is a leveraged ETF today, so risk refused it. MYO was refused for its price, liquidity and whole shares.
- **Daily bars only.** Every step sees the session's open, so stops trigger and orders fill at the open, and an intraday move through a stop that recovers by the next open goes unseen.
- **No dividends or corporate actions** beyond Alpaca's adjusted bars.
- **The halt auto-resumes.** Live, each resume is the owner's decision.

## Reproduce

```sh
npm run research:insiders -w @trader/core            # the backtest's events (.cache/insider-outcomes.json)
npm run replay -w @trader/core -- --rules insiders --from 2019-01-02 --to 2026-11-06
npm run replay -w @trader/core -- --rules insiders --from 2019-01-02 --to 2026-11-06 \
  --variant stop=10 --baseline-report .cache/replay/reports/rules-insiders-2019-01-02-2026-11-06-10bps.json
```

Each run takes about three hours (4.5 s a session). See [#89](https://github.com/whitebirchio/trader/issues/89) for why it's slow. The variants can run side by side with `--baseline-report`.
