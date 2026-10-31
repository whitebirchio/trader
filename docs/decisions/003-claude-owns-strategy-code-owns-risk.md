# ADR-003: Claude owns the strategy; code owns execution and risk

## Status
Accepted

## Date
2026-10-31

## Context
Scott wants Claude to own the strategy completely: what to hold, in what proportions, and why, aimed at maximizing growth. The system also has to be safe to leave running with real money and no per-trade approval.

## Decision
Split authority:

- **Claude decides** the portfolio. It publishes versioned strategies made of a quant **core** sleeve (rules whose parameters Claude tunes) and an insight-driven **satellite** sleeve (theses, each with an expiry). The default split is 70/30.
- **Deterministic code decides whether and how to trade.** It turns the active strategy into orders only inside guardrails (position and sleeve caps, drawdown breakers, kill switch). Guardrail limits and the sleeve split are owner-set config that Claude cannot change.

## Alternatives Considered

### Claude places trades directly
- Rejected: the only safety would be the prompt. See ADR-011.

### Human approval per trade
- Rejected: Scott wants full autonomy. The guardrails and kill switch are the safety mechanism.

## Consequences
- The worst case of a bad strategy is bounded by the guardrails, not by model behaviour.
- When Claude has no insight, the core sleeve on tuned quant rules still gives a sensible portfolio.
