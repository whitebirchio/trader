# A trailing stop and a profit target, replayed, 2019–2026

> Replay for [#35](https://github.com/whitebirchio/trader/issues/35) (exits plan T6), run 2026-11-10. Same rule, data and method as [insider-replay-2026-11.md](insider-replay-2026-11.md): the live strategy's insider pattern as a weekly rule, through Trader's real jobs, on a simulated $100,000 account. The full reports are in [thesis-exits-replay-2026-11/](thesis-exits-replay-2026-11/). The figures are not Trader's.

## Bottom line

**Neither exit improved the result. Every trailing stop and profit target tried lost 2 to 13 points against the baseline, so neither should be switched on.**

| Variant | Return | vs baseline, points | Thesis mean vs VTI | Beat VTI | Exits by the new rule |
|---|---:|---:|---:|---:|---:|
| **Baseline** (15% stop, 90-day review) | +139.7% | | −2.2% | 37% | |
| Trailing stop 10% | +138.0% | −1.7 | −2.2% | 33% | 169 |
| Trailing stop 15% | +127.1% | −12.6 | −2.5% | 32% | 119 |
| Trailing stop 25% | +131.0% | −8.7 | −2.5% | 37% | 17 |
| Profit target 20% | +134.8% | −4.9 | −1.5% | 45% | 71 |
| Profit target 40% | +130.4% | −9.2 | −1.8% | 38% | 25 |
| Trailing 15% + target 40% | +127.9% | −11.8 | −2.1% | 32% | 107 + 19 |

VTI returned +218.4% over the same period.

## Why they don't help

**The rule's theses pay for themselves through a few big winners.** In the baseline, half the theses hit their 15% stop at about −17%. The ones that reached their review date beat VTI by about 11 points on average, and three in four beat it. That right tail is all the rule has, and both new exits cut into it:

- **A trailing stop sells winners on a pullback.** At 10%, it closed 169 of 199 theses, after 28 days on average and slightly behind VTI (−1.7%). Only 12 theses survived to their review date, against 98 in the baseline. It did replace most of the stop-loss sales (18 against 101) with smaller losses, but it gave up nearly as much on the theses that would have kept rising. At 15% and 25% it fired less but still caught winners, and the account did worse.
- **A profit target caps the winners.** At 20%, 71 theses took profit, each about 17.5 points ahead of VTI. The theses left to reach their review date then did no better than VTI, because the target had already sold the strong ones. Per thesis it was the best variant (−1.5%, and 45% beat VTI), but the account did worse: the big winners were sold early, and the money waited in VTI until the slot freed. At 40%, only 25 theses reached the target, and the rest of the tail was still cut.
- **Combined, the two add up to the worse of each** (−11.8 points).

These match the earlier studies. Whatever rebound follows insider buying comes early and fades, so the review date (45 days was the one change that helped, in [insider-replay-2026-11.md](insider-replay-2026-11.md)) does more than any price rule.

## A new baseline: what ADR-017 changed

The halt changes merged today (ADR-017) are in production code, so the replay now uses them. The baseline is rerun here rather than compared with the insider write-up's figures:

| | Before ADR-017 | After |
|---|---:|---:|
| Return | +130.1% | **+139.7%** |
| Halts | 53 | **4** |
| Thesis mean vs VTI | −2.6% | −2.2% |

There are two reasons for the 9.6-point improvement:
- **Closed theses sold during halts.** Before, a thesis through its stop during a halt was held until a session ran unhalted.
- **Resumes held.** The four halts were March 2020 (31% below the peak), June 2022 (30%), then September 2022 and October 2023. Those last two were the 15% re-halt after a resume, at 16% and 15% below the level then. Before ADR-017 the account halted again at nearly every sync from June to November 2022.

## What it means for Trader

- **Keep both switches off** (`EXIT_RULES` in `strategy.ts`). The code stays, tested, and a replay can try other settings later.
- **What does help is in the instructions, not a price rule:** re-judge every thesis each run and sell on signals, with a six-week review for insider-led theses. That's what the 2026-11-10 direction already asks.
- **The halt changes paid off in the replay.** That's a check on ADR-017, not a reason for it: Scott decided those on their merits.

## How far to trust it

The caveats in [insider-replay-2026-11.md](insider-replay-2026-11.md) apply:
- a mechanical rule, not Claude's judgment;
- survivorship;
- daily bars only.

One matters more here than it did there. **Stops and targets see only the session's open**, so a trailing stop never sees an intraday high or low. A live trailing stop, checked every 15 minutes, would fire a little more often on pullbacks. That would likely make it look worse, not better.

## Reproduce

```sh
npm run replay -w @trader/core -- --rules insiders --from 2019-01-02 --to 2026-11-06
npm run replay -w @trader/core -- --rules insiders --from 2019-01-02 --to 2026-11-06 \
  --variant trailing-stop=15 --baseline-report .cache/replay/reports/rules-insiders-2019-01-02-2026-11-06-10bps.json
```

Each run takes about three and a half hours with seven side by side (6.3 s a session; [#89](https://github.com/whitebirchio/trader/issues/89)).
