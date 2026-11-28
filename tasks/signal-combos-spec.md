# Spec: do signals that agree beat VTI? (signal combinations, #140)

> **Status: Approved** (Scott, 2026-11-28), with the open questions resolved as recommended: drift is left out, 13D/13G means concentrated managers' filings only, and the bar is 3 SE. Plan: [signal-combos-plan.md](signal-combos-plan.md); tasks: [signal-combos-todo.md](signal-combos-todo.md). The issue is the design. This spec fixes what it left open, before any result is seen.

## Objective

Every buy signal tested alone has failed to beat VTI in the stocks Trader can buy: insider buys, earnings reactions, momentum, quality, value, 13F moves, and 13D/13G stakes. Averaging signals with no edge gives no edge. A combination helps only if signals do better **together than apart**. This study tests whether that happens, built so a lucky combination can't pass.

**The owner's question it answers:** is there a signal, or a combination, that beats VTI and could lead a thesis at full size? If one passes, it goes to Scott as a proposed owner's direction for the routine. If none does, that's the finding, and the routine's rules stay as they are.

**Success:** a report in `docs/research/` with a verdict for each of the five tests below, against a promotion rule fixed here, plus a row in the research README. Nothing ships to the routine without Scott's direction.

## Assumptions (correct any of these)

1. **Post-earnings drift (#105) isn't in it.** The issue adds drift only "if tested by then", and it hasn't been. The closed list means it can't join after results are seen, so it gets its own test later, with its own held-out period.
2. **13D/13G stakes are in,** as the issue allows now that Part 2 is done: an initial 13D or 13G filed by a concentrated manager (the two concentrated buckets of `13d-13g-stakes-vs-vti-2026-11.md`). That study's other buckets were mostly index funds crossing 5%, which is noise for this purpose.
3. **No new downloads.** Everything comes from the existing caches:
   - the insider and earnings events (`.cache/*-outcomes.json`);
   - the 13F and 13D/13G events (`.cache/combos/`);
   - daily bars (`.cache/bars/`), plus the SEC frames for gross profitability (`.cache/edgar-frames/`).

   A symbol whose bars aren't cached is fetched with the paper key, market data only, as the earlier studies did.
4. **Every number is recomputed from the bars** for each test's own entry date. The cached excess returns were measured from each study's own entry, so they aren't reused.

## The signals (each defined as in its own study, point-in-time, no new tuning)

| Signal | Kind | Public on | From |
|---|---|---|---|
| **Insider cluster:** an insider-buying event with 2+ distinct officers or directors | event | the event's last Form 4 filing date | `insider-buys-vs-vti-2026-11.md` (`buyers ≥ 2`) |
| **13F big new position:** new in a concentrated manager's top five at 5%+ of its book | event | the 13F's filing date | `13f-best-ideas-vs-vti-2026-11.md` (`newTop5`) |
| **Positive earnings reaction:** earnings-day return vs VTI of +5% or more | event | the reaction date | `earnings-reactions-vs-vti-2026-11.md` |
| **13D/13G by a concentrated manager:** an initial filing | event | the filing date | `13d-13g-stakes-vs-vti-2026-11.md` |
| **Top-decile momentum:** 12-1 month return in the top 10% of tradable stocks | state | the latest month-end on or before the date | `momentum-vs-vti-2026-11.md` |
| **Top-decile gross profitability,** or the top 30% where test 4 says so | state | the latest April formation on or before the date | `quality-value-vs-vti-2026-11.md` |

**Warning screens** (not signals):
- **A recent big loser:** a 12-1 month return of −30% or worse.
- **A fresh earnings crash:** an earnings-day return of −10% or worse vs VTI within the last 10 trading days.

## The five tests (a closed list)

1. **Signal count, the headline.**
   - **Anchor:** each event signal firing on a stock.
   - **What's counted:** the *other* signals active on that stock then. An event counts if it fired in the prior 90 days; a state counts if it holds then.
   - **Groups:** 0, 1, 2 and 3+ others.
   - **One row per stock per 90 days:** the first anchor, so one stock with several signals isn't counted several times.
   - **Passes if both:**
     - the slope of the cohort-mean 60-day excess return across the count is positive at 3 SE or more in-sample, and positive held out;
     - the 2+ group passes the promotion rule.
2. **Two informed buyers:** an insider cluster and a 13F big new position (or a concentrated 13D/13G) on the same stock within 90 days, entered when the second becomes public. Compared with each signal alone.
3. **Insiders buying strength, not dips.** Insider clusters split by what came just before:
   - **Strength:** after a positive earnings reaction within 90 days, or with the stock above its 200-day average.
   - **A dip:** after a 20%+ drop in the prior 60 days (the pattern that failed in #29).

   It passes if the strength group passes the promotion rule. Whether it beats the dip group is reported.
4. **Informed buyer plus quality:** an insider cluster, 13F big new position or concentrated 13D/13G in a stock in the top 30% by gross profitability. Compared with the same events outside it.
5. **Every signal with the warning screens applied:** each event signal again, without recent big losers and fresh earnings crashes. Compared with the unscreened version in its own study. This tests whether the edge is in avoiding bad trades.

A sixth idea that comes up while reading the results goes in a later issue, with its own held-out period.

## The promotion rule (fixed now)

Stricter than the earlier studies' 2 SE, because there are many comparisons. A test passes only if all of these hold:
- the 60-day **cohort-mean** excess return over VTI, after a 0.2% round trip, is above zero **in-sample at 3 standard errors or more**;
- the same is above zero **held out**;
- the 120-day in-sample mean doesn't reverse it.

**Cohorts and periods:**
- A cohort is a calendar month: its events' mean counts once, so the standard error is across months.
- A group with fewer than 8 in-sample months is reported but not judged.
- In-sample is events from 2019-01 to 2023-12. Held out is 2024-01 to the latest event with 60 sessions of bars. Quality starts with the 2019 formation, so everything starts in 2019.

## Method

- **Universe:** what risk would let Trader buy on the entry date (price, average dollar volume), as in the earlier studies. Funds and ETFs are out.
- **Entry:** the first close after the combination becomes public (after the later signal, for a pair). The horizons are 20, 60 and 120 trading days.
- **Excess return:** the stock's return minus VTI's over the same sessions (`outcomeAfter`, as before). A 7-day stale-bars guard applies.
- **Reported for every test and group:**
  - events and months;
  - the 20, 60 and 120-day cohort means ± SE;
  - the 60-day share of months beating VTI;
  - in-sample and held out, and year by year;
  - the verdict.

## Commands

```sh
npm run research:combos -w @trader/core -- [--report ../../docs/research/signal-combos-vs-vti-2026-11.md] [--events file.tsv]
npm run typecheck && npm test        # the gate, before every commit
```

## Project structure

```
packages/core/src/research/combos.ts         → pure: the signal timelines, the count, each test's grouping, the slope test (tested)
packages/core/scripts/research-combos.ts     → loads the caches, builds the events, scores them, writes the report (research-tables.ts for the tables)
packages/core/test/research/combos.test.ts   → the counting window, one row per stock per 90 days, pair entry dates, screens, the slope and its SE
docs/research/signal-combos-vs-vti-2026-11.md → the report: a hand-written summary above the generated tables
docs/research/README.md                       → + a row
```

## Code style

As the other research scripts: pure logic in `src/research/`, I/O in the script, money and returns as numbers only inside the research layer (as the earlier studies did; nothing here touches the order path).

```ts
/** The other signals active on `symbol` at `date`: events in the prior 90 days, states as of `date`. Pure. */
export function activeSignals(timeline: SignalTimeline, symbol: string, date: string, except: SignalKind): SignalKind[]
```

## Testing

Unit tests on the pure parts, with small hand-built timelines:
- an event at exactly 90 days counts, and one at 91 doesn't;
- a state counts only on dates it holds;
- the first anchor wins within 90 days;
- a pair enters on the later signal's public date;
- the warning screens drop exactly what they should;
- the slope and its standard error on a known series.

The run is checked by spot-checking five events against their source studies' event files and sec.gov, as in the earlier studies.

## Boundaries

- **Always:**
  - fix every definition here before running;
  - report every test, including the failures;
  - keep data on disk and stream large files;
  - run the gate before each commit.
- **Ask first:**
  - adding a test, signal or horizon after any result is seen (that's a new issue);
  - any new download;
  - proposing a routine change from the result (Scott decides).
- **Never:**
  - tune a threshold after seeing results;
  - use account or production data;
  - change anything that trades.

## Success criteria

1. `research:combos` runs offline from the caches, and fetches bars only for symbols missing from them.
2. The report gives each of the five tests a verdict under the rule above. The headline slope is reported with its standard error, in-sample and held out.
3. Five spot-checked events match their source studies and sec.gov.
4. The research README has a row, and the gate passes.
5. Scott reads the report. If anything passes, the routine change is his to direct; if nothing does, the issue closes with the finding.

## Resolved (Scott, 2026-11-28)

1. **Drift (#105)** is left out. It gets its own later test, with its own held-out period.
2. **13D/13G** means initial filings by concentrated managers only.
3. **The bar** stays at 3 SE, with the dose-response slope as the main guard against a lucky combination.
