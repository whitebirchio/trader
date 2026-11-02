# ADR-015: Owner capital flows are first-class; withdrawals are strategy-funded requests

## Status
Accepted

## Date
2026-11-01

## Context
Scott wants to deposit and withdraw at will without disturbing Trader. Three earlier decisions get in the way. Flows were matched to snapshots by booking date, which Alpaca sets a day either side of the real instant, so a large flow could latch a false drawdown halt. ADR-013 keeps no idle cash, so there's nothing to withdraw, and anything Scott sells by hand is bought back on the next step. ADR-012 freezes all orders during a halt, so Scott couldn't take money out of a halted account. The dashboard is read-only.

## Decision
- **A capital ledger** (`capital_flows`, timed by instant) is the single source of external flows for the risk index, the benchmark and every surface.
- **Withdrawals are owner requests** with a lifecycle (requested → planning → funding → settling → ready → withdrawn | cancelled). The ACH itself stays in Alpaca.
- **Claude chooses where a withdrawal comes from** by authoring the next strategy version for the smaller account. No new write tool. A deterministic fallback (keep thesis dollars, trim VTI and systematic first) runs if Claude hasn't decided by the deadline or Scott asks to fund now.
- **Refines ADR-013:** cash may sit idle only while it's reserved for an open withdrawal. Deposits are invested immediately under the current strategy.
- **Refines ADR-012:** owner withdrawal sells pass the drawdown halt, bounded by the outstanding amount. The kill switch stays absolute.
- **The dashboard gets one write path:** `INSERT` on an append-only `capital_commands` table, processed and audited by the engine. No broker keys, no UPDATE or DELETE.

## Alternatives Considered

### Withdraw purely in Alpaca
- Rejected: with no cash buffer there's nothing withdrawable, and a manual sale is undone by the next rebalance step.

### A cash-reserve flag, sold pro rata
- Rejected: it bolts a special case onto targets and gives Claude no say in what gets sold.

### A separate "funding plan" document with its own Claude tool
- Rejected: weights are a share of equity, so the honest way to say where money comes from is a re-weighted strategy. A second document type would conflict with the active strategy on the next rebalance.

### A standing cash buffer
- Rejected: idle money costs return every day to save a step that happens rarely (ADR-013).

## Consequences
- A withdrawal takes about one to two trading days (decision, sells, settlement), or less with *Fund now*.
- The dashboard is no longer strictly read-only. A compromised session could force sells and hold cash, but can't move money out. Every command emails Scott.
- Thesis staleness is only reset by Claude, never by a system-authored fallback version.
