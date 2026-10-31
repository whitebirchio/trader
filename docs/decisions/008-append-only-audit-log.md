# ADR-008: An append-only audit log of every state-changing action

## Status
Accepted

## Date
2026-10-31

## Context
An autonomous system that moves money has to answer "what did you do, and why?" after the fact, for Scott, for email notifications and for Claude's own review of past decisions. That record is only trustworthy if nothing can rewrite it.

## Decision
`audit_events` (`at`, `actor` ∈ `system | claude | owner`, `kind`, `subject`, `payload`, `job_run_id`) gets a row for every state-changing action. It is append-only at two layers: a trigger rejects `UPDATE`/`DELETE`, and the Worker's `trader_app` role has only `SELECT, INSERT` on it.

## Alternatives Considered

### Workers Logs only
- Rejected: logs keep 3 days of retention, can't be queried from the app, and can't drive notifications.

## Consequences
- `notifications` and the MCP "history" tools read one source.
- Correcting a mistaken event means appending a new event, never editing.
