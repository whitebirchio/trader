# Plan: sell on signals, and exits that get through a halt

> **Status: Built** (2026-11-10: #92, #93, #94, #96, #97; approved by Scott the same day from the insider replay's two decisions). #35's trailing stop and profit target stay switched off, by Scott's decision after the replay ([docs/research/thesis-exits-replay-2026-11.md](../../docs/research/thesis-exits-replay-2026-11.md)). Tasks: `tasks/done/exits-todo.md`.

## Why
The insider replay ([docs/research/insider-replay-2026-11.md](../../docs/research/insider-replay-2026-11.md)) raised two questions, and Scott decided both on 2026-11-10:

1. **Re-justify sooner, and don't lean on a time window.** Insider-led theses get a review date within about six weeks instead of three months. Beyond that, Scott wants Claude re-judging every position on every run and selling as soon as the signals say so, not waiting for a review date or a stop.
2. **Halts.**
   - **(A)** While the drawdown halt is on, protective sells get through: stop-loss, review-date and (later) trailing-stop exits, and full exits Claude chooses. Resizes and buys still wait.
   - **(B)** A resume re-bases the drawdown peak. After a resume the account halts again 15% below its level at the resume (or any new high since), until it's back above the old peak; then the normal 30% applies.

#35's trailing stop and profit target are the code-enforced side of (1), and a trailing stop is one more protective exit for (2A). They're built here, switched off, and judged on the replay before either is switched on.

## Decisions
- **The kill switch doesn't change.** It still freezes everything.
- **Halt-proof sells are full exits only.** A sell gets through a halt only if it takes a position to zero because its thesis closed: stopped, overdue, stale, trailing-stopped, or removed from the strategy. Risk checks that against the snapshot rather than trusting a tag, as it does for withdrawal sells. The proceeds stay in cash until the owner resumes, because buys are still blocked.
- **ADR-012 is superseded, not edited.** Its premise was a book of about 70% broad ETFs. The book is now conviction-first and up to 100% single stocks, so freezing exits holds falling single names through a crash. A new ADR records the change.
- **The re-base is stored state.** Today, `resume` clears the latch and the peak stays the all-time high of the index. The peak must still be computable after a resume: `risk_state` gains the resume's index level (an additive migration).
- **Signals are surfaced; Claude decides.** Code adds facts and flags to `get_holdings`. It doesn't sell on them, except through the explicit exits (stop, trailing stop, review date).

## Phases
1. **Instructions (T1):** six-week review for insider-led theses; re-judge every thesis every run; named sell signals. Prompt, server instructions, then a RemoteTrigger update of the routine after merge.
2. **Signals for held theses (T2):** `get_holdings` per thesis:
   - return since entry against VTI;
   - high since entry and the distance from it;
   - distance to the stop;
   - days held;
   - the eligibility screens (`freshEarningsCrash`, `recentBigLoser`, the last earnings reaction since entry);
   - a `flags` list.
3. **Halts (T3, T4):** halt-proof exits in the planner and risk (T3), then the re-based peak on resume (T4). Run on staging with a forced halt, then a new ADR, and SPEC-risk and SPEC-portfolio amendments.
4. **#35 (T5, T6):** `trailingStopPct` and `takeProfitPct`, both optional and additive to the schema, enforced by code and switched off in production. Each gets a replay variant. Judge them on the insider replay before switching either on (Scott decides).

## Not changing
Risk's other limits, the 30% halt itself, the daily 8% buy pause, the kill switch, and the routine's schedule (8:00 and 12:00 ET on weekdays).
