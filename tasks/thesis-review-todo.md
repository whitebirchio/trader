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
- [ ] Gate green; `rebalance:plan --env staging` with a sample strategy carrying `reviewBy`

### R3: Surfaces
- [x] `get_strategy` (`reviewBy`, `daysToReview`), `get_rules` (lifecycle + rules); scorecard ending `overdue`; dashboard state labels and review dates
- **Depends on:** R1 · **Scope:** M

### R4: Prompt and docs
- [ ] `agent/routine-prompt.md`; SPEC-portfolio (lifecycle), SPEC-agent; CLAUDE.md portfolio line
- **Scope:** S

## Checkpoint B
- [ ] Staging: a paper strategy with `reviewBy` = the next trading day unwinds the session after; email queued (suppressed)
- [ ] PR → Scott merges → production → RemoteTrigger
