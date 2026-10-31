# ADR-009: Money is `numeric` in Postgres and `Big` in code, never a JS `number`

## Status
Accepted

## Date
2026-10-31

## Context
With $1k starting capital, every order is fractional or notional (e.g. 0.137452189 shares). Floating-point drift would make reconciliation against the broker wrong in exactly the places the guardrails measure.

## Decision
Prices, cash and quantities are Postgres `numeric`, carried as decimal strings, and computed with `big.js`. Conversion to `number` happens only for display. Rounding modes are explicit at each boundary (e.g. Alpaca's 9-decimal quantities, 2-decimal notional).

## Alternatives Considered

### Integer cents
- Rejected: doesn't cover sub-cent prices or fractional quantities.

### `decimal.js`
- Rejected: larger, and its extra features (trig, arbitrary precision config) aren't needed.

## Consequences
- The rule is listed in `CLAUDE.md` invariants, and every money helper is tested for exactness.
