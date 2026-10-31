# Implementation Plan: `foundation`

> Implements [SPEC-foundation.md](../SPEC-foundation.md) (approved 2026-10-31). Tasks are tracked in [todo.md](todo.md).
> **Status: Complete** (2026-10-31). Approved by Scott on 2026-10-31.

## Overview

Stand up the `whitebirchio/trader` monorepo with the `@trader/core` package (config, money, schema, audit log, job runner, health) and a thin `apps/engine` Worker, then deploy it to two environments. Feature branches go to staging and `main` goes to production, with CI migrating each Neon branch before deploying. When this plan is done, both environments record a heartbeat every 15 minutes and report it on `/healthz`. Nothing trades yet.

## Dependency graph

```
T1 repo skeleton ──┬── T2 ADRs + CLAUDE.md (docs; parallel-safe)
                   │
                   ├── T3 config ───────────────────────────────┐
                   ├── T4 money ──┐                             │
                   │              ▼                             │
                   └── T5 schema + PGlite harness ──┬── T6 audit log (append-only)
                                                    │       │
                                                    │       ▼
                                                    └── T7 job runner + heartbeat ── T8 health
                                                                                       │
          T9 accounts & DBs (Scott + CLI; can start any time after T1) ──┐              │
                                                                         ▼              ▼
                                                              T10 engine Worker (local, against Neon staging)
                                                                         │
                                                                         ▼
                                                              T11 CI: build → migrate → deploy
                                                                         │
                                                                         ▼
                                                              T12 go-live verification + SETUP.md polish
```

## Architecture decisions (made during planning)

- **Neon driver: `Pool` over WebSockets** (`drizzle-orm/neon-serverless`), not `neon-http`. Later modules (`portfolio` writing a rebalance plan plus its audit events) need real transactions, and Corpus already uses this pattern. The Pool is created once per Worker invocation and closed in `ctx.waitUntil(pool.end())`.
- **Append-only audit log is enforced at two layers.** A `BEFORE UPDATE OR DELETE` trigger raises an exception; it lives in a hand-written Drizzle migration (`drizzle-kit generate --custom`), so PGlite tests exercise it. The `trader_app` role also has `INSERT, SELECT` only on `audit_events`.
- **Two roles per Neon branch**, as in Fred. The owner role exists only as the CI migrate secret (and in Scott's local `.env`). `trader_app` is the Worker's `DATABASE_URL`. `app_role.sql` is idempotent and is re-run on both branches.
- **Wrangler environments** come from one `wrangler.jsonc` with `env.staging` and `env.production`. Each sets `TRADING_ENV`, its cron, and observability. `--env staging` produces the worker name `trader-engine-staging`.
- **CI branch routing:** `push` to `main` deploys production, and `push` to any other branch deploys staging. `pull_request` events only build, so a branch push isn't deployed twice. Each target has its own deploy `concurrency` group, with `cancel-in-progress: false`.
- **Job registry:** `apps/engine` maps each cron expression to its job names, and `@trader/core` owns the job implementations. In this module the registry is `*/15 * * * *` → `heartbeat`.
- **Node:** Node 22 in CI to match Corpus, with `engines: >=22`. Scott runs Node 24 locally, which also works.

## Task list

### Phase 1: Repo and decisions
- [ ] T1: Repo skeleton (workspaces, toolchain, private GitHub repo)
- [ ] T2: Backfill ADRs 001–011, `CLAUDE.md`, `README.md`

### Checkpoint A (after T1–T2)
- [ ] `npm ci && npm run typecheck && npm test` green; repo pushed; Scott skims ADR index

### Phase 2: Core (all PGlite-tested, no network)
- [ ] T3: `parseConfig`
- [ ] T4: `money` helpers
- [ ] T5: Schema, migrations, PGlite harness
- [ ] T6: Audit log (append-only)
- [ ] T7: Job runner + heartbeat job
- [ ] T8: `getHealth`

### Checkpoint B (after T3–T8)
- [ ] Every exported core function has a test; typecheck and tests green; `db:generate` produces no diff

### Phase 3: Deploy
- [ ] T9: Accounts, Neon branches, roles, secrets (human-in-the-loop)
- [ ] T10: `apps/engine` Worker, verified locally against Neon staging
- [ ] T11: CI workflow (build → migrate → deploy by branch)
- [ ] T12: Go-live verification on both environments + `docs/SETUP.md` final pass

### Checkpoint C (complete)
- [ ] All 7 spec success criteria verified and checked off in `todo.md`; Scott reviews before `broker` spec begins

## Parallelization

- T2 (docs) runs in parallel with T3–T8.
- T9 (account setup) is mostly Scott's clicks and can happen any time after T1. Starting it early keeps T10 from stalling.
- T3, T4 and T5 are independent of each other. T6 and T7 need T5.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Manual account setup (Neon, Cloudflare token, secrets) blocks deploy | Med | T9 is early and parallel, and its steps are written as a checklist in `docs/SETUP.md`. `gh` is already authenticated, so I create the repo and set secrets myself. |
| A migration from an abandoned feature branch leaves staging's schema ahead of `main` | Low | Staging is a Neon child of production, and resetting it from its parent restores it (ask-first, per the spec). Documented in SETUP.md. |
| Merging a bad migration to `main` hits production automatically | High (later) | Migrations are additive only, destructive changes are ask-first (spec Boundaries), and the branch runs on staging before merge. Neon point-in-time restore is the backstop, documented in SETUP.md. |
| Workers free plan allows 10 ms CPU per invocation | Low now, Med later | Heartbeat is I/O-bound. If `portfolio` math exceeds the limit, Workers Paid ($5/mo) is the fix. Flag it in the `portfolio` spec. |
| PGlite and Neon behave differently (trigger, `numeric` text format) | Low | T5 and T6 tests cover them, and T10 re-checks the trigger against real Neon by trying an `UPDATE` as `trader_app` and confirming it is denied. |
| Concurrent feature branches overwrite each other on staging | Low | Accepted with one developer; documented. |

## Open questions

- None blocking. T9 needs about 15 minutes of Scott's time in the Neon and Cloudflare dashboards. The exact steps go in `docs/SETUP.md` during T9.
