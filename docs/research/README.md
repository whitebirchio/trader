# Research

Studies behind the routine's rules (`get_rules`, `agent/routine-prompt.md`). Each one is dated and stays as written. A later study supersedes an earlier one rather than editing it.

## Backtests: does a signal beat VTI?

Event studies over 2018–2026, on the stocks risk would let Trader buy. A script regenerates each one's tables. Its summary is written by hand.

| Study | Issue | Result |
|---|---|---|
| [Insider buys vs VTI](insider-buys-vs-vti-2026-11.md) | #29 | No edge. The live pattern lost to VTI outside 2020. |
| [Earnings reactions vs VTI](earnings-reactions-vs-vti-2026-11.md) | #15 | No edge either way. Big earnings-day drops kept losing. |
| [Momentum vs VTI](momentum-vs-vti-2026-11.md) | #49 | The top decile doesn't pass. The weakest stocks kept losing, so it's a signal of what not to buy. |
| [Quality and value vs VTI](quality-value-vs-vti-2026-11.md) | #49 | Nothing passes the promotion rule. |

## Replays: does an idea survive Trader's rules?

| Study | Issue | Result |
|---|---|---|
| [The insider rule through Trader's rules](insider-replay-2026-11.md) | #57 | +130% against VTI's +218% over 2019–2026. A 45-day review came closest. |
| [A trailing stop and a profit target, replayed](thesis-exits-replay-2026-11.md) | #35 | Neither helped: every setting lost 2–13 points. ADR-017's halt changes added about 10. |

A replay runs Trader's real jobs (sync, rebalance, risk, orders) day by day over past daily bars, with a simulated broker and clock, on a throwaway PGlite database. It never touches Neon or Alpaca's trading API. It reports performance against VTI, the thesis scorecard, trading and taxes, risk's decisions and every halt. A variant reruns the same inputs with one change (`stop=N`, `cap=N`, `review-days=N`, `trailing-stop=N`, `take-profit=N`) and diffs the two. All commands run in `packages/core` (`npm run <script> -w @trader/core -- …` from the root):

```sh
npm run replay:export -- --env staging|production   # an account's history as a timeline (live figures: stays local)
npm run replay -- --timeline production [--variant stop=20] [--compare-actual]
npm run replay -- --rules insiders --from 2019-01-02 --to 2026-11-06 [--variant review-days=45]
```

Market data is fetched with the paper key and cached under `.cache/replay/`. Reports are written there too, and are git-ignored, because a history's report holds live figures. A rule-based replay's reports are a simulated account, so they can be committed beside the write-up. Usage and flags are in `scripts/replay.ts`'s header.

**What a replay can't tell you:**

- **Whether Claude's judgment adds anything.** A rule-based timeline is mechanical. A recorded history is short (it starts in November 2026), so it proves the machinery more than it proves anything about returns.
- **Anything intraday.** Daily bars only: decisions see the session's open, orders fill there with a slippage assumption, and a move through a stop that recovers by the next open goes unseen.
- **Anything about companies with no price history.** Delisted names missing from Alpaca's data are left out (survivorship), so read every figure as a best case. Delisted names that do have bars are assumed tradable while they traded.
- **Taxes, dividends and corporate actions,** beyond Alpaca's adjusted bars. Short-term gains and wash sales are counted but don't reduce the return.
- **The owner.** A rule-based replay resumes a halt at the next session. Live, that's Scott's decision.
- **Fast answers.** A multi-year replay takes about three hours ([#89](https://github.com/whitebirchio/trader/issues/89)).
