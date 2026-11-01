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

npm run synth                             # cdk synth all stacks (CI runs it on every push)
npm run invoke -- --env staging --jobs heartbeat,sync-broker   # run the deployed Lambda now; don't wait for the 15-min tick
npm run broker:sync -w @trader/core -- --env staging --force   # one paper sync now, from the laptop (see docs/SETUP.md)
npm run notify:run -w @trader/core -- --env staging            # queue urgent emails now
```

Local AWS commands use the SSO profile `whitebirch` (`aws sso login --profile whitebirch` when it expires). **Verify on demand** (`invoke`, `broker:sync --force`, `notify:run`, `risk:check`) rather than waiting for scheduled ticks.

## Environments and deploys

| Env | CDK stack / Lambda | Neon branch | Alpaca | Deployed by |
|---|---|---|---|---|
| `staging` | `TraderStaging` / `trader-engine-staging` | `staging` | paper | push to any non-`main` branch |
| `production` | `TraderProduction` / `trader-engine-production` | `production` | **live money** | push/merge to `main` |

Everything runs on AWS in `us-east-1`, defined in CDK under `infra/` (ADR-014). CI deploys through a GitHub OIDC role, with no stored AWS keys. Secrets live in SSM under `/trader/<env>/`. Neon hosts the database, and Cloudflare only hosts whitebirch.io's DNS and inbound mail forwarding. `TRADING_ENV` is the only switch (ADR-005, ADR-006). **Merging to `main` ships to real money and applies migrations to production**, so try a change on a feature branch (paper) first. One-time account setup is in `docs/SETUP.md`.

## Architecture

**Hexagonal core + thin adapters** (ADR-002). All logic and its tests live in `packages/core` (`@trader/core`), which has no AWS, HTTP or MCP dependencies. External services (Alpaca, email) sit behind ports defined in core. `apps/lambda` is the engine's Lambda: EventBridge Scheduler ticks run `TICK_JOBS` through `runJob`, and its Function URL serves `/healthz`. It loads secrets from SSM and sends email through SES (`SesMailer`), and stays a validate → call core → respond shell. `infra/` holds the CDK stacks: `TraderCi` (the OIDC deploy role, deployed by the owner) and an `EngineStack` per environment.

- **Broker** (`src/broker/`, SPEC-broker): `BrokerAdapter` port + `AlpacaBroker` (host from `TRADING_ENV` only). `sync-broker` mirrors the account every 15 min during the session + 30 min after the close, rebuilds FIFO lots from fills, and persists `tradingAllowed` on `broker_account`. `submitOrder` is idempotent per intent key; no job calls it until `risk` exists.
- **Risk** (`src/risk/`, SPEC-risk): `evaluateOrders` is a pure rule pipeline over a `RiskSnapshot`. `riskGate` is the only path to `submitOrder`: it loads the snapshot, evaluates, and persists the snapshot and every decision. Limits are code (`limits.ts`, ask before changing). The kill switch and drawdown halt freeze everything and only the owner resumes them (ADR-012). `sync-broker` runs `checkDrawdown` after each sync.
- **Notifications** (`src/notifications/`, SPEC-notifications): every `AuditKind` is routed urgent, digest or ignore (`routing.ts`; adding a kind forces a decision). `notify-urgent` emails a tick's urgent events as one message; `notify-digest` sends once per trading day after the close. Both go through an idempotent outbox, and staging suppresses all but test emails.
- **Jobs** run through `runJob` (ADR-007): it claims `(job, scheduled_for)` first, so a redelivered cron is a no-op, and records every outcome in `job_runs`.
- **Audit log** (ADR-008): every state-changing action appends to `audit_events` with an actor (`system | claude | owner`). The table is append-only (trigger + role grants); correct mistakes by appending.
- **Config** is Zod-validated at every entry point. Invalid config fails closed: no jobs run, and routes return 503 naming the bad vars (never their values).
- **DB roles:** the owner role runs migrations (CI and laptop only). The Lambda connects as `trader_app`, which can't run DDL or modify append-only tables.

## Invariants

- **Money never touches a JS `number`** (ADR-009). Prices, cash and quantities are Postgres `numeric`, decimal strings in TS, and `Big` for arithmetic. Rounding is explicit.
- **snake_case casing:** every `drizzle(client, { casing: "snake_case" })` call AND `drizzle.config.ts`.
- **Timestamps are UTC `timestamptz`.** Trading-day logic uses Alpaca's market calendar.
- **Claude never gets broker order tools** (ADR-011). Its only path to a trade is `submit_strategy` → `risk`.
- **Expected outcomes are status unions, not throws.** Exceptions are for bugs and infrastructure failures.
- **Migrations are additive** (expand → contract) because `main` auto-applies them to production.

## Testing

Core tests live in `packages/core/test/` and run against **PGlite** with the real `drizzle/*.sql` migrations applied (`test/helpers.ts`). After editing `src/db/schema.ts`, run `npm run db:generate` or the tests will run against a stale schema. Every exported core function gets a test. `apps/lambda/test/` covers the handler (PGlite + core fakes) and the AWS adapters (`aws-sdk-client-mock`). `infra/test/` pins the stacks with CDK assertions (IAM scoping, schedules, alarms, staging = production modulo names).

## Boundaries

- **Always:** gate (`typecheck && test`) before committing; keep logic in core; write an audit event for every state change; note each new dependency and why in its commit message (no prior approval needed).
- **Ask first:** destructive migrations; changing `audit_events` or `job_runs` shape; changing CI deploy triggers; setting or rotating production secrets; resetting the staging Neon branch; AWS resources with a standing cost (NAT, RDS, provisioned concurrency, Secrets Manager); leaving the SES sandbox.
- **Never:** commit secrets or `.env*`; put long-lived AWS keys in GitHub; let one environment's role read another's SSM path; run DDL from the Lambda; update or delete audit events; let staging config reach a live account; give Claude order-placing tools; let a non-owner path change limits, clear a halt or turn off the kill switch.

## Specs & docs

New work follows the agent-skills workflow (`/spec` → `/plan` → `/build` → `/review` → `/ship`):

- **Module index:** `CAPABILITY-MAP.md` (stable module ids).
- **Spec:** `SPEC-<module-id>.md` at the repo root, a living document for that module.
- **Plan and tasks:** `tasks/<module>-plan.md` and `tasks/<module>-todo.md` (the broker module's are the original `tasks/plan.md` and `todo.md`); finished ones move to `tasks/done/`.
- **Architecture decisions:** ADRs in `docs/decisions/` (indexed in its README). Supersede, never edit, a decided ADR.
- **Ideas not yet specced:** GitHub Issues.
