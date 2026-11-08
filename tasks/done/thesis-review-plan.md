# Implementation Plan: thesis review dates (#35, narrowed)

> Tasks are in [thesis-review-todo.md](thesis-review-todo.md).
> **Status: Approved** (Scott, 2026-11-08), with the open questions resolved as recommended.

## Why

The insider backtest (#29) found that insider-dip theses fade after about 60 trading days and get worse by 120. The owner's direction (2026-11-08) is to exit or re-justify such a thesis with fresh evidence by about three months, but today that lives only in the routine prompt, which Claude could forget or reason past. A **review date enforced by code** turns it into a guardrail, in the spirit of ADR-003 (code owns the discipline). SPEC-portfolio has promised "a target weight, a stop-loss, and a review date" per thesis from the start; this builds the last part.

Out of scope here (they stay on #35): trailing stops and profit targets.

## Design

- **Field:** each thesis may carry `reviewBy`, a `YYYY-MM-DD` date. It's optional and additive: existing documents stay valid, and there's no migration (strategies are JSON, and `thesis_events.kind` is text).
- **New state `overdue`:** once the market date is past `reviewBy`, the thesis is overdue. It unwinds into the systematic sleeve (VTI) exactly as a stale thesis does, and the target, planner and risk code paths are unchanged (they already act only on `active`). Precedence: stopped > stale > overdue > stop-loss > active.
- **Resubmitting doesn't clear it.** Reaffirming a thesis resets staleness, not its review date. Only a later `reviewBy`, accepted under the rules below, brings an overdue thesis back.
- **Rules at submission** (in `submitStrategy` and `preview_strategy`, which know today's date and the active version):
  1. `reviewBy` must be after today.
  2. **Once set, it stays.** A thesis id that had a review date can't drop it.
  3. **Extending needs fresh evidence.** Moving `reviewBy` later requires at least one evidence item dated (`asOf`) after every evidence date in the active version of that thesis. This is a code-checkable stand-in for "re-justified with fresh evidence".
  4. A rejected submission leaves the previous version active and is emailed, as today.
- **Events and email:** the first rebalance step that sees a thesis overdue records `thesis_events` kind `overdue` and audits `thesis.review_overdue`, routed **urgent**: "Thesis unwound: X (review date passed)".
- **Surfaces:**
  - `get_strategy`: each thesis's `reviewBy` and days until it.
  - `get_rules`: the lifecycle line and the three rules.
  - Scorecard: `overdue` is an ending, like `stale`.
  - Dashboard: the holdings and strategy pages show the review date and the overdue state.
- **Routine prompt:**
  - Set `reviewBy` on every insider-dip thesis, at most about three months after its first buy; existing ones get theirs on the next submission.
  - Use it for any thesis with a dated catalyst.
  - Extending needs new, dated evidence.

## Task list

- [ ] R1: `reviewBy` in the schema; the `overdue` state; rebalance records it; urgent email (pure + rebalance tests)
- [ ] R2: The submission rules (future date, keep once set, extend only with fresh evidence), in `submitStrategy` and `preview_strategy`
- **Checkpoint A:** gate green; `rebalance:plan` on staging with a sample strategy
- [ ] R3: Surfaces: `get_strategy`, `get_rules`, scorecard ending, dashboard
- [ ] R4: Routine prompt, SPEC-portfolio/SPEC-agent, CLAUDE.md line
- **Checkpoint B:** staging deploy: submit a paper strategy with `reviewBy` = the next trading day and confirm it unwinds the session after (and the email is queued, suppressed on staging)
- PR → Scott merges → production → RemoteTrigger; the next routine run sets review dates on the insider-dip theses

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A thesis unwinds unexpectedly in production | Med: an unplanned sale | Optional field; only theses Claude dates are affected; urgent email; paper soak first |
| Claude dodges by never setting it | Med | Prompt requires it for insider-dip theses; rule 2 stops it being removed once set |
| The fresh-evidence rule blocks a legitimate extension | Low | The rejection names the rule; adding the new dated source is what the owner wants anyway |
| Timezone edge (the review date is a market date) | Low | Compare New York market dates (`marketDate`), tested around midnight UTC |

## Resolved questions (Scott, 2026-11-08, as recommended)

1. **The prompt requires review dates on insider-dip theses;** code doesn't (it can't tell them apart). Rule 2 keeps a date once set.
2. **Extending needs fresh evidence** (rule 3).
3. **`overdue` emails are urgent,** like `stale`.
