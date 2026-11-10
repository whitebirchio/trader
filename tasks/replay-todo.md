# Todo: historical replay (#57)

> Plan: `tasks/replay-plan.md`. **Approved 2026-11-08 (decisions in the plan); the build starts after Monday 2026-11-09's routine review.** Gate for every task: `npm run typecheck && npm test`; focused tests: `npx vitest run replay` (in packages/core). Every task leaves production behaviour unchanged.

## Phase 1: the real code runs under a simulated clock

### T1: `SimBroker` and sim clock ✅ (2026-11-09)
**Description:** A `BrokerAdapter` over in-memory bars, a calendar and asset facts. It has a settable clock; an account (cash, equity marked to the current price); positions; orders that fill at the configured price model when the clock reaches the next fill point; FIFO-consistent activities (fills, transfers, dividends optional); and `getDailyBars` that never returns data after the clock (today's bar is partial, with open = close = today's open, until the close).

**Acceptance criteria:**
- [ ] Implements every `BrokerAdapter` method the decision path uses. `updateAccountConfig` and other calls the decision path doesn't need throw "not simulated".
- [ ] No lookahead: during the session, `getDailyBars(…, now)` ends with a partial bar of today's open; after the close, with the full bar.
- [ ] A buy (notional) or sell (qty) fills at the open ± slippage, producing an activity, an updated position and cash. A transfer adds or removes cash with an activity.

**Verification:**
- [ ] Tests: `npx vitest run replay/sim-broker` (no-lookahead, fills and slippage, transfers, positions marked to price)
- [ ] Gate green

**Dependencies:** None
**Files likely touched:** `src/replay/sim-broker.ts`, `test/replay/sim-broker.test.ts`
**Estimated scope:** Medium

### T2: Driver on synthetic data, end to end, plus the wall-clock audit ✅ (2026-11-09)
**Description:** `replay({ timeline, data, from, to, fill, limits })` creates a PGlite database with the real migrations. It walks the sessions, inserting each strategy version when the clock passes its time and applying transfers. Each session it runs the steps (09:45 sync + rebalance, 10:00 sync + rebalance, 16:15 after-close sync) through the real `syncBroker` and `runRebalance`, then returns the database for reporting. It also audits every `defaultNow()` column and `new Date()` on the decision path, and passes `now` through where a decision reads one.

**Acceptance criteria:**
- [ ] On synthetic bars, a strategy with one thesis is bought within the first session after it's inserted; a drop through its stop sells it the next session (never the same day as the buy); idle money sits in VTI.
- [ ] A replay dated in 2024 leaves only simulated timestamps on orders, fills, snapshots, thesis events and plans (a test asserts it); any seam fixed is production-neutral and tested.
- [ ] A drawdown through the limit halts the replay's trading and reports the halt date; with `autoResume` (the default for rule-based replays), trading resumes the next session and the halt is still reported.

**Verification:**
- [ ] Tests: `npx vitest run replay/driver`
- [ ] Gate green, including the existing suites (seams must not change production results)
- [ ] Note the time per simulated session

**Dependencies:** T1
**Files likely touched:** `src/replay/driver.ts`, `test/replay/driver.test.ts`, and at most a few `now` seams in `src/` (each with a test)
**Estimated scope:** Medium

## Checkpoint A
- [x] Gate green (core 623)
- [x] The synthetic end-to-end replay passes: a 2024 replay buys the thesis, stops it out on a later gap (never same-day), idles the rest in VTI, and freezes on a drawdown halt. About **28 ms per session** on the synthetic market (real data will be slower; a 7-year replay is minutes).
- [x] Found while building:
  - **SimBroker's `lastEquity`** first used today's cash; it now reports the previous close's state, as Alpaca does.
  - **Wall-clock audit:** `equity_snapshots.recorded_at` took the database clock, but the equity index splits deposits between snapshots by it, so it now takes the caller's `now`. So do `rebalance_plans.created_at`, `risk_gate_runs.ran_at` and `risk_decisions.decided_at`, for the reports. Production is unchanged (the Lambda's and database's clocks agree). `audit_events.at` and `job_runs.started_at` stay on the database clock: no decision reads them.
  - **A production finding for Scott:** `resume` doesn't re-base the drawdown peak, so after a 30% halt, `risk:resume` is re-latched at the next sync unless equity has recovered. The replay models production exactly (auto-resume re-halts daily). **Decision needed:** re-base the peak on resume (and how), or keep it.
- [x] Tell Scott: Phase 1 done (#76). **Decision (Scott, 2026-11-09): keep it** — a halt holds until the account recovers to within 30% of its peak; resume doesn't re-base the peak.

## Phase 2: replay Trader's own history (mode 1)

### T3: Market-data cache ✅ (2026-11-09)
**Description:** Fetch full daily bars (adjusted, as decimal strings), the market calendar and asset facts from Alpaca with the paper keys (market data only, read-only), cached under git-ignored `.cache/replay/` like the research cache, and load them into `SimBroker`.

**Acceptance criteria:**
- [ ] A symbol is fetched once and served from the cache after; a failed fetch retries and never caches a partial result.
- [ ] The calendar covers the replay range plus the lookback the strategies need, and symbols with no bars or no asset are listed, not silently dropped.

**Verification:**
- [ ] Tests with a fake fetch: `npx vitest run replay/data`
- [ ] Manual: load VTI and two theses for the last year, offline, the second time

**Dependencies:** T1
**Files likely touched:** `src/replay/data.ts`, `scripts/replay-data.ts` (or within `scripts/replay.ts`), `test/replay/data.test.ts`
**Estimated scope:** Small–Medium

### T4: Production timeline ✅ (2026-11-09)
**Description:** Read production's strategy versions (document, author, `created_at`) and capital flows read-only through the ops helper, into a timeline file in `.cache/replay/`. The driver replays them: each version at its time, and deposits and withdrawals as transfers. The starting cash is the first deposit.

**Acceptance criteria:**
- [x] The export is read-only (SELECTs only) and writes only to `.cache/replay/`, which is git-ignored.
- [x] Old documents that fail today's schema are replayed as the live system treated them (version 0), and listed.
- [x] Versions and transfers apply in time order, alongside the session steps.

**Verification:**
- [x] Tests on a fixture timeline: `npx vitest run replay/timeline`
- [x] Manual: export staging's timeline and replay it through T2's driver

**Done:** both timelines replay, with nothing rejected, no shortfalls and no halts, at about 66 ms per session. One gap for T6: a version submitted at midday is bought within 15 minutes live, but the next session in the replay, whose last rebalance step is 10:00. That explains each production thesis the replay holds later or not yet. Staging's extra sector ETF is a different gap: live ranks the systematic sleeve every 15 minutes, and the replay ranks it at 09:45. T6 explains both.


**Dependencies:** T2, T3
**Files likely touched:** `src/replay/timeline.ts`, `scripts/replay.ts`, `test/replay/timeline.test.ts`
**Estimated scope:** Medium

### T5: Report and `npm run replay` ✅ (2026-11-09)
**Description:** `npm run replay -w @trader/core -- --timeline production|staging|<file> [--from --to] [--fill open|close] [--slippage-bps 10]`. It prints, and writes to `.cache/replay/reports/`:
- equity vs VTI (flow-adjusted)
- the scorecard (each thesis vs the same dollars in VTI)
- trades and turnover
- realized short- and long-term gains
- wash-sale hits
- stops, staleness and review-date exits
- risk rejections and clips by rule
- halts

All of it is read from the replay database with the existing readers.

**Acceptance criteria:**
- [x] The figures come from the same readers the dashboard and digest use (`performanceSeries`, `loadScorecard`, lots), not new math.
- [x] The report states its assumptions (fill model, slippage, steps per session, daily-bar limits) and flags small samples.

**Verification:**
- [x] Tests on a synthetic replay: `npx vitest run replay/report`
- [x] Manual: `npm run replay -- --timeline staging` runs and reads well

**Done:** `src/replay/report.ts` (`replayReport`, `formatReport`) and `scripts/replay.ts`. Reports go to `.cache/replay/reports/<timeline>-<from>-<to>-<bps>bps.{txt,json}`. Two changes from the plan:
- **Midday steps.** The driver now steps at 09:45, 10:00, 12:30, 12:45 and 16:15 ET, so the routine's midday version trades the same session, as live does. Midday orders fill at the open, the only intraday price daily bars hold, and the report says so.
- **`--fill close` is left out.** Fill at the open was the decision, and a close model would also need the sim's intraday price to change. Add it with the T7 variants if wanted.

Risk reasons are grouped by their text with the figures masked, since decisions don't store a rule id. Wash-sale hits count only buys after a loss sale (within 30 days), not buys before it.

**Dependencies:** T4
**Files likely touched:** `src/replay/report.ts`, `scripts/replay.ts`, `package.json` (script), `test/replay/report.test.ts`
**Estimated scope:** Medium

### T6: Fidelity check ✅ (2026-11-09)
**Description:** Replay production's history under today's rules and compare it with what actually happened: equity path, fills (dates, prices, quantities), stops and unwinds. Explain each gap (fill price model, versions authored after 10:00, intraday stops) in a short local write-up.

**Acceptance criteria:**
- [x] The comparison is a script that can be re-run, not a one-off.
- [x] Every material gap is either explained by a stated assumption or filed as a bug.

**Verification:**
- [ ] Manual: Scott reads the write-up (kept in `.cache/replay/`, since it contains live figures; a summary without live figures can go in the PR)

**Done:**
- **The script:** `npm run replay -- --timeline <env> --compare-actual`.
- **Export:** `replay:export` now also writes what actually happened (fills, equity snapshots, thesis events), read by `readAccountHistory`, the same reader the replay's own database goes through.
- **Comparison:** `src/replay/fidelity.ts` compares the two per session, symbol and side:
  - matched;
  - shifted (within 2 sessions);
  - small (under 2% of equity);
  - unexplained (anything else, or a matched price more than 5% off).

  It also compares the equity path, the flow-adjusted return and thesis events.
- **Write-up:** in `.cache/replay/reports/fidelity-notes.md`.

**Staging result:** where the replay and live take the same decision, prices are within about 1% and sizes within 0.5%. Equity stayed within 0.4% of live every day. The gaps come from a decision near a threshold (a sector ETF at its 200-day line), which one session's price difference flips, and two live behaviours the comparison surfaced. Both are filed:
- #81: the wash-sale skip applies to VTI, the idle symbol, and cascades VTI sales in multi-name universes;
- #82: systematic buys the cash can't cover are proposed again at every step, and risk rejects each one.

Withdrawal requests aren't replayed (only completed transfers), and the report now states it.

**Production result:** every trade-day matched or was a small drift trade, with equity within 0.5% of live every day. A matched price more than 5% off now counts as explained when live traded inside the session's low–high range: on falling days, live's midday fills beat the replay's open. That fill model is the main source of the replay's small shortfall vs live.

**Dependencies:** T5
**Files likely touched:** `scripts/replay.ts` (a `--compare-actual` flag), `src/replay/report.ts`
**Estimated scope:** Small

## Checkpoint B (Scott reviews) ✅ (2026-11-09)
- [x] Gate green
- [x] Scott has read the fidelity write-up and agrees the replay is close enough to compare rules with (#80 merged, T7 approved)

## Phase 3: rule variants

### T7: Variants and the baseline-vs-variant report ✅ (2026-11-09)
**Description:** Named variants and ad-hoc ones (`--variant stop=20`, `--variant cap=10`, `--variant review-days=60`) as document transforms plus `limits` overrides. One command runs baseline and variant on identical inputs and reports the diff: return vs VTI, per-thesis outcomes, trades, turnover, taxes and stops fired.

**Acceptance criteria:**
- [x] A variant changes only what it names (a test diffs the documents), and an unknown variant is an error.
- [x] The diff report shows both sides and the difference for each headline figure, and lists the theses whose outcome changed.

**Verification:**
- [x] Tests: `npx vitest run replay/variants`
- [x] Manual: `npm run replay -- --timeline production --variant stop=20`

**Done:**
- **Variants:** `src/replay/variants.ts` provides `stop=N`, `cap=N` and `review-days=N`. They're transforms of every version's document, can be repeated, and are applied in order. An unknown variant, or a value the schema wouldn't take, is an error.
- **The diff:** `diffReports` and `formatDiff` in `report.ts` show 15 headline figures side by side, with the difference, and list the theses whose ending or return changed.
- **The command:** `npm run replay -- --timeline <env> --variant stop=20` replays both on the same market data and writes the diff and the variant's report next to the baseline's.
- **On production's week:**
  - `stop=20` and `cap=10` change nothing: no thesis fell 20%, and none was above 10%.
  - `stop=15` stops TTMI out and realizes more short-term loss.

  The machinery works; one week can't judge a rule.

**Left out: limit overrides** (for example a different drawdown halt or position cap). The jobs read `LIMITS` themselves. A replay override would need a `limits` argument on `runJob`, a new route to limits through production code, and CLAUDE.md says to ask before touching limits. The decision is the owner's; document variants cover today's rules.

**Dependencies:** T5
**Files likely touched:** `src/replay/variants.ts`, `src/replay/report.ts`, `scripts/replay.ts`, `test/replay/variants.test.ts`
**Estimated scope:** Medium

## Checkpoint C
- [x] Gate green
- [x] Scott has seen a variant diff on Trader's history
- [x] Agree that Trader's own history only proves the machinery, and move to the multi-year replay

## Phase 4: rule-based strategies (mode 2)

### T8: A rule-based timeline from the insider data
**Description:** Generate a weekly timeline from the cached insider events (#29's data): new clusters become theses at 5%, a 15% stop and a 90-day review, at most 8 at a time, with the rest in VTI. Replay 2019–2026 with auto-resume after halts. Run today's-rule variants on it (stop width, caps, review horizon), and write it up in `docs/research/` beside the backtest it extends.

**Acceptance criteria:**
- [x] The generator uses only data dated on or before each week (a test proves no lookahead).
- [x] The write-up compares the replay with the insider backtest's result and explains the difference (caps, stops, staleness, costs); it lists every halt, and how each variant changed the outcome.

**Verification:**
- [x] Tests: `npx vitest run replay/rules`
- [x] Manual: the replay finishes in reasonable time; the report is committed (about three hours a run, after keeping its database on disk; the slowness is #89)

**Dependencies:** T7
**Files likely touched:** `src/replay/rules.ts`, `scripts/replay.ts`, `test/replay/rules.test.ts`, `docs/research/insider-replay-*.md`
**Estimated scope:** Medium

## Checkpoint D
- [ ] Gate green
- [ ] Scott has read the multi-year write-up
- [ ] Next: #35's trailing stop and profit target, built in production code switched off, each with a replay variant, and judged on this replay before either is switched on

## Done
- [x] Every task above
- [x] `docs/research/README` (or the research index) says how to run a replay and what it can't tell you
- [ ] Plan and todo moved to `tasks/done/`
