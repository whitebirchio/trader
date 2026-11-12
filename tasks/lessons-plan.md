# Plan: exit post-mortems (#28)

> **Status: Built** (2026-11-12, one PR; the live check is the first run after merge writing ROL's lesson). Scott approved the new write tool, `record_lesson`, on 2026-11-12. Spec: SPEC-agent § Lessons.

## Why
`get_track_record` says which theses beat VTI and which didn't, but not why. Each run starts cold: nothing carries forward "I bought ROL on a family buy and the business case was thin". The bear case (#106) argues before buying; a post-mortem checks the argument after selling. Over time Claude can see whether its bear cases called it, and lean away from mistakes it has made before on the same stock or the same kind of signal.

## Decisions
- **A separate write tool, not a strategy field** (Scott, 2026-11-12). A `postMortems[]` field would force a strategy version just to record a lesson, and tie lessons to versions. This is the `update_watchlist` pattern: insert-only rows, no trading effect, one audit event per call, reported in the digest.
- **Only a closed thesis gets a lesson:** its scorecard row has `closedAt` (the position is flat after the thesis left), so the outcome is final. However it ended counts: stopped, removed, stale, overdue, trailing-stopped, took profit.
- **The outcome is frozen with the lesson:** ending, days held, and return, VTI's and the excess (%) as the scorecard had them when it was written. A later reader sees what the lesson was judged against.
- **A thesis can be re-lessoned:** a later row for the same thesis replaces it (latest wins), as a watchlist note does. Rows are never changed.
- **Served back where decisions are made:**
  - `get_track_record`: each closed row's `lesson`, and `lessonsDue` (closed theses without one, with the last strategy version that listed each, for `get_strategy`).
  - `check_eligibility`: per symbol, `pastLessons` (the latest lesson for each past thesis on it, newest first, up to 3).
- **Noise is named:** the prompt says a lesson from a short hold (days, not weeks) is weak evidence, and to separate judgement from luck.
- **No dashboard work in this plan.** The thesis page can show the lesson later; the digest covers the owner for now.

## Tasks
- [x] **L1. Core: table and tool.**
  - `thesis_lessons` (migration `0028`): id, thesis_id, symbol, primary_kind, ending, expected, happened, lesson, outcome jsonb, actor, at. Insert-only (the `reject_mutation` triggers), `REVOKE UPDATE, DELETE, TRUNCATE` from `trader_app`, `GRANT INSERT` to `trader_mcp` (and `scripts/mcp-role.ts`'s `WRITES`).
  - `src/agent/lessons.ts`: `recordLessons(db, input, actor, now)`: a batch of 1–10, all or nothing. Each: `thesisId`, `expected`, `happened`, `lesson` (20–600 characters each). Rejects an unknown id, a thesis still open or still holding shares, and a duplicate in the batch. One `lessons.recorded` audit event per batch.
  - `latestLessons(db)`: the latest per thesis id.
  - **Accept:** tests for each rejection, the frozen outcome, latest-wins, and the insert-only trigger.
- [x] **L2. Reads.**
  - `getTrackRecord`: `lesson` on each row (null if none), and `lessonsDue`.
  - `checkEligibility`: `pastLessons` per symbol.
  - **Accept:** tests on both, including a thesis whose window spans two ids (a lesson on either id belongs to the row).
- [x] **L3. MCP and notifications.**
  - `record_lesson` in `apps/mcp/src/tools.ts` (`readOnly: false`), with the tool-list pin updated; server instructions (`instructions.ts`) mention it.
  - Routing: `lessons.recorded` → digest, with a "Lessons" section (symbol, ending, the lesson line).
  - **Accept:** MCP tool tests; routing and compose tests.
- [x] **L4. The prompt.**
  - Orient: after `get_track_record`, write a lesson for each `lessonsDue` thesis: re-read its last version (`get_strategy` with that version) and its bear case; say what was expected, what happened, and what to do differently; a short hold is weak evidence; separate judgement from luck.
  - Research: read `pastLessons` on every candidate, and the lessons on theses of the same main signal, before drafting. Say in the summary when one shaped a decision.
  - Ships with the merge (#118): no routine update.
- [x] **L5. Docs.** SPEC-agent (the tools table and § Lessons), SPEC-notifications (the routing row), CAPABILITY-MAP if it lists the tools.

## Verification
- **Gate:** `npm run typecheck && npm test`.
- **Migration:** CI's `migrate-check` on the branch.
- **After merge:**
  - `db:mcp-role -- --check` shows the new INSERT grant.
  - The next routine run should find ROL (removed 2026-11-10) in `lessonsDue`, write its lesson, and the digest should show it.
  - `get_track_record` shows the lesson, and `lessonsDue` is empty afterwards.

## Not changing
`submit_strategy`, risk, the scorecard's numbers, the schedule. Lessons have no trading effect.
