# Spec: `portfolio`

> **Status: Approved** (Scott, 2026-10-31). **Revised 2026-11-01 for the AWS platform** (ADR-014): its own schedule, no CPU constraint. Revision approved by Scott, 2026-11-01. Module 5 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on `broker` and `risk` (both implemented) and on `notifications` for emails.

## Objective

Turn Claude's strategy into orders, every trading day, through `risk`, without anyone in the loop (ADR-003).

This is a **sandbox for an edge**, holding a small fraction of your money (most of it stays in VTSAX). So the portfolio is **conviction-first** (Scott, 2026-10-31):

- **Conviction sleeve (up to 100%).** Claude's picks, mostly individual stocks. Each is a *thesis* backed by fundamental analysis and public proxy signals: Congress trade disclosures, insider buys (Form 4), well-known investors' holdings (13F, e.g. Berkshire Hathaway) and news. Each thesis has a target weight, a stop-loss, and a review date.
- **Systematic sleeve (the remainder).** When Claude has nothing compelling, rules decide: a momentum + trend ranking over a list of stocks and ETFs that Claude chooses, with the top few held and weighted by volatility. Whatever conviction doesn't use goes here, so nothing sits idle as cash.
- **Daily check, trade on drift.** Once a day (from 9:45 ET), compare holdings with targets, and trade only what drifted past a threshold or changed: a new strategy, a new or closed thesis, a stop-loss hit, a stale thesis.
- **Benchmarked against VTI.** The flow-adjusted index vs VTI's total return, in the digest and later on the dashboard.

`portfolio` doesn't research anything. Claude does that in `agent`'s scheduled routine and hands `portfolio` a strategy. Until `agent` exists, you can submit a strategy file by hand for testing.

> **2026-11-04 (ADR-016):** by the owner's direction, the systematic sleeve is idle-only (universe `["VTI"]`, topN 1): everything not in a thesis sits in VTI, and Claude's instructions aim for most of the account in 5–8 theses. The momentum machinery below stays in place, unused, so a sleeve can return without a schema change.

## The strategy model

A strategy is an **immutable, versioned document**. Each submission is validated and becomes the next version, and the newest valid version is active from the next daily check. Every version records who wrote it (`claude` / `owner` / `system`), and old versions are never edited.

```ts
interface Strategy {
  summary: string;                    // Claude's rationale, in prose (shown in emails/dashboard)
  conviction: Thesis[];               // may be empty
  systematic: {
    universe: string[];               // 1–100 symbols, stocks and/or ETFs, chosen by Claude
    lookbackDays: number;             // momentum window, 21–252 trading days
    skipRecentDays: number;           // skip the most recent N days of the window, 0–21 (classic 12-1 momentum = 252/21)
    topN: number;                     // hold the top N, 1–20
    trendFilterDays: number | null;   // only hold if price > its N-day average (50–250), or no filter
    weighting: "equal" | "inverse_volatility";
    volatilityDays: number;           // 20–126, for inverse_volatility
    defensive: string | null;         // where slots that fail the trend filter go: a symbol (e.g. "SGOV") or null = cash
  };
  drift: { relativePct: string; minTradeUsd: string };   // e.g. 20% of target, but never trades under $5
}

interface Thesis {
  id: string;                         // stable across versions: re-listing an id reaffirms it
  symbol: string;
  targetWeightPct: string;            // % of equity, 0 < w ≤ 20 (risk's position cap)
  thesis: string;                     // why, in prose
  evidence: { kind: "congress" | "insider" | "13f" | "fundamental" | "news" | "technical" | "other";
              summary: string; source?: string; asOf?: string }[];   // ≥ 1
  stopLossPct: string;                // 5–50: sell if the price falls this far below our average cost
  reviewBy?: string;                  // YYYY-MM-DD (#35): unwinds the day after; see "overdue" below
  plainSummary?: string;              // 20–600 chars (#60): the thesis in plain language for the owner
}
```

**Lifecycle of a thesis:**
- **active:** it's in the current strategy.
- **stopped:** its stop-loss was hit, so it's sold. It stays stopped until Claude re-submits it with a *new* id (a new decision, not an automatic re-entry).
- **stale:** 30 days have passed since the last strategy that listed it. It's sold into the systematic sleeve. This is the backstop for a dead research loop (ADR-004); while Claude keeps reaffirming a thesis, it never goes stale.
- **overdue** *(2026-11-08, #35)*: the market date is past the thesis's optional `reviewBy`. It's sold into the systematic sleeve, recorded once (`thesis_events` `overdue`) and emailed urgently (`thesis.review_overdue`). Reaffirming alone doesn't clear it. At submission (preview and submit alike): a new or changed `reviewBy` must be after today; a thesis keeps its review date once it has one; and moving the date later needs an evidence item dated after every evidence date the thesis had before. An unchanged date passes even once past, so the rest of a strategy can still be reaffirmed. Precedence: stopped > stale > overdue > stop-loss > active.

**Plain summary** *(2026-11-08, #60)*: an optional `plainSummary` of 2–4 jargon-free sentences: what the company does, why it should beat the market, and what would prove it wrong. It's for the owner, and it changes nothing about execution. It leads each thesis on the dashboard (the strategy page and the thesis page), is listed under "In plain terms" in the activation email, and follows each thesis opened in the weekly letter. Optional, so stored versions stay valid; `preview_strategy` warns about every thesis without one, and the routine writes one for each.
- **closed:** it's no longer in the strategy, so it's sold.

**Before Claude's first strategy,** a `system` version 0 runs: no theses, and a systematic universe of `["VTI"]` with `topN: 1` and no trend filter. That's the benchmark itself, so the account tracks VTI exactly until there's an actual idea to act on.

## The daily check (`rebalance` job)

It runs on **its own EventBridge Scheduler schedule**, `trader-rebalance-<env>`: every 15 minutes (:00/:15/:30/:45) on weekdays, 13:00–20:59 UTC. The code gates on the Alpaca calendar (trading days, early closes) and on a **9:45–15:30 ET** window. The window opened at 10:30 until Scott moved the first trade to 9:45 on 2026-11-01, so the first step comes 15 minutes after the open, once the 9:30 sync has run. A step plans on the latest sync, which is at most 15 minutes old and inside `risk`'s 20-minute freshness limit. It's a separate schedule from the shared tick, so a slow rebalance can never delay `sync-broker` or the notifications. Each run does at most one step:

1. **Build targets** (pure, from the active strategy, bars, positions and lots):
   - Thesis states: stop-loss (last close ≤ average cost × (1 − stop%)), staleness, and removal.
   - Conviction targets = Σ active thesis weights, capped by `risk` at 100%.
   - Systematic targets = the rest. Rank the universe (minus any conviction symbols) by return over `lookbackDays` skipping `skipRecentDays`, apply the trend filter, take `topN`, weight them, and send filtered-out slots to `defensive`.
   - Each target in dollars = weight × (equity − risk's cash buffer). The buffer is **$0** (Scott, 2026-11-01): this is risk capital, so nothing sits in cash.
   - **No dollar sits idle** (Scott, 2026-11-01; option 1b). A systematic name above `risk`'s 20% per-name cap is held at the cap. The excess first tops up the chosen picks still under the cap, in rank order. Then it goes **further down the ranking** (names above their trend, outside wash-sale windows), each filled to the cap. Whatever is still left goes to **VTI**, which as a broad ETF is exempt from the cap. Trend-filtered slots without a `defensive` symbol, and "nothing rankable", also go to VTI, never cash. `topN` therefore means "at least N names".
2. **Plan trades:** exits, and drift beyond `max(relativePct × target, minTradeUsd)`. **Conviction buys are funded (ADR-016):** when they need more than the spare cash, positions over target are sold back toward it however small the gap, largest first. **No same-day round trips:** a sell of something bought today, or a buy of something sold today, is held back with a note until the next trading day (`risk`'s `sameDayRoundTrips`). If that holds back the sells funding a conviction buy, the buy waits too. **Sells first:** a tick with sells places only the sells, and a later tick places the buys once the fills have settled into cash. This avoids sizing buys on money that hasn't arrived yet.
3. **Wash-sale awareness (ADR-010):** a *systematic* buy of a symbol sold at a loss in the last 30 days is skipped, and the next-ranked symbol takes its place. *Conviction* buys go ahead: that's Claude's informed call, and `agent` will show it the open wash-sale windows. Every skip is noted in the plan.
4. **Gate and submit:** proposals → `riskGate` (with sleeve attribution) → `submitOrder` for the approved and clipped ones. Intent keys are `<planId>:<symbol>:<side>`, so re-running a step can't double an order (ADR-007, SPEC-broker).
5. **Record:** a `rebalance_plans` row holds the targets, the trades, the skips and the risk decisions. It's audited.

When targets are already met, the step is a quick no-op. The trading window opens at 9:45 ET, 15 minutes after the open (Scott's choice; the original 10:30 avoided more of the opening volatility), and closes before the last half hour.

## Changes to other modules (part of this module)

| Where | Change | Why |
|---|---|---|
| `risk` | Sleeves renamed `core`/`satellite` → `systematic`/`conviction`; `satelliteCapPct` 30 → `convictionCapPct` **100** | Your decision, 2026-10-31. The 20% per-name cap and every other limit are unchanged. |
| `docs/decisions` | **ADR-013 "Conviction-first portfolio"**, superseding ADR-003's 70/30 default (ADR-003's authority split stands) | Records the change and why |
| `CAPABILITY-MAP.md` | Objective line updated to "conviction-first" | Keep the index honest |
| `infra` | `EngineStack` gains the `trader-rebalance-<env>` schedule (`cron(0/15 13-20 ? * MON-FRI *)` UTC, `{"jobs":["rebalance"]}`) | rebalance runs on its own schedule (ADR-014) |
| `notifications` | New kinds routed: `strategy.activated`, `thesis.stopped_out`, `thesis.stale` → urgent; `strategy.rejected` → urgent; `rebalance.planned` → digest. The digest gains a "vs VTI" line. | Strategy changes and automatic exits are meaningful autonomous actions |

## Assumptions (correct any of these)

1. **Analytics use floats; money doesn't.** Returns, volatility and rankings are statistics, so they're computed with JS numbers for speed. Every dollar and share amount that becomes a target, a proposal or an order stays a decimal string with `Big` (ADR-009).
2. **Stop-losses are checked once a day,** at the daily check on the latest data, not as resting stop orders at Alpaca. A stock that gaps down overnight sells at the next check's price, possibly below the stop level. Resting stop orders would bypass `risk`'s gate (ADR-011's spirit), so v1 doesn't use them.
3. **Average cost** for the stop-loss comes from that symbol's open FIFO lots (`broker`'s `buildLots`). A symbol is in at most one sleeve at a time: conviction symbols are excluded from the systematic ranking.
4. **Data:** daily bars from Alpaca's free SIP feed (`broker.getDailyBars`), enough history for the longest window plus margin. No fundamentals feed: fundamental data reaches `portfolio` only as thesis evidence written by Claude.
5. **Owner strategy submission for testing:** `strategy:submit --file … --env staging` writes a version with `authoredBy: "owner"`. `agent` will add Claude's path (`submit_strategy`) with `authoredBy: "claude"`. Both go through the same validation.

## Tech Stack

No new dependencies. It runs in the engine Lambda (ADR-014), with no CPU constraint worth designing around: the Lambda allows minutes per run, and a year of **daily** bars for 100 symbols parses in about 8 ms (measured 2026-10-31). The extra pieces are one Scheduler schedule and a CloudWatch alarm on `rebalance` failures, both in `EngineStack`.

## Commands

```sh
npx vitest run portfolio                                                # targets, ranking, thesis lifecycle, planner, wash-sale skip
npm run strategy:submit -w @trader/core -- --env staging --file strategy.json   # owner submits a version (validated)
npm run strategy:show   -w @trader/core -- --env staging [--version N]  # the active strategy and thesis states
npm run rebalance:plan  -w @trader/core -- --env staging                # dry run: today's targets and trades, through risk; places nothing
npm run rebalance:run   -w @trader/core -- --env staging                # one real step on paper now, from the laptop
npm run invoke -- --env staging --jobs rebalance                        # the same step in the deployed Lambda
```

## Project Structure

```
packages/core/src/portfolio/
  strategy.ts   → Strategy/Thesis types, Zod validation with bounds, submitStrategy(), activeStrategy()
  theses.ts     → thesis states: active / stopped / stale / closed (pure)
  systematic.ts → momentum + trend ranking and weighting (pure, float analytics)
  targets.ts    → strategy + market data → dollar targets per symbol and sleeve (pure)
  planner.ts    → targets vs holdings → sells-first trade list, drift rule, wash-sale skips (pure)
  rebalance.ts  → the job: load, plan, riskGate, submitOrder, record
  benchmark.ts  → index vs VTI total return since inception
```

### Data model (migration, additive)

| Table | Purpose |
|---|---|
| `strategies` | `version` (serial), `authored_by`, `created_at`, `document` (jsonb, validated), `summary`. Insert-only. |
| `thesis_events` | Thesis state changes (`stopped`, `stale`, `overdue`, `closed`, `reaffirmed`) with price and cost at the time. Insert-only. |
| `rebalance_plans` | Per step: `trading_date`, `strategy_version`, `phase` (`sell` / `buy` / `none`), `targets`, `trades`, `skips` (jsonb), `gate_run_id`. One row per step. |

## Testing Strategy

- **Pure functions, table-driven:** momentum ranking (with skip-recent), the trend filter, inverse-vol weights summing to the sleeve, `defensive` substitution, conviction-first allocation with the remainder to systematic, the thesis lifecycle (stop, stale at day 30, reaffirm resets, stopped stays stopped), sells-first phasing, the drift threshold and `minTradeUsd`, and the wash-sale skip-and-substitute.
- **Validation:** every bound in the strategy schema (universe size, windows, weights, ≥ 1 evidence item, total conviction ≤ 100%, no duplicate symbols).
- **Rebalance job** (PGlite + fake broker): version 0 converges to 100% VTI from cash in two steps (no sells, then buys); a strategy change sells first, then buys; re-running a step places nothing new; risk clips flow through; a stop-loss hit sells and audits `thesis.stopped_out`.
- **Live on paper:** `strategy:submit` with a sample conviction strategy → `rebalance:plan` → `rebalance:run` → orders fill → `strategy:show` reflects the holdings.

## Boundaries

- **Always:** route every order through `riskGate`; keep the target and planner logic pure; record why each trade happened (strategy version, thesis id or rank); prefer no trade to a marginal one (drift threshold).
- **Ask first:** changing the trading window, the staleness period or the default version 0; placing orders on the live account outside the scheduled job.
- **Never:** let a strategy document change a risk limit; trade a symbol `risk` has blocked; use resting stop orders that skip the gate; act on a strategy that fails validation (it's rejected and audited, and the previous version stays active).

## Success Criteria

1. Gate green, with the testing strategy above covered.
2. Staging, version 0: from the paper account's cash, `rebalance:run` reaches ≈ 100% VTI (minus the cash buffer) in two steps, and a third step is a no-op.
3. Staging, a sample conviction strategy (e.g. 3 theses + a systematic universe): `rebalance:plan` shows sells first, then buys, risk clips where expected, and a wash-sale skip if staged. `rebalance:run` places them, they fill, and `strategy:show` matches.
4. Stop-loss: lowering a thesis's stop in a fixture (or a test) triggers the sale and one urgent `thesis.stopped_out` email (queued and suppressed on staging).
5. A thesis left out of strategies for 30 days unwinds (test with an injected clock).
6. Production: merged with **version 0 active**. The live account converges from $1k cash to ≈ VTI over the first trading day's steps, through `risk`, with emails for fills in the digest. **This is the first module that places live orders.** You approve the merge knowing that.

## Resolved Questions (2026-10-31, approved as proposed)

1. ~~**Workers Paid ($5/mo).**~~ **Superseded 2026-11-01:** the engine moved to AWS (ADR-014), so there's no Workers CPU limit and no Cloudflare upgrade.
2. **Version 0 = 100% VTI** until Claude's first strategy.
3. **Stop-losses are required on every thesis, 5–50%.** No default: a thesis without one fails validation.
4. **Over-cap systematic targets → option 1b** (Scott, 2026-11-01): cap, then overflow down the ranking, then VTI. See the daily check.
5. **No cash buffer; idle money sits in VTI** (Scott, 2026-11-01). `risk`'s `cashBufferMin`/`cashBufferPct` are now `0`.
6. **Cash-equivalent ETFs are exempt from the 20% cap** (Scott, 2026-11-01): SGOV, BIL and SHV are on an owner-set `cashEquivalentEtfs` list, so a defensive slot holds its full share. A `defensive` symbol not on that list stays capped. The role isn't an exemption.

## Scorecard (2026-11-07, #27)

> **Status: Built** (approved by Scott 2026-11-07; #27). Plan: [tasks/done/scorecard-plan.md](tasks/done/scorecard-plan.md).

**Why.** Trader exists to find out whether Claude's research beats VTI, but nothing measures that one idea at a time. The account-level comparison (`compareToBenchmark`, `capitalSummary`) mixes every thesis with the idle VTI money. After the first week, all seven live theses are the same kind of bet (insider buying after a sell-off), and neither Claude nor Scott can see whether that signal pays.

**What.** One row per thesis ever held, plus roll-ups. It's computed on read from data we already keep (strategy versions, `thesis_events`, `broker_activities`, `positions`, `benchmark_closes`): no migration, no new job, and nothing stored, the same way lots are rebuilt from fills. Database only, so the dashboard's SELECT-only role can read it.

### Attribution: which fills belong to a thesis
- A thesis's **window opens** at the `createdAt` of the first version that lists its id. Past versions are read leniently (id, symbol, weight, evidence kinds), so an old document that no longer validates still counts.
- It **leaves** at the first of: a `thesis_events` `stopped` or `stale` row; or the first later version that doesn't list it (*removed*).
- Its **window closes** when, after it leaves, the symbol's position next goes flat. The sell-out fills after the strategy changed still belong to it. A thesis that hasn't left is **open**.
- **A successor on the same symbol** (a new id opened while the old one's shares are still held, e.g. a re-written thesis) continues the same row: the row keeps the first id and lists the later ones. Splitting a position no one sold would invent a trade.
- **Unscored, with a reason:** the symbol was already held when the window opened (no attributable cost), or `buildLots` reports an issue for it (a split or transfer).
- Fills outside every window (VTI and the systematic sleeve, manual trades) aren't on the scorecard.

### Money: return vs the same dollars in VTI
For each row, over its fills (`FILL`) and dividends (`DIV`) in the window:
- `bought` = Σ buy qty × price; `proceeds` = Σ sell qty × price; `dividends` = Σ DIV net amount.
- `marketValue` = open qty × the mark. `pnl` = proceeds + dividends + marketValue − bought.
- **VTI shadow:** each buy's dollars buy VTI at that day's adjusted close. Each sell sells the same fraction of the shadow's shares as of the thesis's shares, at that day's close. Its `pnl` is computed the same way, with dividends inside the adjusted closes.
- `excess` = pnl − vtiPnl. Percentages are on `bought`: `returnPct`, `vtiPct`, `excessPct`. That is exact for a buy-and-hold thesis and understates when a thesis was resized; this is accepted for v1.
- **Mark:** open rows are valued at `positions.current_price` (the last sync), and the shadow at VTI's `positions.current_price` when VTI is held, otherwise its latest recorded close. The result carries `markedAt`.
- Known approximations: VTI is bought at the close, not at the thesis fill's minute; Alpaca's sell-side regulatory fees aren't counted.

### Roll-ups
- **Overall** and **by primary signal kind**, where the primary kind is the most frequent `evidence.kind` in the thesis's last listing (ties go to the earliest listed).
- Each roll-up has count, closed count, Σ bought, Σ pnl, Σ vtiPnl, excess (dollars and % of Σ bought), the share of rows that beat VTI, and median days held.

### Surfaces
- **`get_track_record`** (agent, read-only MCP tool): the roll-ups and rows, newest first.
- **Routine prompt:** read it in *Orient*, and weigh it when sizing in *Decide*. A few rows are noise; say so instead of over-fitting.
- **Dashboard:** a *Track record* page.
- **Operator:** `npm run scorecard:show -w @trader/core -- --env staging|production`.
