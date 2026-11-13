# Plan: the forecast ledger and a declared lead signal

> **Status: Built** (PR 1 #126, PR 2 #128, PR 3 built; live checks below) (spec approved by Scott 2026-11-13: SPEC-portfolio § Forecast ledger). Three PRs, in order. The higher position-cap tier is not in this plan.

## Why
Every tested signal failed to beat VTI on its own, so Trader's bet is Claude's judgment, and P&L can't measure that for years. Forecasts on theses and on the names Claude passes on can show calibration and selection skill within months. The scorecard's inferred signal kind mislabels insider-origin theses as "fundamental", so each thesis declares its lead signal.

## Decisions
- **Required on every thesis in every submission** (`leadSignal`, `forecast`), refused by Claude's tools the way a missing bear case is. Each version restates the whole document, so "required on new theses plus a backfill" reduces to "required on all". Optional in the schema, so stored versions still load.
- **Backfilled is derived, not declared:** a thesis's scored forecast is the first one stated for its id. If that version is later than the thesis's first listing, it's `backfilled`, kept out of the headline score.
- **The prompt ships in the same PR as each tool change** (#118 makes it live on the next run). A tool that refuses a field the prompt hasn't asked for would cost a run.
- **Closes for forecast symbols go in `benchmark_closes`** (already keyed by symbol), written by the after-close sync. No new table. That change is in `src/broker/`, so PR 2 gets a paper rehearsal.
- **Computed on read** (`src/portfolio/forecasts.ts`), like the scorecard.

## PR 1: lead signal and thesis forecasts (write side)
- [x] **F1. Lead signal.**
  - `strategy.ts`: optional `leadSignal: z.enum(EVIDENCE_KINDS)`; refine: matches some `evidence[].kind`.
  - `theses.ts`: `leadSignalErrors(next)`: each thesis without one, naming it. `store.ts` adds it beside `bearCaseErrors` under the tools' option.
  - `scorecard.ts`: roll up by the last listing's `leadSignal`, falling back to `primaryKind`; each row gets `kindSource: "declared" | "inferred"`.
  - **Accept:** schema tests (mismatch refused, old documents load); tool refusal test; scorecard test with one declared and one inferred row.
- [x] **F2. Thesis forecasts.**
  - `strategy.ts`: optional `forecast: { beatVtiPct: int 5–95, expectedExcessPct: decimal −50..200, horizon?: date }`; horizon defaults to `reviewBy` and may not be later than it; a forecast needs a horizon or a `reviewBy`.
  - `theses.ts`: `forecastErrors(next)`; wired in `store.ts` with the others.
  - **Accept:** bounds, horizon ≤ reviewBy, the default, the refusal, old documents still load.
- [x] **F3. Prompt, rules and MCP.**
  - `agent/routine-prompt.md`: thesis standards gain **Lead signal** (what surfaced the idea and carries the case; #125's 3b uses it) and **Forecast** (chance of beating VTI by the horizon, from the 45% base rate; 70%+ is a strong claim; honest, not a sizing rule; state it once, later restatements aren't scored).
  - `get_rules` sections; `STRATEGY_JSON_SCHEMA` picks the fields up; `apps/mcp` pins.
  - **Accept:** MCP tests; the gate.

## PR 2: the ledger
- [x] **F4. Closes for forecast symbols.**
  - `src/broker/thesis-closes.ts`: `recordThesisCloses` (after the close) also keeps every name ever on the watchlist, beside the thesis symbols it already did; VTI stays in `benchmark_closes`.
  - **Accept:** sync test with a fake broker; **paper rehearsal:** `broker:sync --env paper --force`, then the closes are in the local paper database.
- [x] **F5. Watchlist forecasts.**
  - Migration `0029`: nullable `beat_vti_pct`, `expected_excess_pct`, `horizon` on `watchlist_notes` (trader_mcp's INSERT already covers them).
  - `watchlist.ts`: the `watch` action takes the three fields, required on a new watch (not on an update of a watched name), horizon defaulting to `revisitBy`, at most 120 days out. `readWatchlist` returns them.
  - `apps/mcp` `update_watchlist` schema and pin.
  - **Accept:** migration applies (`migrate-check`); tests for required-on-new, optional-on-update, the default.
- [x] **F6. Scoring.**
  - `src/portfolio/forecasts.ts`: collect scored forecasts (each thesis id's first stated, with `backfilled`; each watchlist run's first watch); resolve from recorded closes (a horizon on a holiday rolls to the next session); Brier, skill vs 45%, buckets (5–34, 35–49, 50–64, 65–95), expected vs realized excess (correlation from 20 resolved); "too few to judge" below 30; bought vs passed at 20 and 60 trading days with standard errors.
  - **Accept:** hand-computed Brier and skill; a forecast that beat, one that missed, one unresolved; a holiday horizon; first-forecast-only; backfilled excluded from the headline; yardsticks.
- [x] **F7. Reads and prompt.**
  - `getTrackRecord` gains `forecasts`; `scorecard:show` prints it.
  - Prompt: Orient reads the calibration and says if it leans one way; the watchlist step states a forecast on each new name.
  - **Accept:** tool test; MCP pin; the gate.

## PR 3: the owner's view
- [x] **F8. Dashboard and letter.**
  - Dashboard Track record page: a Forecasts section (reliability table, bought vs passed, open forecasts, and the latest 10 resolved). The report gains `resolved` (latest first) and a `backfilled` flag on `open`.
  - Weekly letter: one line (resolved this week, running skill score or "too few to judge").
  - **Accept:** view and compose tests; `mobile:check` on the page (pointed at production's read-only data: staging's parameters went with ADR-018).
- [x] **F9. Docs.** SPEC-portfolio § Forecast ledger → Built; SPEC-agent tools table and prompt notes; SPEC-dashboard; SPEC-notifications (the letter line).

## Verification
- **Gate** before each commit: `npm run typecheck && npm test`.
- **PR 1 live:** the next run declares a lead signal and a forecast on every live thesis (all `backfilled`), and is accepted on the first submit. `get_track_record`'s by-kind roll-up shows `declared`.
- **PR 2 live:** `db:mcp-role -- --check` unchanged and passing (2026-11-13: passed); after the next close, `thesis_closes` holds the forecast symbols; new watchlist names carry forecasts; `get_track_record.forecasts` reports "too few to judge".
- **PR 3 live:** the dashboard section renders on phone and laptop; Friday's letter has the line.

## Not changing
Risk limits, sizing, the order path, the 20% cap. Forecasts move no money in this plan.
