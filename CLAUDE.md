# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trader is an autonomous US-equity portfolio. **Claude owns the strategy**: a scheduled Claude Code routine researches and publishes versioned, **conviction-first** strategies through Trader's MCP server. Research-backed theses (fundamentals, Congress / insider / 13F signals, news) can hold up to 100%, with a quant-ranked **systematic** sleeve for the rest. Idle money sits in VTI, never cash (ADR-013). It's a sandbox of risk capital; Scott's main money is invested elsewhere. **Deterministic code owns execution and risk**: it turns the active strategy into orders only inside owner-set guardrails Claude cannot change (ADR-003). Success means the live account beating VTI. The previous attempt lives in `~/src/trader-old`. It is reference only; don't copy its code.

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
npm run invoke -- --env production --jobs heartbeat,sync-broker   # run the deployed Lambda now; don't wait for the 15-min tick (idempotent per slot)
npm run broker:sync -w @trader/core -- --env paper --force       # sync the paper account into the local rehearsal database (see docs/SETUP.md)
npm run broker:smoke -w @trader/core -- --env paper              # $5 VTI order on paper through submitOrder: the order-path rehearsal (market hours)
npm run rebalance:plan -w @trader/core -- --env production --sync  # dry-run today's rebalance through risk: records and orders nothing
npm run risk:status -w @trader/core -- --env production         # read-only checks (also strategy:show, capital:status, scorecard:show): trader_readonly (SELECT only), no live key
npm run notify:run -w @trader/core -- --env production           # queue urgent emails now
npm run earnings:refresh -w @trader/core -- --env production --show AAPL   # fetch today's earnings calendar now (ALPHAVANTAGE_API_KEY in .env)
npm run invoke -- --env production --jobs check-filings                     # check SEC filings on every thesis and watchlist name now (runs if the last check was 55+ min ago)
npm run invoke -- --env production --jobs earnings-backfill                 # fetch the next few companies' earnings history now (within the daily Alpha Vantage budget)
npm run invoke -- --env production --jobs earnings-estimates                # refresh the next due name's analyst estimates now (weekly per name, 3 a day)
npm run invoke -- --env production --jobs check-routine                     # check today's research runs submitted a strategy (retries a missed one, then emails)
npm run routine:fire -w @trader/core -- --env production --routine 8:00 --dry-run   # start a research run now (8:00|12:00; drop --dry-run to fire; trades like any run)
```

Local AWS commands use the SSO profile `whitebirch` (`aws sso login --profile whitebirch` when it expires). **Verify on demand** rather than waiting for scheduled ticks. Before merge, verify locally: tests, the replay, the paper rehearsal (`--env paper`: the paper account and a local database in `packages/core/.cache/paper-db`), live API checks by script. After merge, verify in production with `invoke` and the read-only checks.

## Environments and deploys

Production is the only deployed environment (ADR-018). Paper is a laptop tool, not an environment.

| Env | CDK stack / Lambda | Neon branch | Alpaca | Deployed by |
|---|---|---|---|---|
| `production` | `TraderProduction` / `trader-engine-production` | `production` | **live money** | push/merge to `main` |
| `paper` (scripts only) | none | a local PGlite in `packages/core/.cache/paper-db` | paper | nothing: `--env paper` on the operator scripts |

Everything runs on AWS in `us-east-1`, defined in CDK under `infra/` (ADR-014). CI deploys through a GitHub OIDC role, with no stored AWS keys. Secrets live in SSM under `/trader/production/`. Neon hosts the database, and Cloudflare only hosts whitebirch.io's DNS and inbound mail forwarding. `TRADING_ENV` is the only switch: `production` is live, and `staging` now means "not live" (the replay and the paper scripts run as it). A push to any other branch builds, tests and checks its migrations on a temporary Neon branch of production (`scripts/ci-migrate-check.sh`), and deploys nothing. **Merging to `main` ships to real money and applies migrations to production**, so rehearse order-path changes on paper first. One-time account setup is in `docs/SETUP.md`.

## Architecture

**Hexagonal core + thin adapters** (ADR-002). All logic and its tests live in `packages/core` (`@trader/core`), which has no AWS, HTTP or MCP dependencies. External services (Alpaca, email) sit behind ports defined in core. `apps/lambda` is the engine's Lambda: EventBridge Scheduler ticks run `TICK_JOBS` through `runJob`, and its Function URL serves `/healthz`. It loads secrets from SSM and sends email through SES (`SesMailer`), and stays a validate → call core → respond shell. `infra/` holds the CDK stacks: `TraderCi` (the OIDC deploy role, deployed by the owner), `TraderCerts`, and `TraderProduction` (the `EngineStack`, which also owns the account-wide SES identities).

- **Broker** (`src/broker/`, SPEC-broker): `BrokerAdapter` port + `AlpacaBroker` (host from `TRADING_ENV` only). `sync-broker` mirrors the account every 15 min during the session + 30 min after the close, rebuilds FIFO lots from fills, and persists `tradingAllowed` on `broker_account`. `submitOrder` is idempotent per intent key; no job calls it until `risk` exists.
- **Risk** (`src/risk/`, SPEC-risk): `evaluateOrders` is a pure rule pipeline over a `RiskSnapshot`. `riskGate` is the only path to `submitOrder`: it loads the snapshot, evaluates, and persists the snapshot and every decision. Limits are code (`limits.ts`, ask before changing). The kill switch freezes everything; the drawdown halt freezes everything but whole exits of closed theses (and withdrawal sells), and a resume re-bases it to 15% below the level then, until the old peak is regained (ADR-012, ADR-017). Only the owner resumes either. `sync-broker` runs `checkDrawdown` after each sync.
- **Notifications** (`src/notifications/`, SPEC-notifications): every `AuditKind` is routed urgent, digest or ignore (`routing.ts`; adding a kind forces a decision). `notify-urgent` emails a tick's urgent events as one message; `notify-digest` sends once per trading day after the close; `notify-weekly` sends a letter on the week's last session (performance vs VTI, the track record, the week's decisions). All go through an idempotent outbox, and a not-live env (`staging`: the replay, the paper scripts) suppresses all but test emails.
- **Portfolio** (`src/portfolio/`, SPEC-portfolio): versioned strategy documents (`strategy.ts`, Zod-validated; version 0 = VTI) → thesis states (stop-loss, 30-day staleness, review date) → systematic ranking → dollar targets (conviction first; over-cap overflow down the ranking, then VTI) → a sells-first plan → `riskGate` → `submitOrder`. The `rebalance` job has its own schedule (every 15 min, 9:45–15:30 ET) and skips while orders are open. The thesis scorecard (`scorecard.ts`) is computed on read from strategy versions, thesis events and fills: each thesis's return vs the same dollars in VTI, served by `get_track_record` and the dashboard.
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

Core tests live in `packages/core/test/` and run against **PGlite** with the real `drizzle/*.sql` migrations applied (`test/helpers.ts`). After editing `src/db/schema.ts`, run `npm run db:generate` or the tests will run against a stale schema. Every exported core function gets a test. `apps/lambda/test/` covers the handler (PGlite + core fakes) and the AWS adapters (`aws-sdk-client-mock`). `infra/test/` pins the stacks with CDK assertions (IAM scoping, schedules, alarms, the retained SES identities).

## Boundaries

- **Always:** gate (`typecheck && test`) before committing; rehearse on paper (`broker:smoke`, `rebalance:run --env paper`) before merging a change to `src/broker/`, `src/risk/`, `src/portfolio/rebalance.ts` or the order intents; keep logic in core; write an audit event for every state change; note each new dependency and why in its commit message (no prior approval needed).
- **Ask first:** destructive migrations; changing `audit_events` or `job_runs` shape; changing CI deploy triggers; setting or rotating production secrets; AWS resources with a standing cost (NAT, RDS, provisioned concurrency, Secrets Manager); leaving the SES sandbox.
- **Never:** commit secrets or `.env*`; put long-lived AWS keys in GitHub; let one environment's role read another's SSM path; run DDL from the Lambda; update or delete audit events; let not-live (`staging`/paper) config reach a live account; give Claude order-placing tools; let a non-owner path change limits, clear a halt or turn off the kill switch.

## Specs & docs

New work follows the agent-skills workflow (`/spec` → `/plan` → `/build` → `/review` → `/ship`):

- **Module index:** `CAPABILITY-MAP.md` (stable module ids).
- **Spec:** `SPEC-<module-id>.md` at the repo root, a living document for that module.
- **Plan and tasks:** `tasks/<module>-plan.md` and `tasks/<module>-todo.md` (the broker module's are the original `tasks/plan.md` and `todo.md`); finished ones move to `tasks/done/`.
- **Architecture decisions:** ADRs in `docs/decisions/` (indexed in its README). Supersede, never edit, a decided ADR.
- **Ideas not yet specced:** GitHub Issues.
