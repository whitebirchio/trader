# Spec: `foundation`

> **ADR-018 (2026-11-11): staging is retired.** Production is the only deployed environment. Where this spec runs a command with `--env staging`, paper work now uses `--env paper` (the paper account on a local database), and checks of the deployed system use `--env production`. Records of what was checked on staging stay as written.

> **Hosting superseded:** the engine moved from Cloudflare Workers to AWS on 2026-11-01. See [SPEC-platform-aws.md](SPEC-platform-aws.md) and ADR-014. The rest of this spec (repo, core, jobs, audit log, money) still describes the system.

> **Status: Implemented** (2026-10-31). Approved by Scott on 2026-10-31; every success criterion verified on the live environments. Module 1 of 7 in [CAPABILITY-MAP.md](CAPABILITY-MAP.md). Depends on nothing.

## Objective

Give every later module a deployed, tested place to land, so that `broker`, `risk` and `portfolio` add logic rather than infrastructure. This module places **no trades** and talks to **no broker**.

When `foundation` is done:

- The repo `whitebirchio/trader` is a Corpus-style npm-workspaces monorepo: a hexagonal `@trader/core` package plus a thin `apps/engine` Cloudflare Worker.
- **Two environments run the same code:**

  | Environment | Worker | Neon branch | Alpaca account (wired in `broker`) | Deployed by |
  |---|---|---|---|---|
  | `staging` | `trader-engine-staging` | `staging` (child of `production`) | paper | a push to any branch other than `main` |
  | `production` | `trader-engine` | `production` | live | a push or merge to `main` |

  The environment is the only switch between paper and live, and no config combination can point staging at real money. **Workflow:** work on a feature branch, which runs against paper on staging; merging to `main` ships it to live. Staging holds whichever branch was pushed most recently. That's fine with one developer.
- A cron-driven **job runner** executes named jobs idempotently and records each run. The first job is a heartbeat; later modules register real jobs (`sync-broker`, `rebalance`, …).
- An **append-only audit log** records every state-changing action, with an actor (`system`, `claude` or `owner`). `notifications` will read it later, and so will Claude's "what did you do?" tools.
- `GET /healthz` tells an uptime check whether the engine is alive.
- `CLAUDE.md`, the README and the first ADRs record the decisions already made, so future sessions don't re-derive them.

**User:** Scott, as operator, plus future agent sessions building the next modules.

## Tech Stack

The versions match `~/src/corpus` as of 2026-10-31. More dependencies are welcome where they earn their place (Scott, 2026-10-31).

| Concern | Choice |
|---|---|
| Language | TypeScript `^6.0.3`, strict, ESM (`tsconfig.base.json` copied from Corpus) |
| Runtime | Cloudflare Workers (`nodejs_compat`), Node 22 locally and in CI |
| Database | Neon Postgres via `@neondatabase/serverless ^1.1.0`; Drizzle ORM `^0.45.2` with drizzle-kit `^0.31.10`; `casing: "snake_case"` everywhere |
| Validation | Zod `^4.4.3` (env/config and every external input) |
| Money | `big.js ^7` (+ `@types/big.js`); see the money invariant below |
| Tests | Vitest `^4.1.9` against PGlite `^0.5.x` with the real migrations applied |
| Deploy | wrangler `^4.x`; GitHub Actions + `cloudflare/wrangler-action@v3` |
| Cost | $0/mo: Workers free plan (cron triggers included), Neon free tier (one project, two branches) |

## Commands

```sh
npm ci
npm run typecheck                         # whole workspace (what CI runs)
npm test                                  # whole workspace (core vitest against PGlite)
npm run typecheck && npm test             # run before every commit — mirrors CI

npm run test:watch -w @trader/core        # inner loop
npm run db:generate -w @trader/core       # after editing src/db/schema.ts
npm run db:migrate -w @trader/core        # applies to $DATABASE_URL (owner role); CI runs this per env before deploying

npm run dev                               # wrangler dev --test-scheduled on :8787 (needs apps/engine/.dev.vars)
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"   # fire the cron locally
curl http://localhost:8787/healthz

npm run deploy:staging                    # wrangler deploy --env staging (CI does this on feature-branch pushes)
npm run deploy:production                 # wrangler deploy --env production (CI does this on main; manual use is break-glass)
```

### CI (`.github/workflows/ci.yml`)

| Trigger | Jobs |
|---|---|
| Every push and PR | `build`: `npm ci` → `typecheck` → `test` |
| Push to a branch other than `main` | `build` → migrate the `staging` branch → deploy `--env staging` |
| Push to `main` | `build` → migrate the `production` branch → deploy `--env production` |

Migrations run in CI, before the Worker deploys, so new code never meets an old schema. Each deploy target has its own `concurrency` group, and deploys are queued rather than cancelled. Secrets are **repo-level** (`CLOUDFLARE_API_TOKEN`, `STAGING_MIGRATE_URL`, `PRODUCTION_MIGRATE_URL`, the last two being owner-role URLs). Nothing depends on GitHub Environments, so this works the same in a public or private repo.

## Project Structure

```
CAPABILITY-MAP.md           → module index (approved)
SPEC-<module>.md            → one living spec per module
CLAUDE.md                   → agent rules, commands, invariants (Corpus-style)
README.md                   → what this is, how to run it
packages/core/              → @trader/core: all domain logic; no Worker/HTTP deps
  src/db/schema.ts          → Drizzle schema (source of truth for the data model)
  src/db/client.ts          → driver-agnostic `Db` type
  src/config.ts             → Zod env schema + `parseConfig()`
  src/money.ts              → Big-based helpers + Drizzle numeric↔string conventions
  src/audit.ts              → `recordEvent()`, event kinds
  src/jobs.ts               → job registry + `runJob()` (idempotent, recorded)
  src/health.ts             → `getHealth()`
  src/index.ts              → public exports
  drizzle/                  → generated SQL migrations (committed)
  scripts/migrate.ts        → applies migrations with the owner role
  scripts/sql/app_role.sql  → least-privilege role for the Worker (Fred pattern)
  test/                     → vitest + PGlite helpers
apps/engine/                → Cloudflare Worker: scheduled() + fetch(); thin shell over core
  src/index.ts
  wrangler.jsonc            → env.staging / env.production, cron triggers, observability on
docs/decisions/             → ADRs (README.md index)
docs/SETUP.md               → one-time account setup (GitHub, Cloudflare, Neon, secrets)
tasks/plan.md, tasks/todo.md
.github/workflows/ci.yml
```

`apps/mcp-server` (`agent`) and `apps/web` (`dashboard`) arrive in later modules. Broker and email HTTP clients will sit behind ports defined in core (as in Corpus ADR-004).

### Data model introduced here

- `job_runs`: `id`, `job` (text), `scheduled_for` (timestamptz, from the cron's `scheduledTime`), `started_at`, `finished_at`, `status` (`running | succeeded | failed | skipped`), `error` (text, nullable), `detail` (jsonb). **Unique on `(job, scheduled_for)`**, so a duplicate cron delivery is a recorded no-op rather than a second run.
- `audit_events`: `id`, `at` (timestamptz), `actor` (`system | claude | owner`), `kind` (text, from a typed union in `audit.ts`), `subject` (text, nullable, e.g. a ticker or order id), `payload` (jsonb), `job_run_id` (nullable FK). **Append-only**: a trigger rejects `UPDATE`/`DELETE` (testable in PGlite), and the app role has no `UPDATE`/`DELETE` grant (defence in depth, as in Fred).

No account table. There is one account per environment, so the account comes from the environment's config.

### Invariants (copied into `CLAUDE.md`)

- **Money never touches a JS `number`.** Prices, cash and share quantities are Postgres `numeric`, carried as decimal strings, and computed with `Big`. Conversion happens only at the edges: the DB, broker payloads and display. This matters because fractional shares and notional orders make float drift real.
- **snake_case casing** on every `drizzle(...)` call and in `drizzle.config.ts` (as in Corpus).
- **Timestamps are UTC `timestamptz`.** Trading-day logic (America/New_York) arrives with `broker`, and uses Alpaca's market calendar instead of hand-rolled holiday math.

### Config (validated at the edge of every Worker entry point)

| Var | Kind | Notes |
|---|---|---|
| `TRADING_ENV` | wrangler var | `staging` or `production`; set per env in `wrangler.jsonc`, never a secret |
| `DATABASE_URL` | Worker secret | Neon pooled URL for the **app role** on that env's branch |

`parseConfig(env)` returns `{ ok: true, config } | { ok: false, missing: string[], invalid: string[] }`. It reports **names only, never values**. Later modules extend the schema (Alpaca keys, email); `broker` adds the check that the key type matches `TRADING_ENV`.

## Code Style

Match Corpus: double quotes, semicolons, trailing commas, ~100 columns, `.js` suffixes on relative imports, `import type` for types, and `noUncheckedIndexedAccess` handled explicitly. Expected outcomes are returned as structured status unions instead of being thrown (Corpus ADR-020); exceptions are for bugs and infrastructure failures. Comments explain *why* and cite ADRs as `ADR-NNN`.

```ts
export type JobOutcome =
  | { status: "succeeded"; detail?: Record<string, unknown> }
  | { status: "skipped"; reason: string }
  | { status: "duplicate" };

export async function runJob(
  db: Db,
  job: JobName,
  scheduledFor: Date,
  fn: (run: JobRunCtx) => Promise<Exclude<JobOutcome, { status: "duplicate" }>>,
): Promise<JobOutcome> {
  // Claim the (job, scheduled_for) slot first: a redelivered cron event loses
  // the insert race and becomes a no-op instead of a second run (ADR-007).
  const claimed = await db
    .insert(jobRuns)
    .values({ job, scheduledFor, status: "running" })
    .onConflictDoNothing({ target: [jobRuns.job, jobRuns.scheduledFor] })
    .returning({ id: jobRuns.id });
  const run = claimed[0];
  if (!run) return { status: "duplicate" };
  // ...execute fn, then record succeeded/skipped/failed with finished_at
}
```

Naming: files are kebab-case; tables are plural snake_case; job names (`heartbeat`, `sync-broker`) and audit kinds (`job.failed`, `order.submitted`) are kebab/dotted string-literal unions.

## Testing Strategy

- **Where:** `packages/core/test/*.test.ts`. The Worker stays thin enough to need no tests of its own; anything worth testing moves into core.
- **How:** each test file gets a fresh PGlite with all `drizzle/*.sql` migrations applied (Corpus `createTestDb()` pattern), so tests run against the real schema.
- **Covered in this module:**
  - `parseConfig`: accepts valid input; reports missing and invalid names; never echoes a secret value.
  - `runJob`: a success records `succeeded` with timestamps; a thrown error records `failed` with its message and rethrows nothing to the cron; a duplicate `(job, scheduled_for)` returns `duplicate` and leaves exactly one row.
  - `recordEvent`: writes a row; an `UPDATE` or `DELETE` on `audit_events` raises.
  - `getHealth(db, now)`: healthy within 30 min of the last succeeded heartbeat; unhealthy (with the reason) after that or when there has never been one.
  - `money`: `numeric` values round-trip through the DB as exact strings, and the arithmetic helpers don't drift (e.g. `0.1 + 0.2 === "0.3"`).
- **Not here:** coverage thresholds. The bar is "every exported core function has a test", and `agent-skills:constraints` can formalise it later if wanted.

## Boundaries

- **Always:** run `npm run typecheck && npm test` before every commit; put logic in `@trader/core` and keep Worker handlers to a validate → call core → respond shell; validate config and external input with Zod; write an audit event for every state-changing action; fail closed (bad config means no jobs run, and `/healthz` and every other route return 503 naming the missing vars); keep migrations additive (expand → contract), because merging to `main` applies them to production automatically; note each new dependency and why in its commit message.
- **Ask first:** any destructive migration (drop, rename, or a type change on a column holding data); changing the `audit_events` or `job_runs` shape after first deploy; changing the deploy triggers in CI; anything that sets or rotates production secrets; resetting the staging Neon branch from production.
- **Never:** commit secrets, `.env*` or `.dev.vars*`; let the Worker run DDL (the app role can't anyway); `UPDATE` or `DELETE` audit events; make it possible for `staging` config to reach a live account; push directly to `main` without `build` passing; use a JS `number` for money; copy code from `~/src/trader-old`.

## Success Criteria

1. A fresh clone runs `npm ci && npm run typecheck && npm test` green, and CI runs the same on every push and PR.
2. Migrations apply cleanly to PGlite (tests) and, from CI, to the Neon `staging` and `production` branches before each deploy. The Worker connects as the least-privilege app role, which cannot `UPDATE`/`DELETE` `audit_events` or run DDL.
3. Pushing a feature branch deploys `trader-engine-staging`. Within 15 minutes it writes a `succeeded` `heartbeat` row to `job_runs`, and `GET /healthz` returns `200 {"env":"staging","status":"healthy","lastHeartbeatAt":"…"}`.
4. Merging to `main` deploys `trader-engine` with the same heartbeat and health behaviour, reporting `"env":"production"`.
5. Deploying with `DATABASE_URL` unset makes the Worker return `503` naming `DATABASE_URL` (not its value), and its cron logs the config error and runs nothing.
6. Firing the same scheduled time twice (`__scheduled` locally) produces one `job_runs` row.
7. `CLAUDE.md`, `README.md`, `docs/SETUP.md` and the ADR index exist. The ADRs cover: Workers + Neon hosting; the hexagonal core; Claude owns strategy while code owns risk; Claude via scheduled MCP routine with no server-side LLM; paper as staging with one account per environment; branch-based deploys (feature → staging, `main` → production); the append-only audit log; idempotent job runs; money as `numeric` + `Big`; wash sales as a cost rather than a rule; no broker order tools for Claude.

## Verification (2026-10-31)

| # | Criterion | Evidence |
|---|---|---|
| 1 | Fresh clone is green | `git clone` of `main` @ `ed4e532` → `npm ci`, typecheck, 35/35 tests |
| 2 | Migrations + least-privilege role | CI migrated both branches; `app-role.ts`, connected as `trader_app`, was refused UPDATE/DELETE on `audit_events` and CREATE TABLE on both branches |
| 3 | Staging heartbeat + health | Cloudflare cron slot 13:45:00Z `succeeded`; `/healthz` 200 `"env":"staging"` |
| 4 | Production heartbeat + health | PR #1 merged → CI deploy; slot 14:00:00Z `succeeded`; `/healthz` 200 `"env":"production"` |
| 5 | Fail closed | Staging before its secret: 503 `{"missing":["DATABASE_URL"]}`; production likewise until `set-db-secret.sh` ran |
| 6 | Idempotent slot | Local `__scheduled` twice in one minute → `succeeded`, then `duplicate` |
| 7 | Docs + ADRs | `CLAUDE.md`, `README.md`, `docs/SETUP.md`, ADRs 001–011 |

**Deviations from the spec:** the role setup is `scripts/app-role.ts` + `scripts/set-db-secret.sh` rather than a hand-run `app_role.sql`; the cron slot is floored to the minute (`slotFor`); CI has no `pull_request` trigger. Each is explained in the code or commit that made it.

## Resolved Questions (2026-10-31)

1. **Production promotion:** automatic. A push or merge to `main` deploys production, and feature branches deploy staging.
2. **Money arithmetic:** `numeric` + `big.js` approved. Dependencies that earn their place need no prior approval.
3. **Repo:** `whitebirchio/trader`, **private**. Make it public only if a specific need comes up. CI uses repo-level secrets, so it needs no GitHub Environments, which the org's Free plan limits to public repos.
4. **Neon:** one `trader` project with `production` and `staging` branches.
