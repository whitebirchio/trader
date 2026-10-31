# Tasks: `foundation`

> Plan: [foundation-plan.md](foundation-plan.md) · Spec: [SPEC-foundation.md](../../SPEC-foundation.md)
> Verification shorthand: **gate** = `npm run typecheck && npm test` from the repo root.

## Phase 1: Repo and decisions

### T1: Repo skeleton
Create the npm-workspaces monorepo that mirrors Corpus, and push it to a new **private** `whitebirchio/trader`.
- **Acceptance:**
  - [x] Root `package.json` (workspaces `packages/*`, `apps/*`; scripts `typecheck`, `test`, `dev`, `deploy:staging`, `deploy:production`, `db:generate`), `tsconfig.base.json` (Corpus copy), `.gitignore` (Corpus copy), `.nvmrc` (22)
  - [x] `packages/core` (`@trader/core`) and `apps/engine` (`trader-engine`) each typecheck; core runs one placeholder vitest test
  - [x] `git init`, first commit on `main`, `gh repo create whitebirchio/trader --private --source . --push`
- **Verify:** gate passes on a fresh `npm ci`; `gh repo view whitebirchio/trader --json visibility` → `PRIVATE`
- **Depends on:** none
- **Files:** `package.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`, `packages/core/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`, `apps/engine/{package.json,tsconfig.json,src/index.ts}`
- **Scope:** M (many files, all boilerplate)

### T2: ADRs, CLAUDE.md, README
Record the decisions already made so no future session re-derives them.
- **Acceptance:**
  - [x] `docs/decisions/README.md` index + ADRs: 001 Workers + Neon hosting · 002 hexagonal core · 003 Claude owns strategy, code owns risk · 004 Claude via scheduled MCP routine, no server-side LLM · 005 paper = staging, one account per env · 006 branch-based deploys · 007 idempotent job runs · 008 append-only audit log · 009 money as `numeric` + `Big` · 010 wash sales are a cost, not a rule · 011 no broker order tools for Claude
  - [x] `CLAUDE.md`: commands, architecture, invariants, workflow (`/spec` → `/plan` → `/build`, `SPEC-<module>.md`, `tasks/`), boundaries from the spec
  - [x] `README.md`: what it is, the module map link, quickstart
- **Verify:** every ADR has Status/Date/Context/Decision/Alternatives/Consequences; the ADR list matches spec success criterion 7
- **Depends on:** T1
- **Files:** `docs/decisions/*.md`, `CLAUDE.md`, `README.md`
- **Scope:** M (docs only)

### Checkpoint A
- [x] Gate green · repo pushed (private) · Scott skims the ADR index

## Phase 2: Core

### T3: `parseConfig`
- **Acceptance:**
  - [x] Zod schema: `TRADING_ENV` ∈ {`staging`,`production`}, `DATABASE_URL` is a `postgres(ql)://` URL
  - [x] Returns `{ ok: true, config }` or `{ ok: false, missing, invalid }` with **names only**
  - [x] Test: no secret value appears in `JSON.stringify` of a failure result
- **Verify:** `npx vitest run config` (in `packages/core`); gate
- **Depends on:** T1 · **Files:** `src/config.ts`, `test/config.test.ts`, `src/index.ts` · **Scope:** S

### T4: `money` helpers
- **Acceptance:**
  - [x] Add `big.js` and `@types/big.js`; `src/money.ts` exports parse/format helpers plus arithmetic over decimal strings, with explicit rounding modes
  - [x] Tests: `0.1 + 0.2 === "0.3"`; fractional-share quantity math (9 dp) exact; rejects `NaN`/`Infinity`/non-numeric strings
- **Verify:** `npx vitest run money`; gate
- **Depends on:** T1 · **Files:** `src/money.ts`, `test/money.test.ts`, `package.json` · **Scope:** S

### T5: Schema, migrations, PGlite harness
- **Acceptance:**
  - [x] `src/db/schema.ts` defines `job_runs` (unique `(job, scheduled_for)`) and `audit_events` as in the spec; `src/db/client.ts` `Db` type; `drizzle.config.ts` with `casing: "snake_case"`
  - [x] Generated migration committed under `drizzle/`; `scripts/migrate.ts` applies migrations using `DATABASE_URL`
  - [x] `test/helpers.ts` `createTestDb()` applies all migrations to a fresh PGlite
  - [x] Test: a `numeric` value round-trips through PGlite as an exact string
- **Verify:** `npx vitest run db`; `npm run db:generate -w @trader/core` produces no diff; gate
- **Depends on:** T1, T4 · **Files:** `src/db/{schema,client}.ts`, `drizzle.config.ts`, `drizzle/*`, `scripts/migrate.ts`, `test/helpers.ts`, `test/db.test.ts` · **Scope:** M

### T6: Audit log (append-only)
- **Acceptance:**
  - [x] Custom migration adds a `BEFORE UPDATE OR DELETE` trigger on `audit_events` that raises
  - [x] `recordEvent(db, { actor, kind, subject?, payload, jobRunId? })` with a typed `AuditKind` union (`job.failed`, `system.config_invalid`, …)
  - [x] Tests: insert works; `UPDATE` raises; `DELETE` raises
- **Verify:** `npx vitest run audit`; gate
- **Depends on:** T5 · **Files:** `drizzle/<n>_audit_append_only.sql` (+ journal), `src/audit.ts`, `test/audit.test.ts` · **Scope:** S

### T7: Job runner + heartbeat
- **Acceptance:**
  - [x] `runJob(db, job, scheduledFor, fn)` claims the slot through `ON CONFLICT DO NOTHING` and records `succeeded`/`skipped`/`failed` with `finished_at`; on failure, also writes a `job.failed` audit event and never rethrows
  - [x] `heartbeat` job implementation (records `succeeded` with `{ env }` detail)
  - [x] Tests: success path; thrown error → `failed` row + audit event; same `(job, scheduledFor)` twice → `duplicate`, exactly one row
- **Verify:** `npx vitest run jobs`; gate
- **Depends on:** T5, T6 · **Files:** `src/jobs.ts`, `test/jobs.test.ts`, `src/index.ts` · **Scope:** S

### T8: `getHealth`
- **Acceptance:**
  - [x] `getHealth(db, env, now)` → `{ env, status: "healthy" | "unhealthy", lastHeartbeatAt, reason? }`, healthy only if the last `succeeded` heartbeat is ≤ 30 min old
  - [x] Tests: fresh, stale and never cases
- **Verify:** `npx vitest run health`; gate
- **Depends on:** T7 · **Files:** `src/health.ts`, `test/health.test.ts` · **Scope:** XS

### Checkpoint B
- [x] Gate green · every exported core function has a test · `db:generate` clean · commit + push (first staging-eligible push is still a no-op until T11)

## Phase 3: Deploy

### T9: Accounts, Neon branches, roles, secrets (human-in-the-loop)
Write each step into `docs/SETUP.md` as it's done. Steps marked *(Scott)* need a dashboard login.
- **Acceptance:**
  - [x] *(Scott)* Neon project `trader`: rename the default branch to `production` and create a `staging` child branch; copy both owner pooled URLs into a local `.env`
  - [x] Run `db:migrate` against both branches; run `packages/core/scripts/app-role.ts` via `scripts/set-db-secret.sh` (idempotent, rotates the password, and verifies by connecting as the role; `trader_app` gets `SELECT/INSERT/UPDATE/DELETE` on `job_runs` and `SELECT/INSERT` only on `audit_events`) on both
  - [x] *(Scott)* Cloudflare API token (Workers edit) and `npx wrangler login` locally
  - [x] Worker secret `DATABASE_URL` (app role) for `--env staging`
  - [x] …and for `--env production`. The Worker only exists after the first `main` deploy, so this happens in T12 (Scott runs `scripts/set-db-secret.sh production`).
  - [x] GitHub repo secrets through `gh secret set`: `CLOUDFLARE_API_TOKEN`, `STAGING_MIGRATE_URL`, `PRODUCTION_MIGRATE_URL`
- **Verify:** `gh secret list` shows all three; connecting as `trader_app`, `UPDATE audit_events …` is denied and `CREATE TABLE x()` is denied
- **Depends on:** T1 (T5 for the migrate step) · **Files:** `packages/core/scripts/app-role.ts`, `scripts/set-db-secret.sh`, `docs/SETUP.md`, `.env.example` · **Scope:** S (code) + manual

### T10: `apps/engine` Worker
- **Acceptance:**
  - [x] `wrangler.jsonc` with `env.staging`/`env.production` (`TRADING_ENV` var, cron `*/15 * * * *`, `observability.enabled`, `preview_urls: false`)
  - [x] `scheduled()`: `parseConfig` → if invalid, log names and return; else Neon Pool → `runJob` for each job mapped to `controller.cron` with `scheduledTime`; `ctx.waitUntil(pool.end())`
  - [x] `fetch()`: bad config → 503 JSON naming missing/invalid vars; `GET /healthz` → `getHealth` (200 if healthy, else 503); anything else → 404
- **Verify:** `npm run dev` with `.dev.vars` pointing at **Neon staging**: firing `__scheduled` twice with the same time produces one row (SC-6); `/healthz` returns 200; blanking `DATABASE_URL` → 503 naming it (SC-5)
- **Depends on:** T8, T9 · **Files:** `apps/engine/{wrangler.jsonc,src/index.ts,package.json}`, `apps/engine/.dev.vars.example` · **Scope:** S

### T11: CI workflow
- **Acceptance:**
  - [x] `build` job on every push (no `pull_request` trigger: PR branches are pushed anyway, so it would run twice): `npm ci`, typecheck, test (Node 22, npm cache)
  - [x] `deploy-staging` on `push` to a branch other than `main`: needs `build` → `db:migrate` with `STAGING_MIGRATE_URL` → `wrangler deploy --env staging`
  - [x] `deploy-production` on `push` to `main`: needs `build` → `db:migrate` with `PRODUCTION_MIGRATE_URL` → `wrangler deploy --env production`
  - [x] Separate deploy concurrency groups, `cancel-in-progress: false`
- **Verify:** push a feature branch → `build` + `deploy-staging` green, production untouched
- **Depends on:** T9, T10 · **Files:** `.github/workflows/ci.yml` · **Scope:** S

### T12: Go-live verification + SETUP.md polish
- **Acceptance:**
  - [x] SC-3: within 15 min of a feature-branch deploy, staging `/healthz` → 200 `"env":"staging"`
  - [x] SC-4: merge that branch to `main` → production `/healthz` → 200 `"env":"production"`
  - [x] SC-1/2/7 rechecked; `docs/SETUP.md` covers staging reset from production and Neon point-in-time restore
- **Verify:** `curl` both `/healthz` URLs; `job_runs` has heartbeat rows in both branches
- **Depends on:** T11 · **Files:** `docs/SETUP.md`, `tasks/todo.md` · **Scope:** XS

### Checkpoint C (foundation complete)
- [x] All 7 spec success criteria checked (2026-10-31)
- [x] Scott reviews (2026-10-31) · next: `SPEC-broker.md`
