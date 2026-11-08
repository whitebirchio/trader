# Tasks: thesis review dates (#35, narrowed)

> Plan: [thesis-review-plan.md](thesis-review-plan.md)
> **gate** = `npm run typecheck && npm test` (check each exit code directly). Worktree `~/src/trader-thesis-review`, branch `feat/thesis-review-date`.

### R1: Field, state, events
- [x] `strategy.ts`: optional `reviewBy` (a real calendar date, `YYYY-MM-DD`)
- [x] `theses.ts`: `overdue` state once `marketDate(now) > reviewBy` (precedence stopped > stale > overdue > stop-loss > active), with a readable reason
- [x] `rebalance.ts`: record `thesis_events` `overdue` once per version + audit `thesis.review_overdue`; `audit.ts` kind; `routing.ts` urgent; `compose.ts` email text
- [x] Tests: the state table (incl. the day of vs the day after, around midnight UTC), the unwind through targets, the event recorded once, routing coverage
- **Scope:** M

### R2: Submission rules
- [x] `submitStrategy` / `preview_strategy`: reviewBy after today; kept once set; extended only with an evidence item dated after every evidence date in the active version's thesis
- [x] Tests for each rule, including a rejection's audit/email and that the active version stays
- **Depends on:** R1 · **Scope:** M

## Checkpoint A
- [x] Gate green; on the staging deploy (2026-11-08), `preview_strategy` through the staging MCP server: a past date, a dropped date and an extension without newer evidence are rejected with the expected messages; a valid date and an extension with newer dated evidence pass

### R3: Surfaces
- [x] `get_strategy` (`reviewBy`, `daysToReview`), `get_rules` (lifecycle + rules); scorecard ending `overdue`; dashboard state labels and review dates
- **Depends on:** R1 · **Scope:** M

### R4: Prompt and docs
- [x] `agent/routine-prompt.md`; SPEC-portfolio (lifecycle), SPEC-agent; CLAUDE.md portfolio line
- **Scope:** S

## Checkpoint B
- [x] Staging v3 (paper) submitted with LLY `reviewBy` 2026-11-09; `get_strategy` shows it (`daysToReview` 1)
- [x] Tue 2026-11-10: LLY unwinds on paper (moved to `tasks/live-checks-todo.md`)
- [x] PR #46 → Scott merged → production (`get_rules` serves the review-date rules) → RemoteTrigger (2026-11-08)
