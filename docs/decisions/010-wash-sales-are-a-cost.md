# ADR-010: Wash sales are a cost the strategy weighs, not a rule

## Status
Accepted

## Date
2026-10-31

## Context
The live account is taxable. A strategy that rebalances often will sometimes sell at a loss and rebuy the same security, or one substantially identical to it, within 30 days. That defers the loss under the wash-sale rule.

## Decision
`portfolio` and Claude's strategy treat wash-sale exposure as a cost when choosing trades. They get the data to see it (tax lots and the 30-day windows). `risk` has **no hard wash-sale block**.

## Alternatives Considered

### Hard guardrail (never trigger a wash sale)
- Rejected by Scott: it can force worse trades than the deferred loss costs.

## Consequences
- `broker` must sync tax lots (or enough fill history to rebuild them), and `agent` exposes them to Claude.
