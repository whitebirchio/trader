# Plan: the weekly letter (#38)

> **Status: Approved** (Scott, 2026-11-08, as the next build after #54). Small to medium; tasks inline. The first letter goes out Fri 2026-11-13: the first full week under the 2026-11-08 rules.

## Why
Scott made a lot of strategy decisions on 2026-11-08 (insider buying as support only, a higher evidence bar, review dates, the earnings-crash and recent-big-loser screens). The daily digest says what traded; a Friday letter should say **whether it's working**: performance vs VTI for the week and since the start, how the theses are doing against the same dollars in VTI, what opened and closed and why, and what's coming up.

## What the letter says
- **Performance:** the week's flow-adjusted return vs VTI's over the same days, and since inception (the digest's figures).
- **Track record:** the scorecard's overall and by-kind roll-ups (`loadScorecard`), plus each thesis opened or closed this week, with how it ended.
- **This week's decisions:** each strategy version activated this week, with the first line of its summary (where Claude says what changed and why), and automatic exits (stops, stale, overdue).
- **Coming up:** review dates in the next 14 days, from the active strategy.
- **Guardrails:** kill switch, halt and drawdown, as in the digest.

## Design
- **When:** a `notify-weekly` tick job. On the **last trading day of the week** (the next session is in a later week, from Alpaca's calendar), from the digest's time after the close. Holiday weeks still get a letter on their last session.
- **Idempotent per week:** a new nullable unique column `notifications.week_of` (the week's Monday date). An **additive** migration: the daily digest keeps its `digest_date` key, so Friday's digest and letter don't collide. The outbox gains type `weekly`, and staging suppresses it like every non-test email.
- **Pure core:** `composeWeekly(data)` in `notifications/compose.ts`; the data comes from existing readers (equity snapshots + VTI closes for the week, `benchmarkSince`, `loadScorecard`, `strategies`, `thesis_events`, the active strategy's review dates).
- **Preview:** `notify:preview -- --weekly` prints the letter for an environment without sending, so it can be checked on real data before Friday.
- **Routing:** no new audit kind; the letter is a composed notification, like the digest.

## Tasks
- [x] W1: Migration (`week_of`) + outbox type `weekly`; the `isLastSessionOfWeek` helper from the calendar (tests)
- [x] W2: `composeWeekly` + its data loader (tests: a normal week, a holiday week, a quiet week, an overdue exit)
- [x] W3: `notify-weekly` job in `TICK_JOBS` (idempotent per week; skipped on other days; tests) + `notify:preview --weekly`
- [ ] W4: SPEC-notifications, CLAUDE.md line; gate; staging deploy; preview on staging and production data
- [ ] Merge → the first letter, Fri 2026-11-13 after the close
