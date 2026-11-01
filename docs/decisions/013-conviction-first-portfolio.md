# ADR-013: A conviction-first portfolio; idle money sits in VTI

## Status
Accepted (supersedes ADR-003's 70/30 default; ADR-003's split of authority stands)

## Date
2026-11-01

## Context
ADR-003 assumed a mostly-quant core with a 30% satellite of Claude's ideas. Specifying `portfolio`, Scott clarified the purpose: Trader holds a small slice of his money as **risk capital**, to look for an edge through Claude's research (fundamentals, Congress disclosures, insider buys, 13F holdings such as Berkshire's, news). The main trunk of his money stays in VTSAX and other investments outside Trader. Index-like behaviour isn't the point.

## Decision
- **Conviction sleeve: up to 100%.** Claude's theses, mostly individual stocks, each with a target weight (at most 20%, the `risk` per-name cap), written reasoning, at least one piece of evidence, and a required 5–50% stop-loss. `risk`'s `convictionCapPct` is 100.
- **Systematic sleeve: the remainder.** A momentum + trend ranking over a Claude-chosen list of stocks and ETFs, topN weighted equally or by inverse volatility.
- **No idle cash.** `risk`'s cash buffer is $0. A systematic name over the 20% cap is held at the cap, and the excess goes down the ranking, then to **VTI**. Trend-filtered slots without a defensive symbol, and "nothing rankable", also go to VTI. "Idle" means VTI.
- **Cash-equivalent ETFs (SGOV, BIL, SHV) are exempt from the cap,** as an owner-set list, so a defensive move can go all the way. A symbol called `defensive` but not on the list stays capped.
- **Thesis lifecycle.** A stop-loss hit sells the thesis, and it stays stopped (re-entry needs a new id). A thesis not reaffirmed for 30 days unwinds into systematic, which is the backstop if Claude's research loop dies (ADR-004).
- **Version 0** is 100% VTI, until Claude's first strategy.

## Alternatives Considered

### 70/30 core/satellite (ADR-003's default)
- Rejected: it makes Trader mostly an index fund, which Scott already owns elsewhere.

### Leave over-cap money for `risk` to clip, or hold it in cash
- Rejected: it leaves money idle and fills the digest with repeated rejections.

## Consequences
- More concentrated and more volatile than VTI, by design. The −20% drawdown halt and the −5% daily pause (ADR-012) are the brakes.
- `topN` means "at least N names", since the cap can push the systematic sleeve wider.
- The `agent` module must show Claude the open wash-sale windows and stopped thesis ids, so its submissions don't get rejected.
