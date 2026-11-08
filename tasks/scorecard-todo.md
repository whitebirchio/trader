# Tasks: thesis scorecard (#27)

> Plan: [scorecard-plan.md](scorecard-plan.md) · Spec: [SPEC-portfolio.md § Scorecard](../SPEC-portfolio.md)
> **gate** = `npm run typecheck && npm test`. Focused: `npx vitest run scorecard` (in `packages/core`). One PR from `feat/scorecard`, cut from pulled `main`.

## Phase 1: Core

### S1: Thesis windows and fill attribution (pure)
- [ ] `thesisWindows(versions, events, fills)`: per thesis id → `{ ids[], symbol, openedAt, leftAt?, closedAt?, ending: open | removed | stopped | stale, unscored? }`, with versions read leniently (id, symbol, targetWeightPct, evidence kinds)
- [ ] Fills of the symbol from `openedAt` until flat after `leftAt` belong to the row; a same-symbol successor opened before flat merges into it
- [ ] Unscored with a reason: symbol already held at open; a `buildLots` issue for the symbol
- [ ] Fixtures: buy-and-hold open; resized twice; removed then sold the next day; stopped (event) then sold; stale unwind; successor id; inherited position; a version that fails today's schema; a fill outside every window is ignored
- **Files:** `packages/core/src/portfolio/scorecard.ts`, `packages/core/test/portfolio/scorecard.test.ts` · **Depends on:** — · **Scope:** M

### S2: Returns vs the VTI shadow, and roll-ups (pure)
- [ ] `scoreTheses(windows, fills, dividends, marks, vtiCloses)`: bought, proceeds, dividends, marketValue, pnl, vtiPnl, excess, returnPct / vtiPct / excessPct, daysHeld, primaryKind
- [ ] The shadow buys VTI at the buy day's close and sells the same fraction as each thesis sell; open rows marked at `markedAt`
- [ ] `rollUp(rows)`: overall + by primary kind (count, closed, Σ bought, Σ pnl, Σ vtiPnl, excess $/%, beat-VTI share, median days held); unscored rows counted but excluded from sums
- [ ] Tests: hand-computed examples to the cent (one up, one down, one with a dividend, a partial sell); primary-kind tie-break; all money is decimal strings
- **Files:** `packages/core/src/portfolio/scorecard.ts`, `packages/core/test/portfolio/scorecard.test.ts` · **Depends on:** S1 · **Scope:** M

### S3: `loadScorecard(db)` + `scorecard:show`
- [ ] `loadScorecard(db)` reads `strategies`, `thesis_events`, `broker_activities` (FILL, DIV), `positions`, `benchmark_closes` and returns `{ markedAt, overall, byKind, theses }`; exported from `@trader/core`
- [ ] PGlite test: seeded versions + fills + closes → the expected rows
- [ ] `scripts/scorecard-show.ts` (`npm run scorecard:show -w @trader/core -- --env …`), read-only, through `withOps`
- **Files:** `src/portfolio/scorecard.ts`, `src/index.ts`, `scripts/scorecard-show.ts`, `package.json`, test · **Depends on:** S2 · **Scope:** S

## Checkpoint A: real numbers
- [ ] Gate green
- [ ] `scorecard:show --env production`: a row for every thesis in v1–v11; open-row qty = `get_holdings`; one row reconciled by hand against Alpaca fills
- [ ] Scott reviews the numbers (and the plan's open questions) before Phase 2

## Phase 2: Surfaces

### S4: `get_track_record` MCP tool
- [ ] `getTrackRecord({ db })` in `src/agent/tools.ts` (rows newest first; theses' full text left out)
- [ ] Registered in `apps/mcp/src/tools.ts` as read-only, with a description that says what the numbers mean and that small samples are noise
- [ ] The pinned tool list in `apps/mcp/test/server.test.ts` gains it; `submit_strategy` is still the only write
- **Files:** `packages/core/src/agent/tools.ts`, `apps/mcp/src/tools.ts`, `apps/mcp/test/server.test.ts`, core tool test · **Depends on:** S3 · **Scope:** S

### S5: Routine prompt and server instructions
- [ ] `agent/routine-prompt.md`: *Orient* calls `get_track_record`; *Decide* weighs which signal kinds have beaten VTI, with a caution on small samples
- [ ] `apps/mcp/src/instructions.ts`: one line on the tool
- [ ] After deploy: update the claude.ai routine with RemoteTrigger (the prompt there is a copy)
- **Files:** `agent/routine-prompt.md`, `apps/mcp/src/instructions.ts` · **Depends on:** S4 · **Scope:** XS

### S6: Dashboard *Track record* page
- [ ] `trackRecordView(db)` in `src/dashboard/views.ts` (wraps `loadScorecard`)
- [ ] `apps/dashboard/src/app/(signed-in)/track-record/page.tsx`: overall card, a by-kind table, and a theses table (symbol, ids, opened, days, ending, return, VTI, excess); a nav link in the signed-in layout
- [ ] View test (PGlite); the page renders with no rows ("No theses yet")
- **Files:** `src/dashboard/views.ts`, `apps/dashboard/src/app/(signed-in)/track-record/page.tsx`, `apps/dashboard/src/app/(signed-in)/layout.tsx`, test · **Depends on:** S3 · **Scope:** M

## Checkpoint B: staging
- [ ] Gate green · `npm run synth` clean · push → staging deploy
- [ ] `get_track_record` through the Trader Staging connector
- [ ] The *Track record* page on trader-staging.whitebirch.io

## Phase 3: Ship

### S7: Docs
- [ ] SPEC-portfolio *Scorecard* status → Built; SPEC-agent tools table; SPEC-dashboard pages; `CLAUDE.md` portfolio line
- **Depends on:** S4–S6 · **Scope:** XS

- [ ] PR → **Scott merges** → production: tool on the production connector, page on trader.whitebirch.io
- [ ] RemoteTrigger: routine prompt updated; the next routine run's summary cites the track record
- [ ] Close #27
