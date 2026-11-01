# Tasks: move the platform to AWS

> Plan: [platform-aws-plan.md](platform-aws-plan.md) · Spec: [SPEC-platform-aws.md](../SPEC-platform-aws.md)
> **gate** = `npm run typecheck && npm test` (core + engine + infra). AWS CLI/CDK locally use `--profile whitebirch`.

## Phase 1: Build

### A1: infra workspace + `TraderCi`
- [x] `infra/` workspace (`trader-infra`): `aws-cdk-lib`, `constructs`, `aws-cdk` (CLI) as dev deps; `cdk.json`; `bin/trader.ts` defines `TraderCi`, `TraderStaging`, `TraderProduction` (env = the account from the profile, us-east-1)
- [x] `CiStack`: GitHub OIDC provider + `trader-github-deploy` role (trust: `repo:whitebirchio/trader:*`; permissions: `sts:AssumeRole` on `cdk-*` bootstrap roles only)
- [x] Assertion tests for the trust condition and permissions; `npm run synth`
- **Scope:** M

### A2: Lambda handler, secrets, mailer
- [x] **Deviation:** the Lambda code lives in a new `apps/lambda` package (`trader-lambda`), not `apps/engine`, because Worker globals and Node/AWS types conflict in one tsconfig. `apps/engine` is deleted at cutover. `src/handler.ts` + `src/index.ts`: scheduler event `{jobs, scheduledTime}` → `parseConfig` → `slotFor` → `runJob` per job (same order and deps as the Worker); Function URL `GET /healthz` → `getHealth`; anything else → 404; bad config → 503 naming the vars
- [x] `secrets.ts`: SSM `GetParametersByPath('/trader/<env>/')` → env-shaped object, cached per container
- [x] `ses-mailer.ts`: `Mailer` over SESv2 `SendEmail` (from `NOTIFY_FROM`, to `NOTIFY_TO`)
- [x] Vitest in `apps/engine` with mocked SDK clients: event mapping, slot, health 200/503, 404, secrets mapping, mailer request
- **Scope:** M

### A3: `EngineStack`
- [x] `NodejsFunction` (Node 22, arm64, 512 MB, 5 min, log retention 30 days, env: `TRADING_ENV`, `NOTIFY_FROM`, `NOTIFY_TO`, `SECRETS_PATH`)
- [x] `CfnSchedule` `cron(0/15 * * * ? *)` (America/New_York irrelevant; UTC), input with `<aws.scheduler.scheduled-time>`, retry policy, plus a scheduler role that can only invoke this function
- [x] Function URL (`AuthType NONE`); IAM: `ssm:GetParametersByPath` on `/trader/<env>/*` only; `ses:SendEmail` on the two identities with `ses:FromAddress` pinned
- [x] SES `EmailIdentity` for `whitebirch.io` (Easy DKIM) and the owner address; DKIM CNAMEs as stack outputs
- [x] SNS topic + email subscription; alarms: Lambda Errors ≥ 1 / 15 min; Invocations < 1 / 60 min (missing data = breaching)
- [x] Tags `app=trader`, `env=<env>`; assertion tests (one function, one schedule, URL auth, IAM scoping per env, alarms, staging vs production differ only in names, env and paths)
- **Note:** SES identities are account-level, so both stacks need them. The domain identity lives in staging's stack and production's references it by name, to avoid a duplicate-resource conflict. (Planning decision.)
- **Scope:** M

### A4: Scripts + docs
- [x] `set-db-secret.sh` / `set-alpaca-secret.sh` → SSM via `scripts/put-ssm-secret.sh` (value on stdin → `--cli-input-json`, never in argv). While `wrangler.jsonc` exists, `set-db-secret.sh` also updates the Worker secret, because it rotates the password
- [x] `npm run invoke -w trader-lambda -- --env <env> --jobs a,b` → `aws lambda invoke`, prints the result
- [ ] Draft the `docs/SETUP.md` AWS section (moved to A8, written against what actually got deployed)
- **Scope:** S

### Checkpoint A
- [ ] Gate green · `cdk synth` clean · `cdk diff --profile whitebirch` reviewed with Scott

## Phase 2: Staging

### A5: One-time setup (Scott, with commands from me)
- [x] `npx cdk bootstrap aws://<acct>/us-east-1 --profile whitebirch` (2026-11-01)
- [x] `npm run deploy:ci -w trader-infra -- --profile whitebirch --require-approval never` (the `!` shell has no TTY for the IAM prompt; the table was reviewed first)
- [ ] SSM: `scripts/set-db-secret.sh staging`, `scripts/set-alpaca-secret.sh staging`
- [ ] After the first staging deploy: SES identity email for the Gmail address (click), SNS subscription (click), 3 DKIM CNAMEs added in Cloudflare DNS (DNS-only)

### A6: CI
- [x] `ci.yml`: OIDC credentials, `cdk synth` in `build`, `cdk deploy TraderStaging` on non-`main`, `TraderProduction` on `main`; wrangler deploys kept for now (removed in A8)
- [x] GitHub **variable** `AWS_DEPLOY_ROLE_ARN` (an ARN, not a secret)

### A7: Staging cutover
- [ ] SC-2: `invoke` heartbeat / sync-broker / notify-urgent OK; Function URL `/healthz` 200 `"env":"staging"`
- [ ] SC-3: SES identities verified; `notify:test --env staging` arrives via SES
- [ ] SC-4: ≥ 1 tick with both platforms running; one `job_runs` row per `(job, slot)`; *(Scott)* `wrangler delete --env staging`
- [ ] SC-6: a forced failing staging invocation → error alarm email → recovery

## Phase 3: Production

### A8: Production + cleanup
- [ ] SSM for production (Scott runs the scripts); PR → merge → `TraderProduction` deployed by CI
- [ ] SC-5: health 200 `"env":"production"`; production `notify:test` arrives; overlap check; *(Scott)* `wrangler delete --env production`
- [x] Removed `apps/engine/` (Worker, wrangler config and types, the `wrangler` dep), the wrangler CI steps, and the dual-write in `set-db-secret.sh`; *(Scott)* delete the `CLOUDFLARE_API_TOKEN` secret and the Cloudflare API token
- [x] ADR-014 (supersedes ADR-001); ADR README; `CLAUDE.md` (environments, commands, architecture, testing, boundaries); `docs/SETUP.md` rewritten for AWS; supersession notes on SPEC-foundation and SPEC-notifications
- [ ] SC-7 after a week: Cost Explorer filtered by `app=trader` ≈ $0
