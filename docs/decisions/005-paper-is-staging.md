# ADR-005: Paper trading is the staging environment; one account per environment

## Status
Superseded by [ADR-018](018-production-is-the-only-deployed-environment.md) (2026-11-11).

## Date
2026-10-31

## Context
Scott wants it easy to run both paper and live, but treats paper "almost like a test environment": a place to try logic before it touches real money, not a result anyone tracks.

## Decision
Each deployment environment maps to exactly one Alpaca account:

| Environment | Worker | Neon branch | Alpaca |
|---|---|---|---|
| `staging` | `trader-engine-staging` | `staging` | paper |
| `production` | `trader-engine` | `production` | live |

`TRADING_ENV` is the only switch, and there is no `accounts` table. No config combination lets staging reach a live account (`broker` verifies that the key type matches the environment).

## Alternatives Considered

### One deployment managing paper and live accounts side by side
- Rejected: a code change would hit both at once, so paper couldn't act as a soak step before real money.

## Consequences
- Same code, different config. Promoting a change means merging it (ADR-006).
- Paper performance is not a product metric. The live account vs VTI is.
