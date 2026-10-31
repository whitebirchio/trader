# Implementation Plan: `risk`

> Implements [SPEC-risk.md](../SPEC-risk.md) (approved 2026-10-31). Tasks are in [risk-todo.md](risk-todo.md). It lives alongside the still-open `broker` plan ([plan.md](plan.md), with B9 waiting on Monday's session) instead of replacing it.
> **Status: DRAFT — awaiting approval.**

## Overview

Build the guardrail engine bottom-up. The pure pieces come first (limits, eligibility, the flow-adjusted index, the rule pipeline), all tested without I/O. Then the persisted state (kill switch, latched halt, decisions), the `riskGate` wrapper, and the drawdown check inside `sync-broker`. Owner scripts and staging verification come last. Production gets the migration and the drawdown check and still places no orders.

## Dependency graph

```
R1 limits + types + eligibility ──┐
R2 flow-adjusted index ───────────┼── R3 evaluateOrders (rule pipeline)
                                  │            │
R4 migration 0004 + state.ts ─────┴────────────┴── R5 riskGate + checkDrawdown in sync-broker
                                                             │
                                                   R6 owner scripts + docs
                                                             │
                                                   R7 staging verification → PR → production
```

R1, R2 and R4 are independent of each other.

## Architecture decisions (made during planning)

- **One snapshot type feeds the pure engine.** `RiskSnapshot` holds account equity and cash, holdings with sleeve and market value, the index state (peak, current, prior close), `tradingAllowed`, `syncedAt`, `riskState`, today's order count and buy notional, and `AssetFacts` per symbol. `riskGate` builds it; `evaluateOrders` never touches I/O. That makes every decision reproducible from the persisted snapshot.
- **Each gate run stores its snapshot** (jsonb on a `risk_gate_runs` row, which `risk_decisions` reference). An email about a clip or rejection can then show exactly what the engine saw. This adds a third table to the spec's two. It's insert-only and has no new behaviour.
- **`limits_version`** is a short hash of the serialized `limits.ts` object, stored with every decision, so a change to a limit is traceable to the decisions it affected.
- **Halt latching lives in `state.ts`**, with a conditional update (`WHERE halted = false`) so concurrent syncs trip and audit it once. That's the same race-safety pattern as the order transitions.
- **Asset facts:** `getAsset` gains `marginRequirementLong`. Price, 20-day average dollar volume and history length come from one `getDailyBars` call over 120 days for all buy symbols. Missing facts mean reject ("couldn't verify eligibility").
- **`dailyLossPause` transitions** (`risk.buys_paused` / `risk.buys_resumed`) are computed in `sync-broker`'s drawdown check, not at order time, so the email arrives when the threshold is crossed. The pause itself is still enforced at evaluation time from the live index.

## Task list

### Phase 1: Pure engine
- [ ] R1: `limits.ts`, domain types, eligibility checks (+ `marginRequirementLong` on assets)
- [ ] R2: Flow-adjusted equity index
- [ ] R3: `evaluateOrders` rule pipeline

### Checkpoint A
- [ ] Gate green · each rule has pass/clip/reject coverage · Scott skims the rejection-reason wording

### Phase 2: State, gate, sync hook
- [ ] R4: Migration 0004 + `state.ts` (kill switch, latched halt)
- [ ] R5: `riskGate` + `checkDrawdown` wired into `sync-broker`

### Checkpoint B
- [ ] Gate green · `db:generate` clean

### Phase 3: Operate and ship
- [ ] R6: `risk:status`, `risk:kill`, `risk:resume`, `risk:check` + docs
- [ ] R7: Staging verification (SC-2, SC-3, SC-4) → PR → production (SC-6)

### Checkpoint C (complete)
- [ ] All 6 success criteria verified · Scott reviews · next: `SPEC-notifications.md`

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Leveraged/inverse heuristic misses a fund | High | Two independent layers (margin requirement ≥ 50, name patterns), tested against real recorded assets. False positives are accepted by design. |
| Index distorted by an unrecognized cash-flow activity type | Med | Only `CSD`/`CSW`/`JNLC`/`JNLS` count as flows. Any other cash activity over 5% of equity is logged in the gate snapshot for review. Tests cover a deposit between snapshots. |
| The drawdown check in `sync-broker` throws and breaks the broker sync | Med | It runs after the sync's own writes, in its own try/catch, and records `job.failed`-style detail without undoing the sync. |
| Stale or missing data lets an order through | High | The `freshData` rule rejects everything if the last succeeded sync is over 20 minutes old. Missing asset facts mean reject. |
| Free-plan CPU with bars for many symbols | Low | One multi-symbol bars call per gate run. Gate runs are rare (rebalances), not every tick. |

## Open questions

- None.
