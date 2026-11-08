# Implementation Plan: thesis scorecard (#27)

> Implements the *Scorecard* section of [SPEC-portfolio.md](../SPEC-portfolio.md) (approved 2026-11-07). Tasks are in [scorecard-todo.md](scorecard-todo.md).
> **Status: Approved** (Scott, 2026-11-07), with the open questions resolved as recommended.

## Context

Nothing measures whether a thesis worked. The account-level numbers mix every thesis with the idle VTI money. After one live week (v11), Trader is −4.18% vs VTI's −2.59%, and all seven theses are the same bet: insider buying after a sell-off. The scorecard gives Claude (through MCP) and Scott (on the dashboard) each thesis's return against the same dollars held in VTI, rolled up by signal kind.

## Facts confirmed during planning (2026-11-07, read-only)

- **Every input already exists:** `strategies` (full documents per version), `thesis_events` (`stopped`, `stale`), `broker_activities` (`FILL` with symbol/side/qty/price, `DIV` with net amount), `positions.current_price`, and `benchmark_closes` (VTI, adjusted). **No migration.**
- `trader_dashboard` has `GRANT SELECT ON ALL TABLES` (`packages/core/scripts/dashboard-role.ts:61`), so the dashboard can read the loader's tables with no grant change.
- `orders.strategy_ref` / `intent_key` exist, but manual orders have neither. Attribution therefore uses **time windows over fills**, not order tags, so every fill is covered.
- Old strategy documents may no longer validate (`strategy-show.ts` throws on this). The scorecard reads past versions **leniently**.
- `capital/shadow.ts` already prices "the same money in VTI" at the last close on or before a market date. The scorecard follows the same convention.
- The MCP tool list is pinned by `apps/mcp/test/server.test.ts:225`. Adding a tool updates that pin on purpose, and `submit_strategy` stays the only write.
- The routine prompt in claude.ai is a copy. After `agent/routine-prompt.md` changes and deploys, update the routine with RemoteTrigger.

## Architecture decisions

- **Computed on read, never stored**, the same way `buildLots` rebuilds lots from fills. A fix to the math fixes history, and there's no new state to audit.
- **Pure core + thin loader.** `portfolio/scorecard.ts` holds the pure functions (`thesisWindows`, `scoreTheses`, `rollUp`). `loadScorecard(db)` reads the five tables. The MCP tool, the dashboard view and the CLI all call `loadScorecard`.
- **Return on dollars bought vs a same-dollars VTI shadow.** It's simple, exact for buy-and-hold, and matches the money-weighted comparison Scott already reads. A per-thesis time-weighted return was rejected because it needs daily prices for every thesis symbol, which the DB doesn't hold.
- **Same-symbol successor theses merge into one row.** Splitting a held position between two ids would invent a sale.
- Money stays decimal strings with `Big`, and rounding is explicit (ADR-009).

## Dependency graph

```
S1 windows + attribution (pure) ─▶ S2 money + roll-ups (pure) ─▶ S3 loadScorecard + scorecard:show
                                                                    │
                                          ┌─────────────────────────┼──────────────────────┐
                                          ▼                         ▼                      ▼
                                 S4 get_track_record tool   S6 dashboard page     (S7 docs, last)
                                          │
                                          ▼
                                 S5 routine prompt + RemoteTrigger
```

S4 and S6 are independent once S3 lands.

## Task list (detail in the todo)

### Phase 1: Core (PR, branch `feat/scorecard` from pulled `main`)
- [ ] S1: Thesis windows and fill attribution (pure)
- [ ] S2: Returns vs the VTI shadow, and roll-ups (pure)
- [ ] S3: `loadScorecard(db)` + `scorecard:show` CLI

### Checkpoint A: real numbers
- [ ] Gate green
- [ ] `scorecard:show --env production` (read-only) against the live history: every v1–v11 thesis has a row, and the open rows' qty matches `get_holdings`. One row recomputed by hand from Alpaca fills matches to the cent.
- [ ] Scott reviews the numbers before any surface is built

### Phase 2: Surfaces (same PR)
- [ ] S4: `get_track_record` MCP tool
- [ ] S5: Routine prompt and server instructions
- [ ] S6: Dashboard *Track record* page

### Checkpoint B: staging
- [ ] Gate green · `npm run synth` clean · staging deploy
- [ ] `get_track_record` through the Trader Staging connector; the dashboard page on trader-staging

### Phase 3: Ship
- [ ] S7: Living specs, `CLAUDE.md` line, close #27
- [ ] PR → merge → production: `get_track_record` on the production connector; RemoteTrigger updates the routine; the next routine run cites it

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Attribution edge cases (successor ids, sell-outs after removal, stale unwinds) mis-assign fills | High: wrong numbers mislead Claude's sizing | S1 is all fixtures over those cases; Checkpoint A reconciles against live fills by hand |
| Small samples (7 theses, days old) get over-fit by Claude | Med | The tool returns counts and days held; the prompt says a few rows are noise |
| VTI priced at the close, not at the fill minute | Low: a few bps per trade | Documented in the spec; consistent with `capitalSummary` |
| Loader cost grows with history | Low: hundreds of fills | One pass over sorted rows; revisit only if `job_runs`/MCP latency shows it |
| Old documents fail today's schema | Med: a crash would hide the whole scorecard | Lenient reader with a test on a deliberately invalid old document |

## Resolved questions (Scott, 2026-11-07, as recommended)

1. **Measure:** return on dollars bought vs a same-dollars VTI shadow.
2. **Same-symbol successor theses** merge into one row.
3. **Roll-up key:** the primary kind (most frequent evidence kind, ties to the earliest listed).
4. **Only the new tool;** `get_overview` is unchanged, and the prompt tells the routine to call `get_track_record`.
