# Plan: event-triggered runs (#36)

> **Status: In progress** (PR 1 built; plan approved by Scott 2026-11-18; spec approved by Scott 2026-11-18: SPEC-agent § Event-triggered runs, approved as written). Two PRs, in order.

## Why
Claude judges the book at 8:00 and 12:00 ET only. A stop is judged on the close and sold the next morning, so a holding sliding toward its stop in the afternoon is settled by the rule, not by Claude. The engine can now start a run (#127), so it can wake Claude when a holding needs judging.

## Decisions
- **Detection ships first, firing second.** PR 1 records `events.tripped` and fires nothing: the spec's no-token mode, on purpose. A few sessions of trips in the digest show how often each trigger would fire, and whether 3% and 8% are sensible, before any Opus run is spent. PR 2 adds firing and the prompt. PR 2 can be built straight after PR 1, and merged once PR 1's trips look sane.
- **"Covered" is a submission, not a time window.** A trip is pending until any Claude submission (`strategy.activated` or `strategy.rejected`) lands after it. A scheduled run that finished before the trip doesn't cover it; one that submits after it does. This replaces the spec's fixed "45 minutes after a scheduled run" quiet period with what that period approximated: the run read the same holdings.
  - The spec's other waits stay. No fire within 30 minutes before a scheduled slot, since that run will cover it. None while a scheduled run is in progress, meaning fired up to 45 minutes ago with no submission yet.
- **One stop calculation.** `held.ts` computes the stop price and the distance above it for `get_holdings`. It moves to one exported helper that both use. `get_holdings`' own `near_stop` flag stays at 5%; the trigger is 3% (`EVENT_RUNS.nearStopPct`).
- **Average cost comes from the open lots**, as the stop rule's does (`loadLedger`), not from Alpaca's `avg_entry_price`.
- **Detection runs all session** (9:30–16:00 on the calendar's hours), on every tick after `sync-broker` and `check-filings`. Only firing has a window (9:45 to close − 75 minutes).
- **A trip that can't fire stays pending** through the day: outside the window, at the cap, or within the 60-minute gap. It fires at the next allowed tick if nothing has covered it. It expires at the end of the day.

## PR 1: detection (no firing)
- [x] **E1. `findTriggers` (pure), `src/agent/events.ts`.**
  - `EVENT_RUNS = { nearStopPct: "3", movePct: "8", maxPerDay: 2, minGapMinutes: 60, firstEt: "09:45", lastBeforeCloseMinutes: 75, inProgressMinutes: 45, beforeSlotMinutes: 30 }`.
  - Inputs: the active strategy's theses, average cost per symbol (open lots), latest price (`positions`), previous session's close (`thesis_closes`, latest date before today), today's `filing.sell_signal` events, and symbols bought today (`roundTripBlocks(...).sell`).
  - Returns `Tripped[]`: `{ symbol, thesisId, trigger: "near_stop" | "move" | "sell_filing", price, reference, distancePct, detail }`.
  - Shared stop helper: `stopLossPrice(averageCost, stopLossPct)` in `theses.ts`, used by the stop rule, `held.ts` and the trigger. *(Built: trailing stops are off (`EXIT_RULES`), so only the stop-loss is watched; turning trailing stops on should add them here.)*
  - **Accept:**
    - near stop at exactly 3% (trips) and 3.01% (doesn't);
    - moves of +8%, −8% and 7.99%;
    - a sell filing on a held name trips, but not on a watchlist name;
    - a name bought today skips price triggers but not a filing;
    - VTI and systematic holdings never trip;
    - no previous close means no move trigger.
- [x] **E2. `checkEvents(db, broker, now)` records trips.**
  - On a trading day, during the session, it records **`events.tripped`** for each new (date, symbol, trigger). Subject `<date>#<symbol>#<trigger>`; a unique check against today's rows makes it once a day.
  - Payload: price, reference (stop or previous close), distance, thesis id, and for filings the form and summary.
  - Result: `{ status: "checked", tripped: [...new], pending: n } | { status: "skipped", reason }`.
  - Routing: `events.tripped` → digest. The digest gets a short "Watch" line per trip: "TTMI 2.1% above its stop at 1:40 PM ET".
  - **Accept:**
    - PGlite tests: once per (symbol, trigger) per day;
    - a holiday, and before the open, skip;
    - a kill switch still records (only firing skips);
    - routing and compose tests.
- [x] **E3. Job.** `check-events` in `JOBS` and `TICK_JOBS` after `check-filings` and before `check-routine` and the notify jobs. The `TICK_JOBS` order is pinned in `jobs.test.ts`. `apps/lambda` needs nothing until PR 2.
- [x] **E4. `events:status`** (read-only, `trader_readonly`; inputs from `loadTriggerInput`, the same loader as `checkEvents`, and `watchStatus`). For each held thesis it prints the price, its stop and distance, and the move from the previous close against the triggers. It also prints today's trips, and in PR 2 today's event runs.
  - **Accept:** script runs against the paper database; the CLAUDE.md commands list gets it and `invoke --jobs check-events`.
- [x] **E5. Docs:** SPEC-agent status (PR 1 built), SPEC-notifications (the new kind), the plan ticked.

## PR 2: firing and the prompt
- [ ] **E6. Firing in `checkEvents(db, broker, now, firer?)`.**
  - **Pending trips:** today's `events.tripped` not covered by a later submission and not named in an earlier `routine.event_run`.
  - **Fire only if all of these hold:**
    - inside 9:45 to close − 75 minutes (half days from the calendar);
    - not within 30 minutes before a scheduled slot;
    - no scheduled run in progress;
    - fewer than `maxPerDay` event runs today;
    - 60 minutes since the last one;
    - no kill switch.
  - **One run per tick** carries every pending trip.
  - **Claim, fire, record:** `routine.event_run` (subject `<date>#<n>`, payload: trigger id, trips, text) before the call. Then `routine.event_run_result` with the `FireResult`, never the token. A refused fire isn't retried.
  - `eventRunText(trips, now)`: one paragraph starting "Event run:", naming each holding with its figures, ending "Judge these first (agent/routine-prompt.md § Event runs)."
  - Fires the 8:00 routine (`ROUTINES[0]`), Opus.
  - **Accept:**
    - fires once with every pending trip, claim first;
    - a redelivered tick doesn't fire twice;
    - the cap and the gap;
    - the window edges, a half day, near a slot, and a run in progress;
    - a scheduled run's submission after the trip covers it;
    - the kill switch skips firing, but a halt doesn't;
    - with no firer, behaviour is PR 1's;
    - a refused fire is recorded and not retried.
- [ ] **E7. Notifications.**
  - `routine.event_run` and `routine.event_run_result` → digest.
  - Digest "Event run" line: the time, the trips, and the next Claude version's headline ("v24: exited TTMI …").
  - The `filing.sell_signal` urgent email adds "An event run was started at 10:15 ET" when one was claimed for that symbol before the email was composed. `check-events` runs before `notify-urgent` in the tick, so same-tick claims count.
  - **Accept:** compose and routing tests.
- [ ] **E8. Lambda.** `checkEventsJob` passes `JobDeps.routineFirer`, which is already built from `ROUTINE_FIRE_TOKENS`. Handler test with the fake firer.
- [ ] **E9. Prompt.** An *Event runs* section in `agent/routine-prompt.md`:
  - for runs whose text starts "Event run:";
  - orient;
  - research the named holdings first;
  - decide each: exit, trim, or hold with a sentence on why;
  - check for a shared failure across the book;
  - preview, submit, and lead the summary with the decision;
  - no new-idea search;
  - never widen a stop because the price is near it.

  It ships on merge.
- [ ] **E10. Docs.**
  - SPEC-agent → Built;
  - SPEC-notifications;
  - CLAUDE.md;
  - docs/SETUP.md, in the "A research run is missed" section: event runs use the same token.

## Verification
- **Gate** before each commit: `npm run typecheck && npm test`.
- **No paper rehearsal needed:** nothing in `src/broker/`, `src/risk/`, `rebalance.ts` or the order intents changes. `events:status --env paper` exercises the reads.
- **PR 1 live:**
  - `invoke --jobs check-events` returns `checked` on a trading day;
  - `events:status --env production` prints each holding's distances;
  - the digests over the next sessions show any trips;
  - Claude-side behaviour is unchanged.
- **PR 2 live:**
  - `routine:fire --routine 8:00 --dry-run --text "Event run: …"` prints the request;
  - the first real event run's session shows the text;
  - it submits, with the decision in the summary's first line;
  - the digest shows the run line.

## Not changing
Risk limits, the stop rule, sizing and the order path. An event changes nothing by itself: only Claude's submission does (ADR-003, ADR-011).
