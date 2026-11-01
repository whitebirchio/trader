# Implementation Plan: move the platform to AWS

> Implements [SPEC-platform-aws.md](../SPEC-platform-aws.md) (approved 2026-10-31). Tasks are in [platform-aws-todo.md](platform-aws-todo.md). The `portfolio` spec and plan are parked on `portfolio/spec` until this lands.
> **Status: DRAFT — awaiting approval.**

## Overview

Add an `infra` CDK workspace and a Lambda entry point alongside the existing Worker, deploy staging to AWS while the Cloudflare Worker keeps running (safe, because job slots and the email outbox are claimed in the shared database), verify, and delete the Cloudflare Worker. Then the same for production. `@trader/core` doesn't change.

Account state on 2026-10-31: us-east-1 isn't CDK-bootstrapped, has no GitHub OIDC provider, has no stacks, and SES is in the sandbox with no identities.

## Dependency graph

```
A1 infra workspace + TraderCi stack ─────────────┐
A2 Lambda handler + SSM secrets + SesMailer ─────┼── A3 TraderStaging/Production stack (+ assertion tests)
                                                 │            │
A4 scripts → SSM, `invoke`, docs ────────────────┤            │
                                                 ▼            ▼
             A5 (you) cdk bootstrap + deploy TraderCi + SES/SNS confirmations + DKIM records
                                                 │
             A6 CI: synth on every push; OIDC deploys alongside wrangler
                                                 │
             A7 staging: deploy, verify, overlap check, delete the Cloudflare staging Worker
                                                 │
             A8 production: merge, verify, delete the Cloudflare production Worker, remove wrangler + token, ADR-014
```

## Architecture decisions (made during planning)

- **CDK v2 `aws-cdk-lib` only (no alpha modules).** Schedules use `CfnSchedule` from `aws-cdk-lib/aws-scheduler`, which is stable, so its JSON input can carry `<aws.scheduler.scheduled-time>`.
- **The GitHub OIDC role can only assume CDK's bootstrap roles** (`cdk-*-deploy-role`, `cdk-*-file-publishing-role`, `cdk-*-lookup-role`), which do the actual work. That's CDK's documented least-privilege pattern. Its trust is limited to `repo:whitebirchio/trader:*`.
- **Secrets are loaded at cold start** with `GetParametersByPath('/trader/<env>/', WithDecryption)` into the same env-shaped object `parseConfig` already validates. A missing parameter means exactly today's fail-closed 503, which names the parameter.
- **Engine tests:** `apps/engine` gets Vitest for the handler, mailer and secrets (with mocked AWS SDK clients). `infra` gets Vitest + `aws-cdk-lib/assertions`. Both join the workspace `test` script, so CI covers them.
- **During the overlap, CI deploys both** (wrangler and CDK) for the environment being migrated. Each Worker is deleted only after AWS has been claiming that environment's slots for at least one full tick, with `job_runs` checked for a single row per slot.
- **Deleting the Cloudflare Workers** (`wrangler delete`) is destructive and outward-facing, so you run it. I'll give the exact command once the overlap check passes.
- **`npm run invoke`** calls the deployed Lambda directly (`aws lambda invoke --profile whitebirch`) with a jobs payload. Staging is checked in seconds (the fast-verification rule).

## Task list

### Phase 1: Build (no AWS calls except synth/diff)
- [ ] A1: `infra` workspace + `TraderCi` stack
- [ ] A2: Lambda handler, SSM secrets loader, `SesMailer` (+ tests)
- [ ] A3: `EngineStack` (staging/production) + assertion tests
- [ ] A4: SSM secret scripts, `invoke`, docs draft

### Checkpoint A
- [ ] Gate green (core + engine + infra tests) · `cdk synth` clean · `cdk diff` against your account reviewed with you

### Phase 2: Stand up staging
- [ ] A5: (you) bootstrap + `TraderCi` + confirmations + DKIM CNAMEs in Cloudflare
- [ ] A6: CI with OIDC + synth + dual deploy
- [ ] A7: staging verified on AWS; Cloudflare staging Worker deleted

### Checkpoint B
- [ ] SC-2, SC-3, SC-4, SC-6 on staging

### Phase 3: Production and cleanup
- [ ] A8: production on AWS; Cloudflare production Worker deleted; wrangler and the token removed; ADR-014; SETUP rewritten

### Checkpoint C (complete)
- [ ] SC-1 to SC-6 · SC-7 (cost) after a week · next: revise `SPEC-portfolio.md` for AWS, then build `portfolio`

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Both platforms run a job in the same slot | High | They can't: the `(job, slot)` claim and the outbox claim are in the shared database (ADR-007). A7/A8 verify one `job_runs` row per slot before any deletion. |
| Scheduler's scheduled time differs from Cloudflare's for the same tick, so one slot looks like two | Med | Both are floored to the minute by `slotFor`, and both fire on :00/:15/:30/:45. The overlap check confirms it. If they diverge, delete the Cloudflare Worker and accept one doubled heartbeat; nothing trades yet in production. |
| A gap in production during cutover | Low | The Cloudflare Worker keeps running until AWS is confirmed. |
| An over-broad CI role | Med | OIDC trust is pinned to this repo; the role can only assume CDK bootstrap roles; assertion tests pin IAM. |
| SES sandbox or DKIM not verified when staging first sends | Low | Emails stay `pending` and retry with backoff. `notify:test` is checked after DKIM is verified. |
| Cold-start SSM call fails | Low | Fail closed (no jobs, an alarm); the next tick retries. |
| Forgotten Cloudflare resources keep running | Low | A8's checklist ends with both Workers deleted and `wrangler` removed from the repo. Only DNS and Email Routing remain. |

## Open questions

- None.
