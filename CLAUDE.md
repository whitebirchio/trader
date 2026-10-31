# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trader is an autonomous US-equity portfolio. **Claude owns the strategy**: a scheduled Claude Code routine researches and publishes versioned strategies (a quant **core** sleeve with Claude-tuned parameters, plus an insight-driven **satellite** sleeve; 70/30 by default) through Trader's MCP server. **Deterministic code owns execution and risk**: it turns the active strategy into orders only inside owner-set guardrails Claude cannot change (ADR-003). Success means the live account beating VTI. The previous attempt lives in `~/src/trader-old`. It is reference only; don't copy its code.

Modules, their dependencies and build order are in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Each module has a living `SPEC-<module>.md` at the repo root.

## Commands

Run from the repo root unless noted.

```sh
npm run typecheck && npm test             # run before every commit — mirrors CI
npm run test:watch -w @trader/core        # inner loop
npx vitest run jobs                       # (in packages/core) only files matching "jobs"

npm run db:generate -w @trader/core       # after editing src/db/schema.ts — tests use the generated SQL
npm run db:migrate -w @trader/core        # applies to $DATABASE_URL (owner role); CI does this before each deploy

npm run dev                               # wrangler dev --test-scheduled on :8787 (needs apps/engine/.dev.vars)
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"   # fire the cron locally
curl http://localhost:8787/healthz
```

After editing `apps/engine/wrangler.jsonc`, run `npm run cf-typegen -w trader-engine` to regenerate `worker-configuration.d.ts`.

## Environments and deploys

| Env | Worker | Neon branch | Alpaca | Deployed by |
|---|---|---|---|---|
| `staging` | `trader-engine-staging` | `staging` | paper | push to any non-`main` branch |
| `production` | `trader-engine` | `production` | **live money** | push/merge to `main` |

`TRADING_ENV` is the only switch (ADR-005, ADR-006). **Merging to `main` ships to real money and applies migrations to production**, so try a change on a feature branch (paper) first. One-time account setup is in `docs/SETUP.md`.

## Architecture

**Hexagonal core + thin adapters** (ADR-002). All logic and its tests live in `packages/core` (`@trader/core`), which has no Worker, HTTP or MCP dependencies. External services (Alpaca, email) sit behind ports defined in core. `apps/engine` is a Cloudflare Worker whose `scheduled()` maps cron expressions to jobs and whose `fetch()` serves `/healthz`. Both stay a validate → call core → respond shell.

- **Jobs** run through `runJob` (ADR-007): it claims `(job, scheduled_for)` first, so a redelivered cron is a no-op, and records every outcome in `job_runs`.
- **Audit log** (ADR-008): every state-changing action appends to `audit_events` with an actor (`system | claude | owner`). The table is append-only (trigger + role grants); correct mistakes by appending.
- **Config** is Zod-validated at every entry point. Invalid config fails closed: no jobs run, and routes return 503 naming the bad vars (never their values).
- **DB roles:** the owner role runs migrations (CI and laptop only). The Worker connects as `trader_app`, which can't run DDL or modify audit events.

## Invariants

- **Money never touches a JS `number`** (ADR-009). Prices, cash and quantities are Postgres `numeric`, decimal strings in TS, and `Big` for arithmetic. Rounding is explicit.
- **snake_case casing:** every `drizzle(client, { casing: "snake_case" })` call AND `drizzle.config.ts`.
- **Timestamps are UTC `timestamptz`.** Trading-day logic uses Alpaca's market calendar.
- **Claude never gets broker order tools** (ADR-011). Its only path to a trade is `submit_strategy` → `risk`.
- **Expected outcomes are status unions, not throws.** Exceptions are for bugs and infrastructure failures.
- **Migrations are additive** (expand → contract) because `main` auto-applies them to production.

## Testing

Tests live in `packages/core/test/` and run against **PGlite** with the real `drizzle/*.sql` migrations applied (`test/helpers.ts`). After editing `src/db/schema.ts`, run `npm run db:generate` or the tests will run against a stale schema. Every exported core function gets a test.

## Boundaries

- **Always:** gate (`typecheck && test`) before committing; keep logic in core; write an audit event for every state change; note each new dependency and why in its commit message (no prior approval needed).
- **Ask first:** destructive migrations; changing `audit_events` or `job_runs` shape; changing CI deploy triggers; setting or rotating production secrets; resetting the staging Neon branch.
- **Never:** commit secrets, `.env*` or `.dev.vars*`; run DDL from the Worker; update or delete audit events; let staging config reach a live account; give Claude order-placing tools.

## Specs & docs

New work follows the agent-skills workflow (`/spec` → `/plan` → `/build` → `/review` → `/ship`):

- **Module index:** `CAPABILITY-MAP.md` (stable module ids).
- **Spec:** `SPEC-<module-id>.md` at the repo root, a living document for that module.
- **Plan and tasks:** `tasks/plan.md` and `tasks/todo.md` for the module in progress.
- **Architecture decisions:** ADRs in `docs/decisions/` (indexed in its README). Supersede, never edit, a decided ADR.
- **Ideas not yet specced:** GitHub Issues.
