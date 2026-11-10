# Todo: sell on signals, and exits that get through a halt

> Plan: `tasks/exits-plan.md`. Gate for every task: `npm run typecheck && npm test`. Risk changes run on staging (paper) before they reach `main`.

### T1: Re-judge every thesis every run; six-week review for insider-led theses
- [x] `agent/routine-prompt.md`: the owner's direction of 2026-11-10; sell signals for current theses; review dates are a backstop.
- [x] `apps/mcp/src/instructions.ts`: the same, in brief.
- [x] After merge: update the routine through RemoteTrigger (the prompt is a copy). Done 2026-11-10 after #92 and #94 deployed; the stored prompt matches the file.
- [ ] The next routine runs re-judge each thesis in their summaries.

### T2: Signals for held theses in `get_holdings`
- [x] Per thesis:
  - return since its first lot, against VTI over the same days;
  - high close since entry and the % below it;
  - % above its stop;
  - days held;
  - `freshEarningsCrash` and `recentBigLoser`, and any earnings reaction since entry.
- [x] A `flags` list, e.g. `earnings_crash_since_entry`, `recent_big_loser`, `near_stop` (within 5%), `lagging_vti` (10+ points).
- [x] Tests, SPEC-agent, the MCP description (#93). Checked on staging: LLY and GOOGL reported.

### T3: Protective exits get through the drawdown halt
- [x] Planner: while halted, emit full exits of closed theses, whether stopped, overdue, stale or removed (and later trailing-stopped), with `purpose: "exit"`.
- [x] Risk: let `purpose: "exit"` sells through the halt only for a position whose thesis is closed in the snapshot, and only up to the whole position. Not under the kill switch.
- [x] A new ADR superseding ADR-012's freeze (ADR-017). SPEC-risk and SPEC-portfolio amendments.
- [x] Tests. Staging check (2026-11-10, #94): with a forced halt, nothing traded; GOOGL removed from the strategy sold whole, approved through the halt; the next step bought nothing. (No held thesis could hit its stop, so the removed-thesis path stood in for it; the stop path is covered by tests.)

### T4: Resume re-bases the drawdown peak
- [x] `risk_state.resumed_at`, the owner's last resume of a halt (additive migration 0022, owner-only by trigger).
- [x] After a resume, the halt is measured from max(that level, any new high since) at 15%, until the index regains the pre-halt peak; then from the all-time peak at 30%. `limits.ts` gets `reHaltPct: "15"`.
- [x] The halt reason, `get_overview` (`guardrails.haltRule`), `risk:status` and the dashboard say which rule is in force.
- [x] Tests. Staging check: after the resume, `risk:status` measured 0.20% since the resume under the 15% rule.

### T5: #35 trailing stop and profit target, switched off
- [x] Schema: optional `trailingStopPct` (from the high close since entry) and `takeProfitPct` (a whole exit; a trim to a weight is left until the replay shows a target is worth having). Old documents stay valid.
- [x] Thesis events `trailing_stopped` and `took_profit` (the state stays `stopped`, with a trigger), with audit kinds routed. Both are halt-proof exits (T3).
- [x] A switch in code (`EXIT_RULES`), off in production until Scott turns it on: submissions that set either field are refused.

### T6: Judge T5 on the insider replay
- [x] Replay variants `trailing-stop=N` and `take-profit=N`.
- [x] Run them on the 2019–2026 insider rule. Write up beside the replay: `docs/research/thesis-exits-replay-2026-11.md`. Every setting lost to the baseline.
- [ ] Scott decides whether to switch either on (recommendation: neither).
