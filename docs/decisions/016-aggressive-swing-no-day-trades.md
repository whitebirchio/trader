# ADR-016: Aggressive swing trading; no systematic sleeve, no day trades

## Status
Accepted (amends ADR-013's systematic sleeve and ADR-012's brake levels; both ADRs' structure stands)

## Date
2026-11-04

## Context
After Trader's first three live days, the account held one thesis at 5.5% and about 94% in a sector-ETF momentum sleeve, and nothing had changed since the first day. Scott clarified what he wants. Trader is a sandbox of aggressive risk capital, separate from his main index-fund money, for finding an edge through Claude's research. It should be aggressive, but not reckless: positions backed by evidence, a few trades a week, held for days to weeks or longer while the reason stands, weighing wash sales and taxes. It should not trade on margin, ever, and should not bump into the day-trading rules (FINRA's pattern-day-trader rule, or the intraday margin rule replacing it). Real day trading may come later, but deliberately.

Three things kept the book cautious, and none of them were risk limits (conviction could already hold 100%):
- **A funding bug.** A new thesis takes money from the other targets, but in a fully invested account each one is over its target by less than its drift band, so nothing was sold and the buy was never funded. Claude found this when it tried to add a 5% Boeing thesis on 2026-11-04.
- **Cautious instructions.** "Prefer fewer, better-evidenced theses" and "reaffirm when nothing changed" made standing still the default.
- **A momentum sleeve** that held most of the money in sector ETFs, which is index-like behaviour Scott already owns elsewhere.

The live account is an Alpaca "limited margin" account at 1x (`multiplier` 1, `buying_power` = `cash`, `max_margin_multiplier` 1, shorting off). Alpaca opens every account as a margin account. At 1x it never borrows. Alpaca no longer reports the PDT fields (`pattern_day_trader`, `daytrade_count`, `pdt_check`) for the account.

## Decision
- **Fund new or larger theses from what's over target,** however small the gap (the planner's `spendableCash`), largest gap first, the way a withdrawal is funded (ADR-015).
- **No systematic momentum sleeve, by the owner's direction.** Claude keeps `systematic` idle-only (universe `["VTI"]`, `topN` 1), so everything not in a thesis sits in VTI. This is a direction in Claude's instructions, not a schema change, so a sleeve can return later without a migration.
- **Aggressive, evidence-based instructions.** Aim for most of the account in theses (typically 5–8 names, up to 20% each). VTI is the fallback for a missing idea, not the goal. Swing, don't churn: a few trades a week, weighing wash sales, short-term taxes and spread.
- **No day trades: `limits.sameDayRoundTrips` is false.** Risk rejects selling a symbol bought today, or buying back one sold today, using today's fills and our orders that may still fill. The planner leaves such trades out with a note, so they wait for the next trading day instead of being rejected every 15 minutes. A thesis bought today and stopped out today is sold the next day.
- **Looser brakes:** the drawdown halt goes from −20% to **−30%** (still latched, owner resumes), and the daily buy pause from −5% to **−8%**. A concentrated book of 5+ names swings more than an index.
- **No margin, unchanged:** sync blocks trading unless the account is 1x with shorting off, and risk caps every buy at available cash.

## Alternatives Considered

### True intraday day trading now
- Deferred. It needs intraday signals, a faster loop than a research routine, and a design that stays inside the day-trading rules without margin (likely a settled-cash approach). Scott may want it later. The `sameDayRoundTrips` limit is the switch that would turn it on deliberately.

### Make the systematic sleeve optional in the strategy schema
- Rejected for now: it touches the schema, targets, ranking, preview and the dashboard for the same outcome an idle-only universe already gives.

### Raise the per-name cap above 20%
- Rejected by Scott: 5+ names is concentrated enough.

## Consequences
- More concentrated and more volatile than before, by design. The −30% halt and −8% daily pause are the brakes.
- A stop-loss can't fire on the day a thesis was bought. The loss on that day is bounded by the position's size (at most 20% of equity).
- A strategy change that would sell something bought today waits a day. Funding sells skip such holdings and use the next one over target. If none is left, the buy waits too.
- The routine prompt in the claude.ai routine must match `agent/routine-prompt.md`.
