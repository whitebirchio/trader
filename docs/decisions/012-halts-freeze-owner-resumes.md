# ADR-012: Halts freeze everything; only the owner resumes

## Status
Accepted

## Date
2026-10-31

## Context
`risk` has two account-wide stops: a kill switch that Scott pulls by hand, and a drawdown halt that trips automatically when the flow-adjusted equity index is 20% below its peak. Each needed two decisions: what is still allowed while it's on, and who can turn it off. If sells were allowed, a halted strategy could exit falling positions. It could also sell near a market bottom and then sit in cash through the rebound, because buys are blocked.

## Decision
- **Freeze everything.** While the kill switch or the halt is on, every order is rejected, sells included. Neither ever sells anything itself. Holdings ride the market like buy-and-hold until a person looks.
- **Only the owner resumes.** `resume` and `setKillSwitch` take `actor: "owner"` as a literal type. CLI scripts run from Scott's machine, and any future MCP tool must be owner-authenticated. Claude can explain a halt but can't clear one.
- **The halt latches.** Recovering above the threshold doesn't clear it.
- The daily −5% pause is different. It blocks only buys, still allows sells, and clears itself the next trading day.

## Alternatives Considered

### Allow exits during the drawdown halt
- Rejected (Scott, 2026-10-31). At ~70% broad ETFs, a −20% drawdown is almost always market-wide, where holding has historically beaten selling. A single holding collapsing is already bounded by the 20% position cap.

### Auto-resume after a cooldown
- Rejected: a halt means "get a human", and resuming on a timer defeats that.

## Consequences
- The halted portfolio can't do worse than buy-and-hold of its own holdings, which is its benchmark's behaviour.
- Expiring satellite theses can't unwind while halted. They unwind after resume.
- The owner must notice a halt, so `notifications` (built next) emails on `risk.halted` and `risk.kill_switch_on`.
