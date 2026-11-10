# Todo: sell on signals, and exits that get through a halt

> Plan: `tasks/exits-plan.md`. Gate for every task: `npm run typecheck && npm test`. Risk changes run on staging (paper) before they reach `main`.

### T1: Re-judge every thesis every run; six-week review for insider-led theses
- [x] `agent/routine-prompt.md`: the owner's direction of 2026-11-10; sell signals for current theses; review dates are a backstop.
- [x] `apps/mcp/src/instructions.ts`: the same, in brief.
- [ ] After merge: update the routine through RemoteTrigger (the prompt is a copy).
- [ ] The next routine runs re-judge each thesis in their summaries.

### T2: Signals for held theses in `get_holdings`
- [ ] Per thesis:
  - return since its first lot, against VTI over the same days;
  - high close since entry and the % below it;
  - % above its stop;
  - days held;
  - `freshEarningsCrash` and `recentBigLoser`, and any earnings reaction since entry.
- [ ] A `flags` list, e.g. `earnings_crash_since_entry`, `recent_big_loser`, `near_stop` (within 5%), `lagging_vti` (10+ points).
- [ ] Tests, SPEC-agent, get_rules.

### T3: Protective exits get through the drawdown halt
- [ ] Planner: while halted, emit full exits of closed theses, whether stopped, overdue, stale or removed (and later trailing-stopped), with `purpose: "exit"`.
- [ ] Risk: let `purpose: "exit"` sells through the halt only for a position whose thesis is closed in the snapshot, and only up to the whole position. Not under the kill switch.
- [ ] A new ADR superseding ADR-012's freeze. SPEC-risk and SPEC-portfolio amendments.
- [ ] Tests. Staging check: latch a halt on paper and watch a stop sell go through.

### T4: Resume re-bases the drawdown peak
- [ ] `risk_state`: the index level at the last resume (an additive migration).
- [ ] After a resume, the halt is measured from max(that level, any new high since) at 15%, until the index regains the pre-halt peak; then from the all-time peak at 30%. `limits.ts` gets `reHaltPct: "15"`.
- [ ] The halt reason, `get_overview` and the halt email say which rule tripped.
- [ ] Tests. Staging check.

### T5: #35 trailing stop and profit target, switched off
- [ ] Schema: optional `trailingStopPct` (from the high close since entry) and `takeProfitPct` (an exit or a trim to a weight). Old documents stay valid.
- [ ] Thesis states: `trailing_stopped` and `took_profit`, with audit kinds routed. A trailing stop is a halt-proof exit (T3).
- [ ] A switch in code, off in production until Scott turns it on.

### T6: Judge T5 on the insider replay
- [ ] Replay variants `trailing-stop=N` and `take-profit=N`.
- [ ] Run them on the 2019–2026 insider rule. Write up beside the replay. Scott decides whether to switch either on.
