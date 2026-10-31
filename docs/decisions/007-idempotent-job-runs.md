# ADR-007: Job runs are idempotent per scheduled time

## Status
Accepted

## Date
2026-10-31

## Context
Cron delivery is at-least-once in practice, and a trading job that runs twice could double an order. Every later job (`sync-broker`, `rebalance`) needs the same protection.

## Decision
`runJob` first claims a `(job, scheduled_for)` slot in `job_runs` with `INSERT … ON CONFLICT DO NOTHING`, using the cron's `scheduledTime`. Losing the race returns `duplicate` and does nothing. Every run records its outcome (`succeeded`, `skipped`, `failed`), and failures also write a `job.failed` audit event.

## Alternatives Considered

### Distributed lock / lease
- Rejected: needs expiry handling, and still doesn't stop a re-run of the same slot after the lock lapses.

## Consequences
- Idempotency at the job level doesn't replace idempotency at the order level. `broker` still uses client order ids.
- `job_runs` doubles as the heartbeat and health record.
